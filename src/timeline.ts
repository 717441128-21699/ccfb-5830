import { Bookmark, Track, formatTime } from './types'

interface TimelineHooks {
  getTracks(): Track[]
  getBookmarks(): Bookmark[]
  getSelection(): { in: number; out: number } | null
  getSessionTime(): number
  onSeek(t: number): void
  onOffsetChange(track: Track, offset: number, final: boolean): void
  onBookmarkClick(b: Bookmark): void
}

const RULER_H = 28
const ROW_H = 30
const BM_H = 18

/** 会话时间轴: 标尺 + 轨道条(可拖调偏移) + 选区 + 书签 + 播放头 */
export class Timeline {
  private t0 = 0
  private t1 = 60
  private drag:
    | { kind: 'playhead' }
    | { kind: 'offset'; track: Track; grabDelta: number }
    | { kind: 'scrub' }
    | { kind: 'pan'; startX: number; t0: number; t1: number }
    | null = null

  constructor(private canvas: HTMLCanvasElement, private hooks: TimelineHooks) {
    canvas.addEventListener('pointerdown', this.onDown)
    window.addEventListener('pointermove', this.onMove)
    window.addEventListener('pointerup', this.onUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    new ResizeObserver(() => this.redraw()).observe(canvas.parentElement!)
  }

  fit(): void {
    const tracks = this.hooks.getTracks()
    if (!tracks.length) {
      this.t0 = 0
      this.t1 = 60
    } else {
      const lo = Math.min(...tracks.map((t) => t.offset))
      const hi = Math.max(...tracks.map((t) => t.offset + t.duration))
      const pad = (hi - lo) * 0.05 + 1
      this.t0 = lo - pad
      this.t1 = hi + pad
    }
    this.redraw()
  }

  private get ctx(): CanvasRenderingContext2D {
    return this.canvas.getContext('2d')!
  }

  private xToTime(x: number): number {
    return this.t0 + (x / this.canvas.width) * (this.t1 - this.t0)
  }

  private timeToX(t: number): number {
    return ((t - this.t0) / (this.t1 - this.t0)) * this.canvas.width
  }

  private trackAt(y: number): Track | null {
    const tracks = this.hooks.getTracks()
    const i = Math.floor((y - RULER_H) / ROW_H)
    return i >= 0 && i < tracks.length ? tracks[i] : null
  }

  private onDown = (e: PointerEvent): void => {
    const r = this.canvas.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const t = this.xToTime(x)
    const playX = this.timeToX(this.hooks.getSessionTime())
    if (Math.abs(x - playX) < 6 || y < RULER_H) {
      this.drag = { kind: 'playhead' }
      this.hooks.onSeek(t)
    } else if (y > this.canvas.height - BM_H) {
      const bm = this.hooks.getBookmarks().find((b) => Math.abs(this.timeToX(b.time) - x) < 7)
      if (bm) this.hooks.onBookmarkClick(bm)
    } else {
      const track = this.trackAt(y)
      if (track && t >= track.offset - 0.3 && t <= track.offset + track.duration + 0.3) {
        this.drag = { kind: 'offset', track, grabDelta: t - track.offset }
      } else {
        this.drag = { kind: 'scrub' }
        this.hooks.onSeek(t)
      }
    }
    this.canvas.setPointerCapture(e.pointerId)
  }

  private onMove = (e: PointerEvent): void => {
    if (!this.drag) return
    const r = this.canvas.getBoundingClientRect()
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left))
    const t = this.xToTime(x)
    if (this.drag.kind === 'playhead' || this.drag.kind === 'scrub') {
      this.hooks.onSeek(t)
    } else if (this.drag.kind === 'offset') {
      const off = Math.round((t - this.drag.grabDelta) * 1000) / 1000
      this.hooks.onOffsetChange(this.drag.track, off, false)
    } else if (this.drag.kind === 'pan') {
      const dt = ((this.drag.startX - x) / this.canvas.width) * (this.drag.t1 - this.drag.t0)
      this.t0 = this.drag.t0 + dt
      this.t1 = this.drag.t1 + dt
      this.redraw()
    }
  }

  private onUp = (): void => {
    if (this.drag?.kind === 'offset') {
      this.hooks.onOffsetChange(this.drag.track, this.drag.track.offset, true)
    }
    this.drag = null
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const dt = ((e.deltaX + (e.shiftKey ? e.deltaY : 0)) / this.canvas.width) * (this.t1 - this.t0)
      this.t0 += dt
      this.t1 += dt
    } else {
      const anchor = this.xToTime(e.offsetX)
      const k = e.deltaY > 0 ? 1.2 : 1 / 1.2
      this.t0 = anchor - (anchor - this.t0) * k
      this.t1 = anchor + (this.t1 - anchor) * k
      if (this.t1 - this.t0 < 0.5) this.t1 = this.t0 + 0.5
    }
    this.redraw()
  }

  redraw(): void {
    const parent = this.canvas.parentElement!
    const tracks = this.hooks.getTracks()
    const h = RULER_H + Math.max(1, tracks.length) * ROW_H + BM_H
    const dpr = window.devicePixelRatio || 1
    if (this.canvas.width !== parent.clientWidth * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = parent.clientWidth * dpr
      this.canvas.height = h * dpr
      this.canvas.style.height = `${h}px`
    }
    const ctx = this.ctx
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const W = parent.clientWidth
    const H = h
    const toX = (t: number) => ((t - this.t0) / (this.t1 - this.t0)) * W
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#14171c'
    ctx.fillRect(0, 0, W, H)

    // 选区
    const sel = this.hooks.getSelection()
    if (sel) {
      ctx.fillStyle = 'rgba(77,163,255,0.10)'
      ctx.fillRect(toX(sel.in), 0, toX(sel.out) - toX(sel.in), H)
      ctx.strokeStyle = 'rgba(77,163,255,0.6)'
      for (const b of [sel.in, sel.out]) {
        ctx.beginPath()
        ctx.moveTo(toX(b), 0)
        ctx.lineTo(toX(b), H)
        ctx.stroke()
      }
    }

    // 标尺刻度(自适应步长)
    const span = this.t1 - this.t0
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
    const step = steps.find((s) => span / s <= 14) ?? 900
    ctx.strokeStyle = '#3a4150'
    ctx.fillStyle = '#8b93a3'
    ctx.font = '10px ui-monospace, monospace'
    ctx.textAlign = 'center'
    for (let t = Math.ceil(this.t0 / step) * step; t <= this.t1; t += step) {
      const x = toX(t)
      ctx.beginPath()
      ctx.moveTo(x, RULER_H - 8)
      ctx.lineTo(x, RULER_H)
      ctx.stroke()
      ctx.fillText(formatTime(t, step < 1), x, RULER_H - 11)
    }
    ctx.strokeStyle = '#2a2f3a'
    ctx.beginPath()
    ctx.moveTo(0, RULER_H + 0.5)
    ctx.lineTo(W, RULER_H + 0.5)
    ctx.stroke()

    // 轨道条
    tracks.forEach((tr, i) => {
      const y = RULER_H + i * ROW_H
      const x0 = toX(tr.offset)
      const x1 = toX(tr.offset + tr.duration)
      ctx.fillStyle = tr.color + '33'
      ctx.fillRect(x0, y + 4, x1 - x0, ROW_H - 8)
      ctx.strokeStyle = tr.color
      ctx.strokeRect(x0 + 0.5, y + 4.5, x1 - x0, ROW_H - 9)
      ctx.fillStyle = '#c9d1e0'
      ctx.font = '11px system-ui, sans-serif'
      ctx.textAlign = 'left'
      const label = `${tr.kind === 'audio' ? '♪' : '▣'} ${tr.name}  (偏移 ${tr.offset >= 0 ? '+' : ''}${tr.offset.toFixed(3)}s)`
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, y, W, ROW_H)
      ctx.clip()
      ctx.fillText(label, Math.max(6, x0 + 6), y + ROW_H / 2 + 4)
      ctx.restore()
    })

    // 书签
    const bmY = H - BM_H
    ctx.strokeStyle = '#2a2f3a'
    ctx.beginPath()
    ctx.moveTo(0, bmY + 0.5)
    ctx.lineTo(W, bmY + 0.5)
    ctx.stroke()
    for (const b of this.hooks.getBookmarks()) {
      const x = toX(b.time)
      if (x < -8 || x > W + 8) continue
      ctx.fillStyle = b.color
      ctx.beginPath()
      ctx.moveTo(x, bmY + 2)
      ctx.lineTo(x + 5, bmY + 9)
      ctx.lineTo(x, bmY + 16)
      ctx.lineTo(x - 5, bmY + 9)
      ctx.closePath()
      ctx.fill()
    }

    // 播放头
    const px = toX(this.hooks.getSessionTime())
    ctx.strokeStyle = '#ff5252'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, H)
    ctx.stroke()
    ctx.fillStyle = '#ff5252'
    ctx.beginPath()
    ctx.moveTo(px - 6, 0)
    ctx.lineTo(px + 6, 0)
    ctx.lineTo(px, 8)
    ctx.closePath()
    ctx.fill()
    ctx.lineWidth = 1
  }
}
