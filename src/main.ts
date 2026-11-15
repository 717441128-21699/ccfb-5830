import { AlignResult, BOOKMARK_COLORS, Bookmark, TRACK_COLORS, Track, formatTime, nextId } from './types'
import { SyncEngine } from './sync'
import { Timeline } from './timeline'
import { autoAlign } from './audio'
import { exportPiP } from './export'

// ---------- 状态 ----------
const tracks: Track[] = []
let bookmarks: Bookmark[] = []
let mainTrackId: string | null = null
let selection: { in: number; out: number } | null = null
let exportAbort: AbortController | null = null

const engine = new SyncEngine()

// ---------- DOM ----------
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T
const fileInput = $('#file-input') as HTMLInputElement
const mainView = $('#main-view')
const pipRow = $('#pip-row')
const clockEl = $('#clock')
const trackListEl = $('#track-list')
const bookmarkListEl = $('#bookmark-list')
const alignReportEl = $('#align-report')
const audioSourceSel = $('#audio-source') as HTMLSelectElement
const rateSel = $('#playback-rate') as HTMLSelectElement
const btnPlay = $('#btn-play') as HTMLButtonElement
const btnExport = $('#btn-export') as HTMLButtonElement
const exportProgress = $('#export-progress')
const exportBar = $('#export-bar') as HTMLProgressElement
const exportStatus = $('#export-status')

const timeline = new Timeline($('#timeline') as HTMLCanvasElement, {
  getTracks: () => tracks,
  getBookmarks: () => bookmarks,
  getSelection: () => selection,
  getSessionTime: () => engine.sessionTime,
  onSeek: (t) => engine.seek(t),
  onOffsetChange: (track, offset, final) => {
    track.offset = offset
    engine.seek(engine.sessionTime) // 重新对位
    renderTrackList()
    timeline.redraw()
    if (final) persist()
  },
  onBookmarkClick: (b) => engine.seek(b.time),
})

// ---------- 持久化(按素材组合签名) ----------
function signature(): string {
  return tracks.map((t) => `${t.name}:${t.duration.toFixed(2)}`).sort().join('|')
}
function persist(): void {
  if (!tracks.length) return
  try {
    localStorage.setItem(
      `mcr:${signature()}`,
      JSON.stringify({
        offsets: Object.fromEntries(tracks.map((t) => [t.name, t.offset])),
        bookmarks,
        selection,
        mainTrackId,
        audioSourceId: engine.audioSourceId,
      }),
    )
  } catch { /* 存储不可用时静默 */ }
}
function restore(): void {
  try {
    const raw = localStorage.getItem(`mcr:${signature()}`)
    if (!raw) return
    const s = JSON.parse(raw)
    for (const t of tracks) if (t.name in (s.offsets ?? {})) t.offset = s.offsets[t.name]
    bookmarks = (s.bookmarks ?? []).map((b: Bookmark) => ({ ...b }))
    selection = s.selection ?? null
    mainTrackId = tracks.some((t) => t.id === s.mainTrackId) ? s.mainTrackId : mainTrackId
    if (tracks.some((t) => t.id === s.audioSourceId)) engine.audioSourceId = s.audioSourceId
  } catch { /* 损坏则忽略 */ }
}

// ---------- 素材载入 ----------
async function addFiles(files: File[]): Promise<void> {
  for (const file of files) {
    const isVideo = file.type.startsWith('video') || /\.(mp4|mov|m4v|mkv|webm)$/i.test(file.name)
    const isAudio = file.type.startsWith('audio') || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name)
    if (!isVideo && !isAudio) continue
    const url = URL.createObjectURL(file)
    const el = document.createElement(isVideo ? 'video' : 'audio') as HTMLVideoElement
    el.src = url
    el.preload = 'auto'
    el.playsInline = true
    el.muted = true
    await new Promise<void>((resolve, reject) => {
      el.onloadedmetadata = () => resolve()
      el.onerror = () => reject(new Error(`无法解码: ${file.name}`))
    })
    const track: Track = {
      id: nextId('trk'),
      name: file.name.replace(/\.[^.]+$/, ''),
      kind: isVideo ? 'video' : 'audio',
      url,
      file,
      duration: el.duration,
      offset: 0,
      el,
      color: TRACK_COLORS[tracks.length % TRACK_COLORS.length],
      width: el.videoWidth || 0,
      height: el.videoHeight || 0,
    }
    tracks.push(track)
  }
  afterTracksChanged(true)
}

