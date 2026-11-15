// 导出调试: 打印页面 console 与进度状态
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
})
const page = await browser.newPage()
page.on('console', (m) => console.log('[console]', m.type(), m.text()))
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

await page.goto('http://localhost:5173', { waitUntil: 'networkidle0' })
await page.click('#btn-load-demo')
await page.waitForFunction(() => document.querySelectorAll('.track-card').length === 4, { timeout: 20000 })
await page.evaluate(() => window.__app.setSelection(30, 35))
await page.click('#btn-export')
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  const s = await page.evaluate(() => ({
    status: document.querySelector('#export-status')?.textContent,
    bar: document.querySelector('#export-bar')?.value,
    hidden: document.querySelector('#export-progress')?.hidden,
  }))
  console.log('progress:', JSON.stringify(s))
  if (s.hidden) break
}
await browser.close()
