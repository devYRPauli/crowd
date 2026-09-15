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
    // SwiftShader in CI is roughly an order of magnitude slower than a real GPU,
    // so this only catches a collapse, not a regression in rendering cost.
    if (fps < 5) throw new Error(`Frame rate collapsed to ${fps.toFixed(1)} fps.`)
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