function afterTracksChanged(firstLoad = false): void {
  engine.setTracks(tracks)
  if (!engine.audioSourceId || !tracks.some((t) => t.id === engine.audioSourceId)) {
    // 默认出声: 优先纯音频轨(录音笔), 否则第一路
    engine.audioSourceId = (tracks.find((t) => t.kind === 'audio') ?? tracks[0])?.id ?? null
  }
  if (!mainTrackId || !tracks.some((t) => t.id === mainTrackId && t.kind === 'video')) {
    mainTrackId = tracks.find((t) => t.kind === 'video')?.id ?? null
  }
  if (firstLoad) restore()
  if (!selection && tracks.length) {
    selection = { in: engine.sessionStart, out: engine.sessionEnd }
  }
  engine.applyAudioRouting()
  engine.seek(engine.sessionTime)
  renderAll()
  timeline.fit()
  persist()
}

// ---------- 渲染: 舞台 ----------
function renderStage(): void {
  mainView.innerHTML = ''
  pipRow.innerHTML = ''
  const main = tracks.find((t) => t.id === mainTrackId && t.kind === 'video')
  if (!main) {
    mainView.className = 'main-view empty'
    mainView.innerHTML = '<span class="hint">导入素材后,点击小窗切换主画面</span>'
  } else {
    mainView.className = 'main-view'
    main.el.className = 'stage-video'
    mainView.appendChild(main.el)
    const tag = document.createElement('div')
    tag.className = 'stage-tag'
    tag.style.borderColor = main.color
    tag.textContent = `主画面 · ${main.name}`
    mainView.appendChild(tag)
  }
  for (const t of tracks) {
    if (t.id === mainTrackId) continue
    const card = document.createElement('div')
    card.className = 'pip'
    card.style.borderColor = t.color
    if (t.kind === 'video') {
      t.el.className = 'pip-video'
      card.appendChild(t.el)
      card.title = '点击提升为主画面'
      card.onclick = () => {
        mainTrackId = t.id
        renderStage()
        persist()
      }
    } else {
      card.classList.add('pip-audio')
      card.innerHTML = `<div class="pip-audio-icon">♪</div><div class="pip-audio-name">${t.name}</div><div class="pip-audio-time" data-time-for="${t.id}">--:--</div>`
    }
    const label = document.createElement('div')
    label.className = 'pip-label'
    label.textContent = t.name
    card.appendChild(label)
    pipRow.appendChild(card)
  }
}

