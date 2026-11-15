declare module 'mp4box' {
  export interface MP4Sample {
    cts: number
    dts: number
    duration: number
    is_sync: boolean
    timescale: number
    data: Uint8Array
  }
  export interface MP4TrackInfo {
    id: number
    codec: string
    type: string
    timescale: number
    track_width: number
    track_height: number
  }
  export interface MP4Info {
    tracks: MP4TrackInfo[]
    videoTracks: MP4TrackInfo[]
    audioTracks: MP4TrackInfo[]
  }
  export const DataStream: {
    new (buf?: unknown, off?: number, endian?: unknown): {
      buffer: ArrayBuffer
    }
    BIG_ENDIAN: unknown
  }
  export interface MP4File {
    onReady: ((info: MP4Info) => void) | null
    onError: ((e: unknown) => void) | null
    onSamples: ((id: number, user: unknown, samples: MP4Sample[]) => void) | null
    appendBuffer(buf: ArrayBuffer & { fileStart?: number }): void
    flush(): void
    start(): void
    setExtractionOptions(id: number, user: unknown, opts: { nbSamples: number }): void
    getTrackById(id: number): {
      mdia: { minf: { stbl: { stsd: { entries: Array<{ avcC?: { write(s: unknown): void } }> } } } }
    }
  }
  export function createFile(): MP4File
}
