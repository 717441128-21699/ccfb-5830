import { AlignResult, Track } from './types'
import { gccPhat } from './fft'

const ALIGN_RATE = 8000 // 互相关用采样率: 啁啾/语音能量集中在 4kHz 以下, 足够且 FFT 快

let ctx: AudioContext | null = null
function audioCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

/** 解码文件整轨音频(原始采样率, 供导出混音用) */
export async function decodeTrackAudio(track: Track): Promise<AudioBuffer> {
  if (track.pcm) return track.pcm
  const buf = await (await fetch(track.url)).arrayBuffer()
  track.pcm = await audioCtx().decodeAudioData(buf)
  return track.pcm
}

/** 混单声道并重采样到 ALIGN_RATE */
export async function toMonoLowRate(buf: AudioBuffer): Promise<Float32Array> {
  const len = Math.ceil((buf.duration * ALIGN_RATE))
  const off = new OfflineAudioContext(1, len, ALIGN_RATE)
  const src = off.createBufferSource()
  src.buffer = buf
  src.connect(off.destination)
  src.start()
  const rendered = await off.startRendering()
  return rendered.getChannelData(0)
}

/**
 * 自动对齐: 以时长最长的轨道为基准, 其余轨道逐一 GCC-PHAT 求偏移。
 * 基准轨道保持其当前 offset 不变。
 */
export async function autoAlign(
  tracks: Track[],
  onProgress: (msg: string) => void,
): Promise<AlignResult[]> {
  if (tracks.length < 2) throw new Error('至少需要两路素材才能互相关对齐')
  onProgress('解码音频…')
  const mono = new Map<string, Float32Array>()
  for (const t of tracks) {
    const pcm = await decodeTrackAudio(t)
    mono.set(t.id, await toMonoLowRate(pcm))
  }
  const ref = [...tracks].sort((a, b) => b.duration - a.duration)[0]
  const refSig = mono.get(ref.id)!
  const results: AlignResult[] = []
  for (const t of tracks) {
    if (t.id === ref.id) {
      results.push({ trackId: t.id, offset: ref.offset, peak: 1, confidence: Infinity })
      continue
    }
    onProgress(`互相关: ${ref.name} × ${t.name} …`)
    // 让出主线程, 让进度文案渲染出来
    await new Promise((r) => setTimeout(r, 30))
    const sig = mono.get(t.id)!
    const { lag, peak, confidence } = gccPhat(refSig, sig, ALIGN_RATE)
    // C(τ) 峰在 τ*: t 的媒体时间 m+τ 与基准媒体时间 m 同一会话时刻
    // => t.offset = ref.offset - lag
    const offset = ref.offset - lag
    results.push({ trackId: t.id, offset, peak, confidence })
  }
  return results
}
