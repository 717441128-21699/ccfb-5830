// 隔离测试: playbackRate 对视频元素是否生效
import puppeteer from 'puppeteer-core'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
})
const page = await browser.newPage()
await page.goto('http://localhost:5173/sample-media/cam1.mp4', { waitUntil: 'domcontentloaded' })
const r = await page.evaluate(async () => {
  const v = document.querySelector('video')
  v.muted = true
  await v.play()
  const m = async (rate) => {
    v.playbackRate = rate
    const t0 = v.currentTime
    const w0 = performance.now()
    await new Promise((r) => setTimeout(r, 2000))
    return { rate, advanced: v.currentTime - t0, wall: (performance.now() - w0) / 1000 }
  }
  const out = []
  out.push(await m(1.0))
  out.push(await m(1.5))
  out.push(await m(0.8))
  return out
})
console.log(JSON.stringify(r, null, 1))
await browser.close()
