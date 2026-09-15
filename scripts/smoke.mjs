/**
 * Browser smoke test.
 *
 * Builds nothing and mocks nothing: it loads the real app in a real browser,
 * drives the parts a first-time user touches, and fails on any console error.
 * A unit suite cannot tell you that WebGL initialised, that the worker started,
 * or that a shader compiled — and those are exactly the things that break.
 */

import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const BASE = process.env.CROWD_URL ?? 'http://127.0.0.1:4173'
const OUT = 'out/smoke'

const run = async () => {
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch({
    executablePath:
      process.env.CROWD_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })

  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  const step = async (name, fn) => {
    process.stdout.write(`· ${name}… `)
    try {
      await fn()
    } catch (error) {
      const open = await page
        .locator('.modal h2')
        .allInnerTexts()
        .catch(() => [])
      console.log('FAILED')
      if (open.length) console.error(`  (a dialog was open: ${open.join(', ')})`)
      await page
        .screenshot({ path: `${OUT}/failure-${name.replace(/\W+/g, '-')}.png` })
        .catch(() => {})
      throw error
    }
    console.log('ok')
  }

  await step('load', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' })
    await page.waitForSelector('.app', { timeout: 20000 })
  })

  await step('welcome dialog', async () => {
    await page.waitForSelector('.modal', { timeout: 10000 })
    await page.getByRole('button', { name: 'Start with an empty plan' }).click()
    await page.waitForSelector('.modal', { state: 'detached' })
  })

  await step('canvas is drawing', async () => {
    await page.waitForSelector('canvas.viewport-canvas')
    const drawn = await page.evaluate(() => {
      const canvas = document.querySelector('canvas.viewport-canvas')
      return canvas instanceof HTMLCanvasElement && canvas.width > 100 && canvas.height > 100
    })
    if (!drawn) throw new Error('The viewport canvas was never sized.')
  })

  await step('starter venue loaded', async () => {
    const text = await page.locator('.playbar').innerText()
    if (!/people/.test(text)) throw new Error('The playback bar did not report a population.')
  })

  await page.screenshot({ path: `${OUT}/01-editor.png` })

  await step('template picker', async () => {
    await page.getByRole('button', { name: 'Templates' }).click()
    await page.waitForSelector('.template-grid')
    await page.screenshot({ path: `${OUT}/02-templates.png` })
    await page.getByText('Conference registration', { exact: true }).click()
    await page.waitForSelector('.modal', { state: 'detached' })
    await page.waitForTimeout(800)
  })

  await page.screenshot({ path: `${OUT}/03-conference.png` })

  await step('tools switch', async () => {
    for (const [key, expected] of [
      ['w', 'Click to start'],
      ['f', 'Click to place'],
      ['z', 'Drag to place an area'],
      ['v', 'Click to select'],
    ]) {
      await page.keyboard.press(key)
      await page.waitForTimeout(120)
      const hint = await page
        .locator('.stage-bottom-left')
        .innerText()
        .catch(() => '')
      if (!hint.includes(expected))
        throw new Error(`Tool ${key} did not show its hint (saw "${hint}")`)
    }
  })

  await step('draw a wall', async () => {
    await page.keyboard.press('w')
    const box = await page.locator('canvas.viewport-canvas').boundingBox()
    await page.mouse.move(box.x + 300, box.y + 300)
    await page.mouse.down()
    await page.mouse.up()
    await page.mouse.move(box.x + 520, box.y + 300, { steps: 8 })
    await page.mouse.down()
    await page.mouse.up()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
  })

  await step('panels render', async () => {
    for (const label of ['Scenario', 'Results', 'View and layers', 'Settings', 'Library']) {
      await page.getByRole('button', { name: label, exact: true }).click()
      await page.waitForTimeout(160)
      const body = await page.locator('.side-panel').innerText()
      if (body.trim().length < 8) throw new Error(`Panel ${label} rendered empty.`)
    }
  })

  await page.screenshot({ path: `${OUT}/04-panels.png` })

  await step('copy and paste', async () => {
    await page.getByRole('button', { name: 'View and layers', exact: true }).click()
    await page.waitForSelector('.side-panel .list-row')
    const furnitureCount = async () => {
      const text = await page.locator('.side-panel').innerText()
      return Number(text.match(/furniture \((\d+)\)/i)?.[1] ?? '0')
    }
    const before = await furnitureCount()
    await page
      .locator('.side-panel .section')
      .filter({ hasText: /furniture \(\d+\)/i })
      .locator('.list-row')
      .first()
      .click()
    await page.waitForTimeout(150)
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+v')
    await page.waitForTimeout(250)
    if ((await furnitureCount()) !== before + 1) throw new Error('Paste did not add an object.')
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(250)
    if ((await furnitureCount()) !== before) throw new Error('Undo did not reverse the paste.')
    await page.keyboard.press('Escape')
  })

  await step('projects dialog', async () => {
    await page.getByRole('button', { name: 'Projects', exact: true }).click()
    await page.waitForSelector('.modal')
    await page.getByRole('button', { name: 'Save this project' }).click()
    await page.waitForTimeout(500)
    const listed = await page.locator('.modal .list-row').count()
    if (listed < 1) throw new Error('The saved project was not listed.')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.modal', { state: 'detached' })
  })

  await step('select, delete and undo', async () => {
    await page.getByRole('button', { name: 'View and layers', exact: true }).click()
    await page.waitForSelector('.side-panel .list-row')

    const furnitureCount = async () => {
      const text = await page.locator('.side-panel').innerText()
      // Section titles are upper-cased by CSS, and innerText respects that.
      return Number(text.match(/furniture \((\d+)\)/i)?.[1] ?? '0')
    }

    const before = await furnitureCount()
    if (before < 1) throw new Error('The venue has no furniture to select.')

    // Select through the object list, which is deterministic, then confirm the
    // inspector picked it up.
    await page
      .locator('.side-panel .section')
      .filter({ hasText: /furniture \(\d+\)/i })
      .locator('.list-row')
      .first()
      .click()
    await page.waitForTimeout(200)
    const inspector = await page.locator('.inspector').innerText()
    if (!/Delete/.test(inspector)) throw new Error('The inspector did not show the selected item.')

    await page.keyboard.press('Delete')
    await page.waitForTimeout(250)
    if ((await furnitureCount()) !== before - 1) throw new Error('Delete did not remove the item.')

    await page.keyboard.press('Control+z')
    await page.waitForTimeout(250)
    if ((await furnitureCount()) !== before) throw new Error('Undo did not restore the item.')

    await page.keyboard.press('Escape')
  })

  await step('doors are sizes a supplier sells', async () => {
    await page.getByRole('button', { name: 'View and layers', exact: true }).click()
    await page.waitForSelector('.side-panel .list-row')

    const openings = page
      .locator('.side-panel .section')
      .filter({ hasText: /openings \(\d+\)/i })
      .locator('.list-row')
    const total = await openings.count()
    if (total < 1) throw new Error('The venue has no openings to inspect.')

    // Windows share the list with doorways and carry no use control, so walk
    // the list until a doorway is selected. Every match here is case-insensitive
    // because the inspector is upper-cased in CSS and innerText respects that.
    let inspector = ''
    for (let i = 0; i < total; i++) {
      await openings.nth(i).click()
      await page.waitForTimeout(160)
      inspector = await page.locator('.inspector').innerText()
      if (/doorway/i.test(inspector)) break
    }
    if (!/doorway/i.test(inspector)) throw new Error('No doorway was selectable from the list.')

    // Every template door is drawn from the standards table. One that has
    // drifted off a stock size is a door nobody can actually order.
    if (/not a stock size/i.test(inspector))
      throw new Error(`A template doorway is not an orderable size:\n${inspector}`)
    if (!/people use it as/i.test(inspector))
      throw new Error('A doorway did not offer the way-in/way-out control.')
  })

  await step('a doorway can be made a way out', async () => {
    const use = page.locator('.field').filter({ hasText: 'People use it as' }).locator('select')
    const before = await use.inputValue()
    const target = before === 'exit' ? 'entry' : 'exit'

    await use.selectOption(target)
    await page.waitForTimeout(220)
    if ((await use.inputValue()) !== target)
      throw new Error(`Setting the door use to ${target} did not stick.`)

    // Marking a door is an edit like any other, so it has to undo like one.
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(250)
    if ((await use.inputValue()) !== before)
      throw new Error('Undo did not restore how the door was used.')

    // Put it back the way it was found. A venue whose only door is marked as a
    // way out has nowhere for anybody to arrive, and the steps after this one
    // still need a plan that runs.
    await use.selectOption(before)
    await page.waitForTimeout(220)
    await page.keyboard.press('Escape')
  })

  await step('a saved project comes back', async () => {
    const furnitureCount = async () => {
      await page.getByRole('button', { name: 'View and layers', exact: true }).click()
      await page.waitForSelector('.side-panel .list-row')
      const text = await page.locator('.side-panel').innerText()
      return Number(text.match(/furniture \((\d+)\)/i)?.[1] ?? '0')
    }

    await page.getByRole('button', { name: 'Projects', exact: true }).click()
    await page.waitForSelector('.modal')
    await page.getByRole('button', { name: 'Save this project' }).click()
    await page.waitForTimeout(600)
    await page.keyboard.press('Escape')
    await page.waitForSelector('.modal', { state: 'detached' })

    const saved = await furnitureCount()
    if (saved < 1) throw new Error('The venue has no furniture to lose.')

    await page
      .locator('.side-panel .section')
      .filter({ hasText: /furniture \(\d+\)/i })
      .locator('.list-row')
      .first()
      .click()
    await page.waitForTimeout(200)
    await page.keyboard.press('Delete')
    await page.waitForTimeout(250)
    if ((await furnitureCount()) !== saved - 1)
      throw new Error('The item to be recovered was never deleted.')

    // Reopening is the only proof that the save wrote a whole document and not
    // a reference to the one still in memory.
    await page.getByRole('button', { name: 'Projects', exact: true }).click()
    await page.waitForSelector('.modal .list-row')
    await page.locator('.modal .list-row').first().click()
    await page.waitForTimeout(700)
    if (await page.locator('.modal').count()) {
      await page.keyboard.press('Escape')
      await page.waitForSelector('.modal', { state: 'detached' })
    }

    if ((await furnitureCount()) !== saved)
      throw new Error('Reopening the saved project did not restore the venue.')
    await page.keyboard.press('Escape')
  })

  await step('run the simulation', async () => {
    // Fastest playback, so the run reaches its busy period inside the test.
    await page.getByRole('button', { name: '60×' }).click()
    await page.getByRole('button', { name: /^Run$/ }).click()
    await page.waitForFunction(
      () => {
        const text = document.querySelector('.live-stats')?.textContent ?? ''
        const match = text.match(/(\d+)\s*inside/)
        return match ? Number(match[1]) > 3 : false
      },
      { timeout: 40000 },
    )
  })

  await step('people are moving', async () => {
    await page.waitForFunction(
      () => {
        const text = document.querySelector('.live-stats')?.textContent ?? ''
        const speed = Number(text.match(/([\d.]+)\s*m\/s/)?.[1] ?? '0')
        return speed > 0.15
      },
      { timeout: 40000 },
    )
  })

  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${OUT}/05-running.png` })

  await step('heat map toggles', async () => {
    await page.keyboard.press('h')
    await page.waitForTimeout(500)
    await page.keyboard.press('h')
    await page.waitForTimeout(800)
  })

  await step('pause and resume', async () => {
    await page.keyboard.press(' ')
    await page.waitForTimeout(400)
    await page.keyboard.press(' ')
    await page.waitForTimeout(400)
  })

  await step('shortcut sheet', async () => {
    await page.keyboard.press('?')
    await page.waitForSelector('.shortcut-grid')
    await page.screenshot({ path: `${OUT}/06-shortcuts.png` })
    await page.keyboard.press('Escape')
  })

  await step('plan view', async () => {
    await page.getByRole('button', { name: 'Plan', exact: true }).click()
    await page.waitForTimeout(1200)
    await page.screenshot({ path: `${OUT}/08-plan.png` })
    await page.getByRole('button', { name: '3D', exact: true }).click()
    await page.waitForTimeout(900)
  })

  await step('frame rate with a crowd', async () => {
    const fps = await page.evaluate(
      () =>
        new Promise((resolve) => {
          let frames = 0
          const started = performance.now()
          const tick = () => {
            frames++
            if (performance.now() - started < 2000) requestAnimationFrame(tick)
            else resolve((frames * 1000) / (performance.now() - started))
          }
          requestAnimationFrame(tick)
        }),
    )
    const inside = Number(
      (await page.locator('.live-stats').innerText()).match(/(\d+)\s*inside/)?.[1] ?? '0',
    )
    console.log(`\n    ${fps.toFixed(0)} fps with ${inside} people (software GL)`)
    // Software rendering on a shared runner is an order of magnitude slower than
    // a real GPU and varies with whatever else the machine is doing, so the
    // absolute number here means nothing. The only thing worth asserting is that
    // frames are still being produced at all — a shader that fails to compile or
    // a render loop that stalls shows up as zero.
    if (fps < 2) throw new Error(`Frame rate collapsed to ${fps.toFixed(1)} fps.`)
  })

  // -------------------------------------------------------------------------
  // A venue built from nothing, which is the path a new user actually takes.
  // Everything before this started from a template; none of it proves you can
  // draw a room, put a door in it, furnish it, fill it with people and get an
  // answer. This does, through the real UI, with no fixtures.
  // -------------------------------------------------------------------------

  const countInList = async (kind) => {
    await page.getByRole('button', { name: 'View and layers', exact: true }).click()
    await page.waitForTimeout(160)
    const text = await page.locator('.side-panel').innerText()
    return Number(text.match(new RegExp(`${kind} \\((\\d+)\\)`, 'i'))?.[1] ?? '0')
  }

  await step('start an empty venue', async () => {
    await page.getByRole('button', { name: 'Projects', exact: true }).click()
    await page.waitForSelector('.modal')
    await page.getByRole('button', { name: 'New empty project' }).click()
    await page.waitForSelector('.modal', { state: 'detached' })
    await page.waitForTimeout(400)

    if ((await countInList('walls')) !== 0)
      throw new Error('A new project did not start with an empty plan.')
  })

  await step('draw a room out of four walls', async () => {
    // Straight down, so that every click lands on the ground plane. In the 3D
    // view a point near the top of the canvas can sit above the horizon, where
    // the pick ray never meets the floor and the click is silently dropped —
    // which is a fair thing for the app to do and a trap for a test.
    await page.getByRole('button', { name: 'Plan', exact: true }).click()
    await page.waitForTimeout(1200)

    await page.keyboard.press('w')
    const box = await page.locator('canvas.viewport-canvas').boundingBox()
    // A closed rectangle, drawn as a chain and closed back onto its start.
    const corners = [
      [-180, -120],
      [180, -120],
      [180, 120],
      [-180, 120],
      [-180, -120],
    ]
    for (const [dx, dy] of corners) {
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 })
      await page.waitForTimeout(120)
      await page.mouse.down()
      await page.mouse.up()
      await page.waitForTimeout(450)
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(350)

    const walls = await countInList('walls')
    if (walls < 4) throw new Error(`Drew four walls but the plan has ${walls}.`)
  })

  await page.screenshot({ path: `${OUT}/06-drawn-room.png` })

  await step('cut a door into a wall', async () => {
    await page.keyboard.press('d')
    const box = await page.locator('canvas.viewport-canvas').boundingBox()
    // The middle of the first wall the chain above drew.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 120, { steps: 8 })
    await page.waitForTimeout(150)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(400)
    await page.keyboard.press('Escape')

    const openings = await countInList('openings')
    if (openings < 1) throw new Error('Clicking a wall with the door tool cut no opening.')
  })

  await step('mark that door as the way in and out', async () => {
    await page
      .locator('.side-panel .section')
      .filter({ hasText: /openings \(\d+\)/i })
      .locator('.list-row')
      .first()
      .click()
    await page.waitForTimeout(220)

    const use = page.locator('.field').filter({ hasText: 'People use it as' }).locator('select')
    if ((await use.count()) === 0)
      throw new Error('The door the tool cut does not offer the way-in/way-out control.')
    await use.selectOption('both')
    await page.waitForTimeout(220)
    await page.keyboard.press('Escape')
  })

  await step('furnish it from the library', async () => {
    const before = await countInList('furniture')
    await page.getByRole('button', { name: 'Library', exact: true }).click()
    await page.waitForSelector('.catalog-grid')
    await page.locator('.catalog-grid button').first().click()
    await page.waitForTimeout(200)

    const box = await page.locator('canvas.viewport-canvas').boundingBox()
    for (const [dx, dy] of [
      [-90, -30],
      [0, -30],
      [90, -30],
    ]) {
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 })
      await page.waitForTimeout(150)
      await page.mouse.down()
      await page.mouse.up()
      await page.waitForTimeout(350)
    }
    await page.keyboard.press('Escape')

    const after = await countInList('furniture')
    if (after <= before) throw new Error('Placing from the library added no furniture.')

    await page.getByRole('button', { name: '3D', exact: true }).click()
    await page.waitForTimeout(900)
  })

  await page.screenshot({ path: `${OUT}/07-furnished.png` })

  await step('put a crowd in it', async () => {
    await page.getByRole('button', { name: 'Scenario', exact: true }).click()
    await page.waitForTimeout(250)

    const panel = await page.locator('.side-panel').innerText()
    if (!/people/i.test(panel)) {
      await page.getByRole('button', { name: /Add another group/ }).click()
      await page.waitForTimeout(300)
    }

    const people = page
      .locator('.field')
      .filter({ hasText: /^People/ })
      .locator('input')
      .first()
    await people.fill('60')
    await people.blur()
    await page.waitForTimeout(300)

    const playbar = await page.locator('.playbar').innerText()
    if (!/\d/.test(playbar)) throw new Error('The playback bar never reported a population.')
  })

  await step('run the venue that was just drawn', async () => {
    await page.getByRole('button', { name: '60×' }).click()
    await page.getByRole('button', { name: /^Run$/ }).click()
    await page.waitForFunction(
      () => {
        const text = document.querySelector('.live-stats')?.textContent ?? ''
        const inside = Number(text.match(/(\d+)\s*inside/)?.[1] ?? '0')
        return inside > 0
      },
      undefined,
      { timeout: 45_000 },
    )
    await page.waitForTimeout(2500)
  })

  await page.screenshot({ path: `${OUT}/08-scratch-running.png` })

  await step('read a number back out of it', async () => {
    await page.getByRole('button', { name: 'Results', exact: true }).click()
    await page.waitForTimeout(600)

    // Wait for the run to actually finish. Reading the panel while it still
    // says "Running" proves only that a panel exists, which is the weaker
    // claim; the point of this chapter is that a venue drawn from nothing
    // produces an answer.
    await page
      .waitForFunction(
        () => {
          const text = document.querySelector('.side-panel')?.textContent ?? ''
          return !/results appear when it finishes/i.test(text)
        },
        undefined,
        { timeout: 120_000 },
      )
      .catch(() => {})

    // The venue drawn above has a single door that is both the way in and the
    // way out, and a crowd with no itinerary, so people arrive and leave by the
    // same opening and the mean journey is legitimately near zero. What is
    // under test is that the loop closes at all: drawn plan in, numbers out.
    const results = await page.locator('.side-panel').innerText()
    if (/results appear when it finishes/i.test(results))
      throw new Error('The run never finished, so the results panel never filled in.')
    // A finished run reports how long it took people to get through.
    if (!/\d/.test(results)) throw new Error(`The results panel reported nothing:\n${results}`)
    console.log(
      `\n    results after a from-scratch run:\n      ${results.split('\n').slice(0, 6).join('\n      ')}`,
    )

    // Back to a stopped editor if the run has not already ended by itself —
    // once it finishes there is nothing left to stop and the button is gone.
    const stop = page.getByRole('button', { name: 'Stop', exact: true })
    if (await stop.count()) {
      await stop.click()
      await page.waitForTimeout(900)
    }
  })

  await step('dark theme', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await page.waitForTimeout(900)
    await page.screenshot({ path: `${OUT}/07-dark.png` })
  })

  await browser.close()

  // Ignore noise we cannot control and that does not indicate a fault.
  const real = errors.filter(
    (message) =>
      !/favicon/i.test(message) &&
      !/Download the React DevTools/i.test(message) &&
      !/WebGL.*deprecat/i.test(message),
  )
  if (real.length > 0) {
    console.error(`\n${real.length} console error(s):`)
    for (const message of real.slice(0, 12)) console.error(`  ${message}`)
    process.exit(1)
  }
  console.log(`\nAll smoke steps passed. Screenshots in ${OUT}/`)
}

run().catch((error) => {
  console.error(`\nSmoke test failed: ${error.message}`)
  process.exit(1)
})