// ---------- 渲染: 轨道面板 ----------
function renderTrackList(): void {
  trackListEl.innerHTML = ''
  for (const t of tracks) {
    const card = document.createElement('div')
    card.className = 'track-card'
    card.style.borderLeftColor = t.color
    card.innerHTML = `
      <div class="track-head">
        <span class="track-kind">${t.kind === 'video' ? '▣ 视频' : '♪ 音频'}</span>
        <span class="track-name" title="${t.name}">${t.name}</span>
        <button class="btn tiny danger" data-act="remove">✕</button>
      </div>
      <div class="track-meta">${t.kind === 'video' ? `${t.width}×${t.height} · ` : ''}时长 ${formatTime(t.duration)} · 漂移 <span class="drift" data-drift="${t.id}">—</span></div>
      <div class="offset-row">
        <span class="offset-val" data-offset="${t.id}">${t.offset >= 0 ? '+' : ''}${t.offset.toFixed(3)}s</span>
        <div class="offset-btns">
          <button class="btn tiny" data-nudge="-0.1">−100ms</button>
          <button class="btn tiny" data-nudge="-0.01">−10ms</button>
          <button class="btn tiny" data-nudge="${-1 / 30}">−1帧</button>
          <button class="btn tiny" data-nudge="${1 / 30}">+1帧</button>
          <button class="btn tiny" data-nudge="0.01">+10ms</button>
          <button class="btn tiny" data-nudge="0.1">+100ms</button>
        </div>
      </div>
      <div class="track-actions">
        <button class="btn tiny" data-act="zero">设为基准(归零)</button>
        ${t.kind === 'video' ? '<button class="btn tiny" data-act="main">设为主画面</button>' : ''}
        <button class="btn tiny" data-act="audio">由此出声</button>
      </div>`
    card.querySelectorAll('[data-nudge]').forEach((b) =>
      b.addEventListener('click', () => {
        t.offset = Math.round((t.offset + parseFloat((b as HTMLElement).dataset.nudge!)) * 1000) / 1000
        engine.seek(engine.sessionTime)
        renderTrackList()
        timeline.redraw()
        persist()
      }),
    )
    card.querySelector('[data-act="remove"]')!.addEventListener('click', () => {
      t.el.pause()
      URL.revokeObjectURL(t.url)
      tracks.splice(tracks.indexOf(t), 1)
      afterTracksChanged()
    })
    card.querySelector('[data-act="zero"]')!.addEventListener('click', () => {
      const d = t.offset
      for (const x of tracks) x.offset = Math.round((x.offset - d) * 1000) / 1000
      engine.seek(engine.sessionTime)
      renderTrackList()
      timeline.redraw()
      persist()
    })
    card.querySelector('[data-act="main"]')?.addEventListener('click', () => {
      mainTrackId = t.id
      renderStage()
      persist()
    })
    card.querySelector('[data-act="audio"]')!.addEventListener('click', () => {
      engine.audioSourceId = t.id
      engine.applyAudioRouting()
      renderAudioSource()
      persist()
    })
    trackListEl.appendChild(card)
  }
}

// ---------- 渲染: 书签 ----------
function renderBookmarks(): void {
  bookmarkListEl.innerHTML = ''
  const sorted = [...bookmarks].sort((a, b) => a.time - b.time)
  if (!sorted.length) {
    bookmarkListEl.innerHTML = '<div class="dim">播放中按 B 或点"＋当前时间"打书签</div>'
    return
  }
  for (const b of sorted) {
    const row = document.createElement('div')
    row.className = 'bookmark-row'
    row.innerHTML = `
      <span class="bm-dot" style="background:${b.color}"></span>
      <button class="bm-time" title="跳转">${formatTime(b.time)}</button>
      <input class="bm-text" type="text" placeholder="备注…" value="${b.text.replace(/"/g, '&quot;')}" />
      <button class="btn tiny danger">✕</button>`
    row.querySelector('.bm-time')!.addEventListener('click', () => engine.seek(b.time))
    row.querySelector('.bm-text')!.addEventListener('input', (e) => {
      b.text = (e.target as HTMLInputElement).value
      persist()
    })
    row.querySelector('.danger')!.addEventListener('click', () => {
      bookmarks = bookmarks.filter((x) => x.id !== b.id)
      renderBookmarks()
      timeline.redraw()
      persist()
    })
    bookmarkListEl.appendChild(row)
  }
}

function addBookmark(): void {
  if (!tracks.length) return
  bookmarks.push({
    id: nextId('bm'),
    time: Math.round(engine.sessionTime * 1000) / 1000,
    text: '',
    color: BOOKMARK_COLORS[bookmarks.length % BOOKMARK_COLORS.length],
  })
  renderBookmarks()
  timeline.redraw()
  persist()
  const inputs = bookmarkListEl.querySelectorAll('.bm-text')
  ;(inputs[inputs.length - 1] as HTMLInputElement | undefined)?.focus()
}

