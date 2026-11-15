import { Track } from './types'

/**
 * 同步引擎: 以 performance.now() 为主时钟驱动"会话时间",
 * 每帧校正各 media 元素, 把音画漂移压在一帧以内。
 *
 * 校正为 PI 控制:
 *  - 积分项: 缓慢学习每轨的呈现管线延迟(视频约 40~60ms, 音频约 15ms),
 *    把该轨的目标位置提前相应量, 让"屏上画面/耳机声音"对齐主时钟;
 *  - 比例项: |误差| 10~35ms 时微调 playbackRate 软拉回(最多 ±20%);
 *  - |误差| > 35ms 硬 seek(每轨 400ms 冷却, 防止 seek 抖动)。
 */
export class SyncEngine {
  tracks: Track[] = []
  rate = 1
  audioSourceId: string | null = null
  onTick: ((sessionTime: number) => void) | null = null
  /** 每轨漂移读数(秒, 相对主时钟的表观延迟), 供 UI 显示 */
  drift = new Map<string, number>()
  /** 每轨上次硬校正时刻(performance.now()) */
  private lastHardSeek = new Map<string, number>()
  /** 每轨管线延迟补偿(秒, 积分项) */
  private comp = new Map<string, number>()
  private lastTickAt = 0

  private playing = false
  private playGen = 0
  private baseSession = 0
  private basePerf = 0
  private raf = 0

  get isPlaying(): boolean {
    return this.playing
  }

  setTracks(tracks: Track[]): void {
    this.tracks = tracks
  }

  get sessionTime(): number {
    if (!this.playing) return this.baseSession
    return this.baseSession + ((performance.now() - this.basePerf) / 1000) * this.rate
  }

  get sessionEnd(): number {
    if (!this.tracks.length) return 0
    return Math.max(...this.tracks.map((t) => t.offset + t.duration))
  }

  get sessionStart(): number {
    if (!this.tracks.length) return 0
    return Math.min(...this.tracks.map((t) => t.offset))
  }

  play(): void {
    if (this.playing || !this.tracks.length) return
    if (this.baseSession >= this.sessionEnd - 0.05) this.baseSession = this.sessionStart
    // 先把各轨 seek 到位并等落定, 再启动主时钟, 避免开局 seek 空窗被误判为漂移
    const gen = ++this.playGen
    for (const t of this.tracks) this.syncTrack(t, true)
    void this.waitSettled(800).then(() => {
      if (gen !== this.playGen || this.playing) return // 期间被暂停/重新操作
      this.playing = true
      this.basePerf = performance.now()
      for (const t of this.tracks) {
        if (t.el.paused) void t.el.play().catch(() => {})
      }
      this.loop()
    })
  }

  /** 等所有活跃元素 seek 落定(或超时) */
  private waitSettled(timeoutMs: number): Promise<void> {
    const waits = this.tracks
      .filter((t) => {
        const m = this.baseSession - t.offset
        return m >= 0 && m <= t.duration
      })
      .map(
        (t) =>
          new Promise<void>((resolve) => {
            if (!t.el.seeking && t.el.readyState >= 2) return resolve()
            const timer = setTimeout(done, timeoutMs)
            function done() {
              clearTimeout(timer)
              t.el.removeEventListener('seeked', done)
              t.el.removeEventListener('canplay', done)
              resolve()
            }
            t.el.addEventListener('seeked', done, { once: true })
            t.el.addEventListener('canplay', done, { once: true })
          }),
      )
    return Promise.all(waits).then(() => undefined)
  }

  pause(): void {
    this.playGen++
    if (!this.playing) return
    this.baseSession = this.sessionTime
    this.playing = false
    cancelAnimationFrame(this.raf)
    for (const t of this.tracks) t.el.pause()
    this.onTick?.(this.baseSession)
  }

