export type TrackKind = 'video' | 'audio'

export interface Track {
  id: string
  name: string
  kind: TrackKind
  url: string
  file?: File
  /** 媒体时长(秒) */
  duration: number
  /** 媒体 t=0 在会话时间轴上的位置(秒), 可为负 */
  offset: number
  el: HTMLVideoElement | HTMLAudioElement
  color: string
  width: number
  height: number
  /** 解码出的整轨 PCM(对齐/导出用), 懒加载 */
  pcm?: AudioBuffer
}

export interface Bookmark {
  id: string
  /** 会话时间(秒) */
  time: number
  text: string
  color: string
}

export interface AlignResult {
  trackId: string
  offset: number
  /** 相关峰强度 0..1 (PHAT 加权后的峰值) */
  peak: number
  /** 峰值 / 底噪, 越大越可信 */
  confidence: number
}

export const TRACK_COLORS = ['#4da3ff', '#ffb84d', '#5fd68a', '#ff7a7a', '#c792ea', '#4dd0e1']
export const BOOKMARK_COLORS = ['#ffd54d', '#ff8a65', '#81c784', '#4fc3f7', '#ba68c8']

let uid = 0
export function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(uid++).toString(36)}`
}

export function formatTime(t: number, withMs = true): string {
  const neg = t < 0
  const a = Math.abs(t)
  const h = Math.floor(a / 3600)
  const m = Math.floor((a % 3600) / 60)
  const s = Math.floor(a % 60)
  const ms = Math.floor((a % 1) * 1000)
  const core = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return (neg ? '-' : '') + (withMs ? `${core}.${String(ms).padStart(3, '0')}` : core)
}
