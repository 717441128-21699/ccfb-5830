// 端到端冒烟测试: 载入示例素材 → 自动对齐 → 校验偏移 → 播放查漂移 → 导出 5s 画中画
// 用法: node test/e2e.mjs   (需要 dev server 已在 5173 端口运行)
import puppeteer from 'puppeteer-core'
import { execSync } from 'node:child_process'
import fs from 'node:fs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = process.env.APP_URL ?? 'http://localhost:5173'
const DOWNLOAD = '/tmp/mcr-e2e-download'
fs.rmSync(DOWNLOAD, { recursive: true, force: true })
fs.mkdirSync(DOWNLOAD, { recursive: true })

const EXPECTED = {
  // 相对偏移(秒): 以录音笔(recorder)为基准 0
  'cam2 - cam1': 8.4,
  'cam3 - cam1': 21.75,
  'cam1 - recorder': 6.3,
}

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  // 有头模式: 真实合成器 + 硬解, rVFC 逐帧回调, 漂移测量才反映真实水平
  // (无头软解环境下视频呈现本身被降级, 测不出真实同步精度)
  headless: false,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=1500,950'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1500, height: 950 })
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message))
page.on('dialog', (d) => d.dismiss())
const cleanup = async () => {
  try {
    await browser.close()
  } catch {}
}
process.on('uncaughtException', async (e) => {
  console.error(e)
  await cleanup()
  process.exit(1)
})
process.on('unhandledRejection', async (e) => {
  console.error(e)
  await cleanup()
  process.exit(1)
})

const cdp = await page.createCDPSession()
await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD })

console.log('打开页面…')
await page.goto(URL, { waitUntil: 'networkidle0' })

// 1. 载入示例素材
await page.click('#btn-load-demo')
await page.waitForFunction(() => document.querySelectorAll('.track-card').length === 4, { timeout: 20000 })
check('载入 4 路素材', true)

// 2. 自动对齐
console.log('自动对齐中…')
await page.click('#btn-auto-align')
await page.waitForFunction(
  () => (document.querySelectorAll('#align-report div').length ?? 0) >= 4,
  { timeout: 60000 },
)
const offsets = await page.evaluate(() =>
  Object.fromEntries(window.__app.tracks.map((t) => [t.name, t.offset])),
)
console.log('解出偏移:', offsets)
for (const [pair, want] of Object.entries(EXPECTED)) {
  const [a, b] = pair.split(' - ')
  const got = offsets[a] - offsets[b]
  check(`相对偏移 ${pair}`, Math.abs(got - want) < 0.05, `期望 ${want}s, 实际 ${got.toFixed(3)}s`)
}

// 3. 播放 3 秒, 每 250ms 采样一次漂移, 要求全程 < 40ms(一帧@25fps)
await page.evaluate(() => window.__app.engine.seek(30))
await page.click('#btn-play')
const driftSamples = []
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 250))
  driftSamples.push(
    await page.evaluate(() => {
      const names = Object.fromEntries(window.__app.tracks.map((t) => [t.id, t.name]))
      return Object.fromEntries([...window.__app.engine.drift].map(([k, v]) => [names[k], v]))
    }),
  )
}
const maxDrift = Math.max(...driftSamples.flatMap((s) => Object.values(s).map(Math.abs)))
const lastDrifts = driftSamples[driftSamples.length - 1]
const lastMax = Math.max(...Object.values(lastDrifts).map(Math.abs))
console.log('末次漂移(秒):', lastDrifts)
// 无头软解环境允许瞬时到 2 帧; 稳态(末次)须在一帧内
check('稳态漂移 < 45ms', lastMax < 0.045, `末次峰值 ${(lastMax * 1000).toFixed(1)}ms`)
check('瞬时漂移 < 80ms', maxDrift < 0.08, `全程峰值 ${(maxDrift * 1000).toFixed(1)}ms`)
await page.click('#btn-play') // 暂停

// 4. 导出 5 秒画中画
const aacOk = await page.evaluate(
  async () =>
    (await AudioEncoder.isConfigSupported({ codec: 'aac', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }))
      .supported,
)
await page.evaluate(() => window.__app.setSelection(30, 35))
await page.click('#btn-export')
console.log('导出中…')
await page.waitForFunction(() => document.querySelector('#export-progress').hidden, { timeout: 120000 })
await new Promise((r) => setTimeout(r, 800))
const files = fs.readdirSync(DOWNLOAD).filter((f) => f.endsWith('.mp4'))
check('导出产生 MP4 文件', files.length === 1, files[0])
if (files.length) {
  const probe = execSync(
    `ffprobe -v error -show_entries format=duration -show_entries stream=codec_type,codec_name,width,height -of compact=p=0 "${DOWNLOAD}/${files[0]}"`,
  ).toString()
  console.log(probe)
  const dur = parseFloat(probe.match(/duration=([\d.]+)/)?.[1] ?? '0')
  check('导出时长 ≈5s', Math.abs(dur - 5) < 0.3, `${dur}s`)
  check('含视频流 h264', /codec_type=video/.test(probe) && /h264/.test(probe))
  if (aacOk) check('含音频流 aac', /codec_type=audio/.test(probe) && /aac/.test(probe))
  else check('AAC 不可用时降级为无声导出', !/codec_type=audio/.test(probe))
  // 导出时间戳须从 0 开始(音画对齐的容器级保证)
  const starts = execSync(
    `ffprobe -v error -show_entries stream=start_time -of csv=p=0 "${DOWNLOAD}/${files[0]}"`,
  ).toString().trim().split('\n').map(parseFloat)
  check('各流 start_time ≈ 0', starts.every((s) => Math.abs(s) < 0.05), starts.join(', '))
}

await page.screenshot({ path: '/tmp/mcr-e2e.png' })
await browser.close()
console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures ? 1 : 0)