  seek(t: number): void {
    const clamped = Math.max(this.sessionStart, Math.min(this.sessionEnd, t))
    this.baseSession = clamped
    this.basePerf = performance.now()
    for (const tr of this.tracks) this.syncTrack(tr, true)
    this.onTick?.(clamped)
  }

  setRate(r: number): void {
    if (this.playing) {
      this.baseSession = this.sessionTime
      this.basePerf = performance.now()
    }
    this.rate = r
    for (const t of this.tracks) t.el.playbackRate = r
  }

  /** 应用"哪一路出声"到各元素 */
  applyAudioRouting(): void {
    for (const t of this.tracks) {
      t.el.muted = t.id !== this.audioSourceId
    }
  }

  private syncTrack(t: Track, hard: boolean): void {
    const m = this.baseSessionAtNow() - t.offset
    const active = m >= 0 && m <= t.duration
    if (!active) {
      if (!t.el.paused) t.el.pause()
      return
    }
    const target = m + (this.comp.get(t.id) ?? 0)
    if (hard || Math.abs(t.el.currentTime - target) > 0.035) {
      t.el.currentTime = Math.max(0, Math.min(t.duration - 0.001, target))
      this.lastHardSeek.set(t.id, performance.now())
    }
    t.el.playbackRate = this.rate
    if (this.playing && t.el.paused) void t.el.play().catch(() => {})
  }

  private baseSessionAtNow(): number {
    return this.playing
      ? this.baseSession + ((performance.now() - this.basePerf) / 1000) * this.rate
      : this.baseSession
  }

  private loop = (): void => {
    if (!this.playing) return
    const nowPerf = performance.now()
    const dt = Math.min(0.2, (nowPerf - (this.lastTickAt || nowPerf)) / 1000)
    this.lastTickAt = nowPerf
    const now = this.baseSessionAtNow()
    if (now >= this.sessionEnd) {
      this.pause()
      return
    }
    for (const t of this.tracks) {
      const m = now - t.offset
      const active = m >= 0 && m <= t.duration
      if (!active) {
        if (!t.el.paused) t.el.pause()
        this.drift.delete(t.id)
        continue
      }
      if (t.el.paused) {
        t.el.currentTime = m
        void t.el.play().catch(() => {})
        continue
      }
      if (t.el.seeking) {
        // seek 未落定: 不校正不学习, 并把冷却顺延到落定后
        this.lastHardSeek.set(t.id, nowPerf)
        this.drift.delete(t.id)
        continue
      }
      const raw = t.el.currentTime - m
      const sinceHard = nowPerf - (this.lastHardSeek.get(t.id) ?? -1e9)
      // 积分: 学习恒定管线延迟(seek 落定期间不学习, 限幅 ±200ms)
      let c = this.comp.get(t.id) ?? 0
      if (sinceHard > 400) {
        c = Math.max(-0.2, Math.min(0.2, c - raw * 0.6 * dt))
        this.comp.set(t.id, c)
      }
      const target = m + c
      const err = t.el.currentTime - target
      // 显示"补偿后残差"——即估算的感知音画误差
      this.drift.set(t.id, err)
      const ae = Math.abs(err)
      if (ae > 0.1 && sinceHard > 800) {
        // 严重偏离(软拉不回来量级): 硬校正, 长冷却防抖动
        t.el.currentTime = target
        this.lastHardSeek.set(t.id, nowPerf)
        if (t.el.playbackRate !== this.rate) t.el.playbackRate = this.rate
      } else if (ae > 0.01) {
        // 软拉回: 最多 ±20% 变速(每秒可追回 200ms)
        const corr = Math.max(-0.2, Math.min(0.2, err * 2.5))
        t.el.playbackRate = this.rate * (1 - corr)
      } else if (t.el.playbackRate !== this.rate) {
        t.el.playbackRate = this.rate
      }
    }
    this.onTick?.(now)
    this.raf = requestAnimationFrame(this.loop)
  }
}
