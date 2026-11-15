import { createFile, DataStream, MP4Sample } from 'mp4box'

export interface DemuxedVideo {
  codec: string
  width: number
  height: number
  timescale: number
  description: Uint8Array | null
  samples: MP4Sample[]
}

/** 用 mp4box 解出视频轨的 H.264 样本流(供 WebCodecs VideoDecoder) */
export async function demuxVideo(url: string): Promise<DemuxedVideo> {
  const buf = await (await fetch(url)).arrayBuffer()
  const file = createFile()
  return new Promise((resolve, reject) => {
    let done = false
    let info: import('mp4box').MP4Info | null = null
    const samples: MP4Sample[] = []

    const finish = () => {
      if (done) return
      done = true
      const track = info!.videoTracks[0]
      let description: Uint8Array | null = null
      try {
        const trak = file.getTrackById(track.id)
        for (const entry of trak.mdia.minf.stbl.stsd.entries) {
          if (entry.avcC) {
            const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN)
            entry.avcC.write(stream)
            description = new Uint8Array(stream.buffer, 8) // 去掉 box 头
          }
        }
      } catch {
        /* annexb 或无 avcC */
      }
      // B 帧重排使首帧 cts ≠ 0(通常 +2 帧), 容器用 edit list 把呈现时间拉回 0。
      // mp4box 的 cts 不含 edit list 修正, 这里按"最小 cts = 呈现零点"归一化。
      if (samples.length) {
        const minCts = Math.min(...samples.map((s) => s.cts))
        if (minCts > 0) for (const s of samples) s.cts -= minCts
      }
      resolve({
        codec: track.codec,
        width: track.track_width,
        height: track.track_height,
        timescale: track.timescale,
        description,
        samples,
      })
    }

    file.onError = (e) => reject(new Error(`MP4 解封装失败: ${String(e)}`))
    file.onReady = (i) => {
      info = i
      if (!i.videoTracks.length) {
        reject(new Error('文件里没有视频轨'))
        return
      }
      file.setExtractionOptions(i.videoTracks[0].id, null, { nbSamples: 1 << 30 })
      file.onSamples = (_id, _user, s) => samples.push(...s)
      file.start()
      // appendBuffer 已在 onReady 前调用过的话, 这里 flush 触发 onSamples
      file.flush()
      // 样本可能分批到, 简单等一拍再收尾
      queueMicrotask(() => finish())
    }
    ;(buf as ArrayBuffer & { fileStart?: number }).fileStart = 0
    file.appendBuffer(buf as ArrayBuffer & { fileStart?: number })
    file.flush()
    if (info) queueMicrotask(() => finish())
  })
}
