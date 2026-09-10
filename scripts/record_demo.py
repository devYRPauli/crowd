"""Record the real headed Crowd demo, including actual waits and measured results.

Run with an ephemeral dependency, without changing the project's environment:
  uv run --no-project --with playwright --python 3.12 scripts/record_demo.py
Playwright's video encoder must be installed once with:
  uv run --no-project --with playwright --python 3.12 -m playwright install ffmpeg
The default Chrome channel uses installed Chrome in an isolated browser profile.
No response bodies, brief text, headers, credentials, or image bytes are logged.
"""

import argparse
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


def arguments():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000/?demo=1")
    parser.add_argument("--output", type=Path, default=Path("out/demo_backup.webm"))
    parser.add_argument("--channel", default="chrome", help="Installed browser channel; use chromium for a Playwright installation")
    parser.add_argument("--timeout-s", type=float, default=360)
    parser.add_argument("--play-s", type=float, default=8, help="Recorded wall seconds of 10x measured playback")
    parser.add_argument("--chips", nargs="*", choices=["one", "waves", "third"], default=["one", "waves", "third"])
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def demo_url(base):
    parts = urlsplit(base)
    query = dict(parse_qsl(parts.query))
    query["demo"] = "1"
    return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", urlencode(query), parts.fragment))


async def record(args):
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise RuntimeError("Playwright is unavailable. Run with: uv run --no-project --with playwright --python 3.12 scripts/record_demo.py") from exc
    if args.timeout_s <= 0 or args.play_s < 0:
        raise ValueError("timeout-s must be positive and play-s nonnegative")
    if args.output.exists() and not args.overwrite:
        raise FileExistsError(f"Recording exists: {args.output}; choose a new path or pass --overwrite")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    receipt = {"started_at": datetime.now(timezone.utc).isoformat(), "status": "running",
               "viewport": {"width": 1920, "height": 1080}, "steps": [], "requests": [], "measurements": []}
    request_times = {}
    response_statuses = {}
    failure = None
    video = None

    def step(name):
        receipt["steps"].append({"name": name, "elapsed_s": round(time.monotonic() - started, 3)})
        print(name, flush=True)

    def request_started(request):
        if urlsplit(request.url).path.startswith("/api/"):
            request_times[request] = time.monotonic()

    def request_finished(request):
        begin = request_times.pop(request, None)
        if begin is None:
            return
        timing = request.timing
        receipt["requests"].append({"method": request.method, "path": urlsplit(request.url).path,
                                    "elapsed_s": round(time.monotonic() - begin, 3),
                                    "response_end_ms": timing.get("responseEnd"),
                                    "status": response_statuses.pop(request, None),
                                    "failed": request.failure is not None})

    async def finish_explanation():
        async with asyncio.timeout(args.timeout_s):
            while any(urlsplit(request.url).path == "/api/explain" for request in request_times):
                await asyncio.sleep(0.1)

    async with async_playwright() as playwright, asyncio.timeout(args.timeout_s * (5 + len(args.chips))):
        browser = await playwright.chromium.launch(channel=args.channel, headless=False,
                                                    args=["--window-size=1920,1080"])
        with tempfile.TemporaryDirectory(prefix="crowd-demo-video-") as scratch:
            context = await browser.new_context(viewport=receipt["viewport"],
                                                record_video_dir=scratch,
                                                record_video_size=receipt["viewport"])
            page = await context.new_page()
            video = page.video
            page.set_default_timeout(args.timeout_s * 1000)
            page.on("request", request_started)
            page.on("response", lambda response: response_statuses.__setitem__(response.request, response.status) if response.request in request_times else None)
            page.on("requestfinished", request_finished)
            page.on("requestfailed", request_finished)
            try:
                step("Room: load demo")
                await page.goto(demo_url(args.base_url), wait_until="domcontentloaded")
                await page.wait_for_function("typeof scene !== 'undefined' && scene && scene.obstacles.length > 0")
                await page.wait_for_timeout(2000)
                await page.locator('button[data-step="event"]').click()
                if not (await page.locator("#brief").input_value()).strip():
                    raise RuntimeError("Demo mode did not prefill the event brief")
                step("Event: interpret prefilled brief")
                await page.locator("#interpret").click()
                await page.locator("#interpretation").wait_for(state="visible")
                await page.wait_for_timeout(2000)
                await page.locator("#confirm").click()
                if await page.locator("#confirm-event").is_visible():
                    await page.locator("#confirm-event").click()
                await page.locator("#panel-rehearse").wait_for(state="visible")
                step("Rehearse: run confirmed event")
                await page.locator('button[data-step="rehearse"]').click()
                await page.locator("#run").click()
                await page.wait_for_function("typeof result !== 'undefined' && result && !busy && frames")
                receipt["measurements"].append(await page.evaluate("({kind:'baseline',metrics:result.metrics,accounting:result.accounting,scenario:lastRun.scenario})"))
                await page.locator("#speed").select_option("10")
                await page.locator("#play").click()
                await page.wait_for_timeout(min(args.play_s, 2) * 1000)
                point = await page.evaluate("""() => {
                    const person = drawn.find(p => p.state !== 'done');
                    if (!person) return null;
                    if (watchActive && watchView?.projectPoint) return watchView.projectPoint(personPosition(person.i,person.state),.7);
                    const rect=canvas.getBoundingClientRect();return [rect.left+person.x,rect.top+person.y];
                }""")
                if point:
                    await page.mouse.click(point[0], point[1])
                if await page.locator("#person-select").input_value() == "":
                    await page.locator("#person-select").select_option(index=1)
                for key in ("2", "3", "1"):
                    await page.locator("#play").focus()
                    await page.keyboard.press(key)
                    await page.wait_for_timeout(700)
                await page.wait_for_timeout(max(0, args.play_s - 2) * 1000)
                await page.evaluate("if (playing) document.getElementById('play').click()")
                step("Improve: request permitted candidates")
                await page.locator('button[data-step="improve"]').click()
                if not (await page.locator("#constraints").input_value()).strip():
                    raise RuntimeError("Demo mode did not prefill layout constraints")
                await page.locator("#propose").click()
                await page.wait_for_function("!document.getElementById('propose').disabled && (document.getElementById('candidate-tabs').children.length > 1 || document.getElementById('api-error').textContent)")
                candidate = page.locator('[data-candidate-index="0"]')
                if not await candidate.count():
                    raise RuntimeError("Candidate A was rejected or unavailable; recording retains the real result")
                step("Candidate A: show measured comparison")
                await candidate.click()
                confirmation = page.get_by_role("button", name="Confirm and measure operating change", exact=True)
                if await confirmation.count() and await confirmation.is_visible():
                    await confirmation.click()
                await page.wait_for_function("activeCandidate === 0 && !busy && document.querySelector('#metric-comparison table')")
                receipt["measurements"].append(await page.evaluate("({kind:'candidate_a',metrics:result.metrics,accounting:result.accounting,scenario:lastRun.scenario,scene:lastRun.scene,patch:candidates[0].patch,rationale:candidates[0].rationale})"))
                await finish_explanation()
                await page.wait_for_timeout(3000)
                for chip in args.chips:
                    step("Restore original baseline")
                    await page.locator('button[data-step="rehearse"]').focus()
                    await page.keyboard.press("R")
                    await page.wait_for_function("activeCandidate === -1 && !busy")
                    await page.locator('button[data-step="improve"]').click()
                    step(f"Operating change: {chip}")
                    await page.locator(f"#judge-{chip}").click()
                    await page.locator("#operation-preview").wait_for(state="visible")
                    await page.wait_for_timeout(2000)
                    async with page.expect_response(lambda response: urlsplit(response.url).path == "/api/operations" and response.request.method == "POST") as pending_response:
                        await page.locator("#operation-confirm").click()
                    response = await pending_response.value
                    measured_response = await response.json()
                    if response.status != 200:
                        raise RuntimeError(f"Operating change {chip} rejected with HTTP {response.status}: {measured_response.get('detail', 'request failed')}")
                    await page.wait_for_function("runId => !busy && activeCandidate === 0 && result?.run_id === runId && document.querySelector('#metric-comparison table')", arg=measured_response["run_id"])
                    await finish_explanation()
                    measured = await page.evaluate("({metrics:result.metrics,accounting:result.accounting,scenario:lastRun.scenario})")
                    receipt["measurements"].append({"kind": chip, **measured})
                    await page.wait_for_timeout(3000)
                    if chip == "waves":
                        step("Show the next measured release wave")
                        await page.locator('button[data-step="rehearse"]').click()
                        schedule = measured["scenario"]
                        next_wave = schedule.get("wave_gap_s", 300) if schedule["mode"] == "dinner_call" else schedule["arrival_window_s"] / 5
                        await page.locator("#scrubber").evaluate("(element, value) => {element.value=String(value);element.dispatchEvent(new Event('input',{bubbles:true}));}", max(0, next_wave - 5))
                        await page.locator("#speed").select_option("10")
                        await page.locator("#play").click()
                        await page.wait_for_timeout(2000)
                        await page.evaluate("if (playing) document.getElementById('play').click()")
                step("Recording complete")
                receipt["status"] = "completed"
            except asyncio.CancelledError:
                receipt["status"] = "failed"
                receipt["error"] = "Recording timed out or was cancelled"
                raise
            except Exception as exc:
                failure = exc
                receipt["status"] = "failed"
                receipt["error"] = str(exc)
            finally:
                await context.close()
                if video:
                    await video.save_as(str(args.output))
                await browser.close()
                receipt["elapsed_s"] = round(time.monotonic() - started, 3)
                receipt["video_path"] = str(args.output)
                args.output.with_suffix(".json").write_text(json.dumps(receipt, indent=2) + "\n")
    if failure:
        raise RuntimeError(f"Recording stopped; partial video and receipt saved to {args.output}") from failure
    print(f"Saved {args.output} and {args.output.with_suffix('.json')}")


if __name__ == "__main__":
    asyncio.run(record(arguments()))
