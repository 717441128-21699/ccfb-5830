// 探测 headless Chrome 的 WebCodecs 编码能力
import puppeteer from 'puppeteer-core'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--mute-audio'],
})
const page = await browser.newPage()
page.on('console', (m) => console.log('[console]', m.text()))
await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' })
const result = await page.evaluate(async () => {
  const out = {}
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42001f']) {
    try {
      const cfg = { codec, width: 1280, height: 720, framerate: 30, bitrate: 8_000_000, avc: { format: 'avc' } }
      const s = await VideoEncoder.isConfigSupported(cfg)
      out[codec] = s.supported
      if (!s.supported) continue
      // 实际编一帧试试
      out[codec + '_encode'] = await new Promise((resolve) => {
        const chunks = []
        const enc = new VideoEncoder({
          output: (c) => chunks.push(c.byteLength),
          error: (e) => resolve('ERROR: ' + e.message),
        })
        enc.configure(cfg)
        const canvas = new OffscreenCanvas(1280, 720)
        const g = canvas.getContext('2d')
        g.fillStyle = '#123456'
        g.fillRect(0, 0, 1280, 720)
        const f = new VideoFrame(canvas, { timestamp: 0, duration: 33333 })
        enc.encode(f, { keyFrame: true })
        f.close()
        enc.flush().then(() => resolve('ok chunks=' + JSON.stringify(chunks))).catch((e) => resolve('FLUSH ERR: ' + e.message))
      })
    } catch (e) {
      out[codec] = 'EXC: ' + e.message
    }
  }
  // 音频编码器
  try {
    const s = await AudioEncoder.isConfigSupported({ codec: 'aac', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })
    out.aac = s.supported
  } catch (e) {
    out.aac = 'EXC: ' + e.message
  }
  // 解码器
  try {
    const s = await VideoDecoder.isConfigSupported({ codec: 'avc1.64001f', codedWidth: 1280, codedHeight: 720 })
    out.decode_avc = s.supported
  } catch (e) {
    out.decode_avc = 'EXC: ' + e.message
  }
  return out
})
console.log(JSON.stringify(result, null, 2))
await browser.close()
