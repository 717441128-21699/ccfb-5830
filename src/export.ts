import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import { MP4Sample } from 'mp4box'
import { demuxVideo } from './demux'
import { decodeTrackAudio } from './audio'
import { Track, formatTime } from './types'

/** 单路视频的顺序解码器: 按呈现时间吐出帧, 调用方按媒体时间取帧 */
class TrackDecoder {
  private decoder: VideoDecoder
  private queue: VideoFrame[] = []
  private current: VideoFrame | null = null
  private idx = 0
  private flushed = false
  private done = false
  private wake: (() => void) | null = null
  private failed: Error | null = null

  constructor(
    private samples: MP4Sample[],
    private timescale: number,
    config: VideoDecoderConfig,
  ) {
    this.decoder = new VideoDecoder({
      output: (f) => {
        this.queue.push(f)
        this.wake?.()
      },
      error: (e) => {
        this.failed = e as unknown as Error
        this.wake?.()
      },
    })
    this.decoder.configure(config)
  }

  private pump(): void {
    while (this.idx < this.samples.length && this.decoder.decodeQueueSize < 24) {
      const s = this.samples[this.idx++]
      this.decoder.decode(
        new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: Math.round((s.cts / this.timescale) * 1e6),
          duration: Math.round((s.duration / this.timescale) * 1e6),
          data: s.data as BufferSource,
        }),
      )
    }
    if (this.idx >= this.samples.length && !this.flushed) {
      this.flushed = true
      this.decoder
        .flush()
        .catch(() => {})
        .finally(() => {
          this.done = true
          this.wake?.()
        })
    }
  }

  /** 取覆盖 mediaUs 的帧; 在首帧之前返回 null(画黑场) */
  async frameAt(mediaUs: number): Promise<VideoFrame | null> {
    for (;;) {
      if (this.failed) throw this.failed
      if (this.current) {
        const end = this.current.timestamp + (this.current.duration ?? 0)
        if (mediaUs < this.current.timestamp) return null
        if (mediaUs < end) return this.current
        this.current.close()
        this.current = null
        continue
      }
      if (!this.queue.length) {
        if (this.done) return null
        this.pump()
        if (!this.queue.length && !this.done) {
          await new Promise<void>((r) => (this.wake = r))
          this.wake = null
          continue
        }
      }
      if (this.queue.length) this.current = this.queue.shift()!
      else if (this.done) return null
    }
  }

  close(): void {
    this.current?.close()
    for (const f of this.queue) f.close()
    try {
      this.decoder.close()
    } catch {
      /* already closed */
    }
  }
}

export interface ExportOptions {
  tracks: Track[]
  mainTrackId: string
  audioTrackId: string | null
  inT: number
  outT: number
  fps: number
  width: number
  height: number
  onProgress: (frac: number, msg: string) => void
  signal: AbortSignal
}

async function pickVideoCodec(width: number, height: number, fps: number): Promise<string> {
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42001f']) {
    const { supported } = await VideoEncoder.isConfigSupported({
      codec,
      width,
      height,
      framerate: fps,
      bitrate: 8_000_000,
    })
    if (supported) return codec
  }
  throw new Error('当前浏览器不支持 H.264 硬件/软件编码')
}