// ---------- 渲染: 其它 ----------
function renderAudioSource(): void {
  audioSourceSel.innerHTML = tracks.map((t) => `<option value="${t.id}">${t.name}</option>`).join('')
  if (engine.audioSourceId) audioSourceSel.value = engine.audioSourceId
}

function renderSelection(): void {
  $('#sel-in').textContent = selection ? formatTime(selection.in) : '—'
  $('#sel-out').textContent = selection ? formatTime(selection.out) : '—'
}

function renderAll(): void {
  renderStage()
  renderTrackList()
  renderBookmarks()
  renderAudioSource()
  renderSelection()
  const has = tracks.length > 0
  for (const id of ['btn-play', 'btn-back5', 'btn-fwd5', 'btn-set-in', 'btn-set-out', 'btn-clear-sel', 'btn-add-bookmark']) {
    ;(document.getElementById(id) as HTMLButtonElement).disabled = !has
  }
  ;($('#btn-auto-align') as HTMLButtonElement).disabled = tracks.length < 2
  btnExport.disabled = !tracks.some((t) => t.kind === 'video')
  timeline.redraw()
}

// ---------- 主时钟 → UI ----------
engine.onTick = (t) => {
  timeline.redraw()
  clockEl.textContent = formatTime(t)
  btnPlay.textContent = engine.isPlaying ? '⏸' : '▶'
  for (const tr of tracks) {
    const el = document.querySelector(`[data-drift="${tr.id}"]`)
    if (el) {
      const d = engine.drift.get(tr.id)
      el.textContent = d === undefined ? '—' : `${(d * 1000).toFixed(0)}ms`
      el.classList.toggle('warn', d !== undefined && Math.abs(d) > 0.04)
    }
    const timeEl = document.querySelector(`[data-time-for="${tr.id}"]`)
    if (timeEl) timeEl.textContent = formatTime(Math.max(0, t - tr.offset), false)
  }
}

// ---------- 事件 ----------
fileInput.addEventListener('change', async () => {
  const files = [...(fileInput.files ?? [])]
  fileInput.value = ''
  try {
    await addFiles(files)
  } catch (e) {
    alert(String(e))
  }
})

$('#btn-load-demo').addEventListener('click', async () => {
  const names = ['cam1.mp4', 'cam2.mp4', 'cam3.mp4', 'recorder.m4a']
  try {
    const files = await Promise.all(
      names.map(async (n) => {
        const r = await fetch(`${import.meta.env.BASE_URL}sample-media/${n}`)
        if (!r.ok) throw new Error(`示例素材缺失: ${n}(先运行 scripts/make_sample_media.sh)`)
        return new File([await r.blob()], n, { type: n.endsWith('.mp4') ? 'video/mp4' : 'audio/mp4' })
      }),
    )
    await addFiles(files)
  } catch (e) {
    alert(String(e))
  }
})

$('#btn-auto-align').addEventListener('click', async () => {
  const btn = $('#btn-auto-align') as HTMLButtonElement
  btn.disabled = true
  alignReportEl.classList.remove('dim')
  try {
    const results = await autoAlign(tracks, (msg) => (alignReportEl.textContent = msg))
    for (const r of results) {
      const t = tracks.find((x) => x.id === r.trackId)!
      t.offset = Math.round(r.offset * 1000) / 1000
    }
    engine.seek(engine.sessionTime)
    alignReportEl.innerHTML = results
      .map((r: AlignResult) => {
        const t = tracks.find((x) => x.id === r.trackId)!
        const conf = r.confidence === Infinity ? '基准' : r.confidence > 8 ? '可靠' : r.confidence > 3 ? '偏弱' : '不可信'
        return `<div>${t.name}: <b>${r.offset >= 0 ? '+' : ''}${r.offset.toFixed(3)}s</b> <span class="dim">(峰 ${r.peak.toFixed(3)}, ${conf})</span></div>`
      })
      .join('')
    renderTrackList()
    timeline.fit()
    persist()
  } catch (e) {
    alignReportEl.textContent = `对齐失败: ${e instanceof Error ? e.message : e}`
  } finally {
    btn.disabled = false
  }
})

