// 验证: 每帧重设 playbackRate 是否会让实际速率失效
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
  const measure = async (label, fn) => {
    const t0 = v.currentTime
    const w0 = performance.now()
    await fn()
    await new Promise((r) => setTimeout(r, 2500))
    const advanced = v.currentTime - t0
    const wall = (performance.now() - w0) / 1000
    return { label, advanced: +advanced.toFixed(3), wall: +wall.toFixed(3), effective: +(advanced / wall).toFixed(3) }
  }
  const out = []
  // A: 每 16ms 重设 1.2(带微小抖动, 模拟 PI 控制输出)
  let stop = false
  const timer = setInterval(() => {
    v.playbackRate = 1.2 + (Math.random() - 0.5) * 0.02
  }, 16)
  out.push(await measure('每16ms重设1.2±0.01', async () => {}))
  clearInterval(timer)
  // B: 只设一次 1.2
  v.playbackRate = 1.2
  out.push(await measure('只设一次1.2', async () => {}))
  return out
})
console.log(JSON.stringify(r, null, 1))
await browser.close()