/** 导出画中画合成 MP4: WebCodecs 解码→Canvas 合成→H.264/AAC 编码→mp4-muxer 封装 */
export async function exportPiP(opts: ExportOptions): Promise<Blob> {
  const { tracks, mainTrackId, inT, outT, fps, width, height, onProgress, signal } = opts
  const videoTracks = tracks.filter((t) => t.kind === 'video')
  if (!videoTracks.length) throw new Error('没有可导出的视频轨')
  if (outT <= inT) throw new Error('导出区间为空')

  onProgress(0, '解封装视频流…')
  const decoders = new Map<string, TrackDecoder>()
  try {
    for (const t of videoTracks) {
      const d = await demuxVideo(t.url)
      if (!d.codec.startsWith('avc1')) throw new Error(`${t.name}: 仅支持 H.264 视频导出(当前 ${d.codec})`)
      decoders.set(
        t.id,
        new TrackDecoder(d.samples, d.timescale, {
          codec: d.codec,
          codedWidth: d.width,
          codedHeight: d.height,
          ...(d.description ? { description: d.description as BufferSource } : {}),
          hardwareAcceleration: 'no-preference',
        }),
      )
    }

    // ---- 音频: 选中轨道整段解码, 按会话区间截取渲染为 48k 立体声 ----
    // 部分环境(如无头 Chrome)不支持 AAC 编码, 先探测, 不支持则导出无声并提示
    let audioPcm: AudioBuffer | null = null
    let audioNote = ''
    if (opts.audioTrackId) {
      const aacOk =
        (
          await AudioEncoder.isConfigSupported({
            codec: 'aac',
            sampleRate: 48000,
            numberOfChannels: 2,
            bitrate: 128_000,
          })
        ).supported === true
      if (!aacOk) {
        audioNote = '当前浏览器不支持 AAC 编码, 已导出无声视频'
      } else {
        const src = tracks.find((t) => t.id === opts.audioTrackId)
        if (src) {
          onProgress(0.02, '渲染音轨…')
          const decoded = await decodeTrackAudio(src)
          const range = outT - inT
          const off = new OfflineAudioContext(2, Math.ceil(range * 48000), 48000)
          const node = off.createBufferSource()
          node.buffer = decoded
          node.connect(off.destination)
          const mediaStart = inT - src.offset
          if (mediaStart >= 0) {
            node.start(0, mediaStart, Math.min(range, decoded.duration - mediaStart))
          } else {
            node.start(-mediaStart, 0, Math.min(range + mediaStart, decoded.duration))
          }
          audioPcm = await off.startRendering()
        }
      }
    }

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width, height },
      audio: audioPcm ? { codec: 'aac', sampleRate: 48000, numberOfChannels: 2 } : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    })

    // ---- 视频编码器 ----
    let encFailed: Error | null = null
    const codec = await pickVideoCodec(width, height, fps)
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => {
        encFailed = e as unknown as Error
      },
    })
    encoder.configure({
      codec,
      width,
      height,
      framerate: fps,
      bitrate: 8_000_000,
      latencyMode: 'quality',
      avc: { format: 'avc' },
    } as VideoEncoderConfig)

    // ---- 音频编码器 ----
    let audioEncoder: AudioEncoder | null = null
    if (audioPcm) {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => {
          encFailed = e as unknown as Error
        },
      })
      audioEncoder.configure({ codec: 'aac', sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 })
    }

    // ---- 逐帧合成 ----
    const canvas = new OffscreenCanvas(width, height)
    const g = canvas.getContext('2d')!
    const totalFrames = Math.round((outT - inT) * fps)
    const pipW = Math.round(width / 4.2)
    const margin = 14
    const gap = 10

    const drawFrame = async (i: number): Promise<void> => {
      const sessionT = inT + i / fps
      // 收集各路当前帧
      const frames = new Map<string, VideoFrame | null>()
      for (const t of videoTracks) {
        const m = sessionT - t.offset
        if (m < 0 || m > t.duration) {
          frames.set(t.id, null)
          continue
        }
        frames.set(t.id, await decoders.get(t.id)!.frameAt(Math.round(m * 1e6)))
      }
      const active = videoTracks.filter((t) => frames.get(t.id))
      const main =
        videoTracks.find((t) => t.id === mainTrackId && frames.get(t.id)) ?? active[0] ?? null

      g.fillStyle = '#000'
      g.fillRect(0, 0, width, height)

      const drawCover = (f: VideoFrame, dx: number, dy: number, dw: number, dh: number) => {
        const s = Math.max(dw / f.displayWidth, dh / f.displayHeight)
        const sw = dw / s
        const sh = dh / s
        g.drawImage(f, (f.displayWidth - sw) / 2, (f.displayHeight - sh) / 2, sw, sh, dx, dy, dw, dh)
      }

      if (main) {
        const f = frames.get(main.id)!
        drawCover(f, 0, 0, width, height)
      } else {
        g.fillStyle = '#666'
        g.font = `24px system-ui`
        g.textAlign = 'center'
        g.fillText('该时刻无视频轨覆盖', width / 2, height / 2)
      }

      // 小窗: 其余活跃视频轨, 右下角竖排
      const pips = active.filter((t) => t.id !== main?.id).slice(0, 3)
      pips.forEach((t, k) => {
        const f = frames.get(t.id)!
        const ph = Math.round((pipW * f.displayHeight) / f.displayWidth)
        const px = width - pipW - margin
        const py = height - margin - (ph + gap) * (pips.length - k) + gap
        g.drawImage(f, px, py, pipW, ph)
        g.strokeStyle = t.color
        g.lineWidth = 2
        g.strokeRect(px, py, pipW, ph)
        g.fillStyle = 'rgba(0,0,0,0.65)'
        g.fillRect(px, py, pipW, 20)
        g.fillStyle = '#fff'
        g.font = '13px system-ui'
        g.textAlign = 'left'
        g.fillText(t.name, px + 6, py + 14)
      })

      // 主画面标签 + 会话时间码
      g.fillStyle = 'rgba(0,0,0,0.65)'
      g.fillRect(margin, margin, 300, 30)
      g.fillStyle = '#fff'
      g.font = '16px ui-monospace, monospace'
      g.textAlign = 'left'
      g.fillText(`${main ? main.name : '—'}  ${formatTime(sessionT)}`, margin + 8, margin + 21)

      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((i * 1e6) / fps),
        duration: Math.round(1e6 / fps),
      })
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 })
      frame.close()
    }

    for (let i = 0; i < totalFrames; i++) {
      if (signal.aborted) throw new DOMException('已取消', 'AbortError')
      if (encFailed) throw encFailed
      await drawFrame(i)
      if (i % 10 === 0) {
        onProgress(0.05 + 0.85 * (i / totalFrames), `合成第 ${i + 1}/${totalFrames} 帧`)
        await new Promise((r) => setTimeout(r, 0)) // 让 UI 喘息
      }
      while (encoder.encodeQueueSize > 8) {
        if (encFailed) throw encFailed
        await new Promise((r) => setTimeout(r, 1))
      }
    }

    onProgress(0.92, '封装视频…')
    await encoder.flush()

    if (audioEncoder && audioPcm) {
      onProgress(0.95, '编码音频…')
      const ch0 = audioPcm.getChannelData(0)
      const ch1 = audioPcm.numberOfChannels > 1 ? audioPcm.getChannelData(1) : ch0
      const BLOCK = 1024
      for (let off = 0; off < audioPcm.length; off += BLOCK) {
        const frames = Math.min(BLOCK, audioPcm.length - off)
        const data = new Float32Array(frames * 2)
        data.set(ch0.subarray(off, off + frames), 0)
        data.set(ch1.subarray(off, off + frames), frames)
        audioEncoder.encode(
          new AudioData({
            format: 'f32-planar',
            sampleRate: 48000,
            numberOfFrames: frames,
            numberOfChannels: 2,
            timestamp: Math.round((off / 48000) * 1e6),
            data: data as BufferSource,
          }),
        )
      }
      await audioEncoder.flush()
      audioEncoder.close()
    }

    onProgress(0.98, '写出文件…')
    encoder.close()
    muxer.finalize()
    onProgress(1, audioNote ? `完成(${audioNote})` : '完成')
    return new Blob([muxer.target.buffer], { type: 'video/mp4' })
  } finally {
    for (const d of decoders.values()) d.close()
  }
}
