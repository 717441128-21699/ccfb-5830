// 同步引擎观测: 播放 6 秒, 每 500ms 打印各轨内部状态
import puppeteer from 'puppeteer-core'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=1500,950'],
})
process.on('uncaughtException', async () => { await browser.close(); process.exit(1) })
const page = await browser.newPage()
await page.setViewport({ width: 1500, height: 950 })
await page.goto('http://localhost:5173', { waitUntil: 'networkidle0' })
await page.click('#btn-load-demo')
await page.waitForFunction(() => document.querySelectorAll('.track-card').length === 4, { timeout: 20000 })
await page.click('#btn-auto-align')
await page.waitForFunction(() => document.querySelectorAll('#align-report div').length >= 4, { timeout: 60000 })
await page.evaluate(() => window.__app.engine.seek(30))
await page.click('#btn-play')
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 500))
  const s = await page.evaluate(() => {
    const e = window.__app.engine
    const now = e.sessionTime
    return {
      session: now.toFixed(2),
      tracks: window.__app.tracks.map((t) => ({
        name: t.name,
        ct: t.el.currentTime.toFixed(3),
        want: (now - t.offset).toFixed(3),
        comp: (e.comp.get(t.id) ?? 0).toFixed(3),
        rate: t.el.playbackRate.toFixed(2),
        paused: t.el.paused,
        rs: t.el.readyState,
        seeking: t.el.seeking,
      })),
    }
  })
  console.log(JSON.stringify(s))
}
await browser.close()
