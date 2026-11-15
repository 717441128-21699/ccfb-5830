// 界面截图: 对齐后打两个书签、设选区、暂停在 45s
import puppeteer from 'puppeteer-core'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=1500,950'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1500, height: 950 })
await page.goto('http://localhost:5173', { waitUntil: 'networkidle0' })
await page.click('#btn-load-demo')
await page.waitForFunction(() => document.querySelectorAll('.track-card').length === 4, { timeout: 20000 })
await page.click('#btn-auto-align')
await page.waitForFunction(() => document.querySelectorAll('#align-report div').length >= 4, { timeout: 60000 })
// 打书签
await page.evaluate(() => window.__app.engine.seek(37.6))
await page.click('#btn-add-bookmark')
await page.evaluate(() => window.__app.engine.seek(63.3))
await page.click('#btn-add-bookmark')
await page.keyboard.press('Escape')
// 选区 30~65s
await page.evaluate(() => window.__app.setSelection(30, 65))
// 停在 45s
await page.evaluate(() => window.__app.engine.seek(45))
await new Promise((r) => setTimeout(r, 800))
await page.screenshot({ path: '/tmp/mcr-ui.png' })
await browser.close()
console.log('saved /tmp/mcr-ui.png')