btnPlay.addEventListener('click', () => (engine.isPlaying ? engine.pause() : engine.play()))
$('#btn-back5').addEventListener('click', () => engine.seek(engine.sessionTime - 5))
$('#btn-fwd5').addEventListener('click', () => engine.seek(engine.sessionTime + 5))
rateSel.addEventListener('change', () => engine.setRate(parseFloat(rateSel.value)))
audioSourceSel.addEventListener('change', () => {
  engine.audioSourceId = audioSourceSel.value
  engine.applyAudioRouting()
  persist()
})
$('#btn-add-bookmark').addEventListener('click', addBookmark)

$('#btn-set-in').addEventListener('click', () => {
  selection = { in: engine.sessionTime, out: Math.max(selection?.out ?? 0, engine.sessionTime + 1) }
  renderSelection()
  timeline.redraw()
  persist()
})
$('#btn-set-out').addEventListener('click', () => {
  selection = { in: Math.min(selection?.in ?? 0, engine.sessionTime - 1), out: engine.sessionTime }
  renderSelection()
  timeline.redraw()
  persist()
})
$('#btn-clear-sel').addEventListener('click', () => {
  selection = null
  renderSelection()
  timeline.redraw()
  persist()
})

btnExport.addEventListener('click', async () => {
  const sel = selection ?? { in: engine.sessionStart, out: engine.sessionEnd }
  exportAbort = new AbortController()
  exportProgress.hidden = false
  btnExport.disabled = true
  try {
    const blob = await exportPiP({
      tracks,
      mainTrackId: mainTrackId ?? tracks.find((t) => t.kind === 'video')!.id,
      audioTrackId: engine.audioSourceId,
      inT: sel.in,
      outT: sel.out,
      fps: 30,
      width: 1280,
      height: 720,
      onProgress: (f, msg) => {
        exportBar.value = f
        exportStatus.textContent = msg
      },
      signal: exportAbort.signal,
    })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `画中画合成_${formatTime(sel.in, false)}-${formatTime(sel.out, false)}.mp4`.replace(/:/g, '')
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') {
      exportStatus.textContent = '已取消'
    } else {
      exportStatus.textContent = `导出失败: ${e instanceof Error ? e.message : e}`
      console.error(e)
    }
    await new Promise((r) => setTimeout(r, 4000)) // 让用户看到状态
  } finally {
    exportProgress.hidden = true
    btnExport.disabled = false
    exportAbort = null
  }
})
$('#btn-export-cancel').addEventListener('click', () => exportAbort?.abort())

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return
  if (e.code === 'Space') {
    e.preventDefault()
    engine.isPlaying ? engine.pause() : engine.play()
  } else if (e.key === 'ArrowLeft') engine.seek(engine.sessionTime - (e.shiftKey ? 5 : 1))
  else if (e.key === 'ArrowRight') engine.seek(engine.sessionTime + (e.shiftKey ? 5 : 1))
  else if (e.key === 'b' || e.key === 'B') addBookmark()
  else if (e.key === '[') $('#btn-set-in').click()
  else if (e.key === ']') $('#btn-set-out').click()
})

renderAll()

// 调试 / 自动化测试钩子
;(window as unknown as { __app: unknown }).__app = {
  engine,
  tracks,
  setSelection: (a: number, b: number) => {
    selection = { in: a, out: b }
    renderSelection()
    timeline.redraw()
  },
}
