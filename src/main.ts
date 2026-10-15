import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { bridge } from './bridge'
import { fetchNote, fetchNoteList, GitHubError, type NoteEntry, type RepoConfig } from './github'
import { mdToGlasses } from './markdown'
import { paginateRows } from './layout'
import { listDir, noteName, parentDir, searchNotes } from './vault'
import * as glasses from './glasses'
import * as store from './storage'

// Draw something on the glasses before anything else (storage reads included),
// so a slow start never leaves the display empty.
await glasses.boot('Obsidian 리더\n\n불러오는 중...')

// The firmware list holds at most 20 items. A paged folder page uses up to 3 for
// navigation (top slot, ▲ previous, ▼ next), leaving 17 for entries.
const LIST_PAGE = 17
const MEM_CACHE_NOTES = 30

const SETUP_TEXT = 'Obsidian 리더\n\n휴대폰 Even 앱 화면에서\nGitHub 저장소를 설정하세요.\n\n더블탭: 종료'

type Action =
  | { kind: 'up' }
  | { kind: 'dir'; path: string }
  | { kind: 'note'; path: string }
  | { kind: 'page'; delta: number }
  | { kind: 'refresh' }

// 'message' = a plain text screen (setup, errors) drawn with the reader layout.
type Mode = 'message' | 'list' | 'reader'

let cfg: RepoConfig | null = null
let notes: NoteEntry[] = []
let reading: store.ReadingState = { dir: '', lastNote: null, open: null, pages: {} }
let mode: Mode = 'message'

// list screen
let listPage = 0
let listHeader = ''
let listLabels: string[] = []
let listActions: Action[] = []

// reader screen
let notePath: string | null = null
let pages: string[][] = []
let current = 0

// note loading
let openToken = 0
let loadingPath: string | null = null
const memCache = new Map<string, string>() // blob sha -> markdown, this session only

const cfgKey = (c: RepoConfig) => `${c.owner}/${c.repo}@${c.branch}:${c.root}`
const errText = (e: unknown) => (e instanceof GitHubError ? e.message : String(e))
const short = (s: string, max: number) => (Array.from(s).length > max ? Array.from(s).slice(0, max - 1).join('') + '…' : s)
const log = (e: unknown) => console.error(e)

// =====================================================================
// Screens
// =====================================================================

/** All entries of the current folder, before splitting into list pages. */
function folderEntries(): [string, Action][] {
  const { folders, notes: files } = listDir(notes, reading.dir)
  const all: [string, Action][] = []
  for (const f of folders) all.push([`▷ ${f.name} (${f.count})`, { kind: 'dir', path: f.path }])
  for (const n of files) all.push([noteName(n.path), { kind: 'note', path: n.path }])
  return all
}

const hasTopSlot = () => !!reading.dir || (!!reading.lastNote && notes.some(n => n.path === reading.lastNote))
const listPageCount = (entries: number) =>
  entries <= glasses.LIST_MAX_ITEMS - (hasTopSlot() ? 1 : 0) ? 1 : Math.ceil(entries / LIST_PAGE)

function showList() {
  mode = 'list'
  loadingPath = null
  const entries = folderEntries()
  const total = listPageCount(entries.length)
  listPage = Math.max(0, Math.min(listPage, total - 1))
  const from = total === 1 ? 0 : listPage * LIST_PAGE
  const slice = total === 1 ? entries : entries.slice(from, from + LIST_PAGE)

  const items: [string, Action][] = []
  // Fixed top slot: way out of this folder (or back into the last note at the root).
  if (reading.dir) items.push(['◀ 상위 폴더', { kind: 'up' }])
  else if (reading.lastNote && notes.some(n => n.path === reading.lastNote)) {
    items.push([`★ 이어 읽기: ${noteName(reading.lastNote)}`, { kind: 'note', path: reading.lastNote }])
  }
  if (listPage > 0) items.push([`▲ 이전 (${from - LIST_PAGE + 1}-${from} / ${entries.length})`, { kind: 'page', delta: -1 }])
  items.push(...slice)
  if (listPage < total - 1) {
    const nextTo = Math.min(entries.length, from + 2 * LIST_PAGE)
    items.push([`▼ 다음 (${from + LIST_PAGE + 1}-${nextTo} / ${entries.length})`, { kind: 'page', delta: 1 }])
  }
  if (!entries.length) items.push([notes.length ? '(빈 폴더)' : '(노트 없음) 다시 불러오기', { kind: 'refresh' }])

  listLabels = glasses.fitListItems(items.map(([label]) => label))
  listActions = items.slice(0, listLabels.length).map(([, a]) => a)
  const where = reading.dir ? reading.dir.split('/').slice(-2).join(' / ') : cfg?.root || cfg?.repo || '보관함'
  listHeader = `■ ${where}` + (total > 1 ? `   ${listPage + 1}/${total}쪽` : '')
  glasses.show({ kind: 'list', header: listHeader, items: listLabels })
  renderPhone()
}

/** Show the folder containing `path`, on the list page where `path` appears. */
function showListAround(path: string) {
  reading.dir = parentDir(path)
  const index = folderEntries().findIndex(([, a]) => (a.kind === 'note' || a.kind === 'dir') && a.path === path)
  const total = listPageCount(folderEntries().length)
  listPage = total === 1 || index < 0 ? 0 : Math.floor(index / LIST_PAGE)
  showList()
}

function setListHeader(text: string) {
  if (mode !== 'list') return
  glasses.show({ kind: 'list', header: text, items: listLabels })
}

function readerStatus() {
  if (!notePath) return ' '
  if (pages.length < 2) return short(noteName(notePath), 40)
  const pct = Math.floor(((current + 1) / pages.length) * 100)
  return `${short(noteName(notePath), 22)}   ${current + 1} / ${pages.length}   ${pct}%`
}

function showReader() {
  mode = 'reader'
  glasses.show({ kind: 'reader', rows: pages[current] ?? [], status: readerStatus() })
  renderPhone()
}

function showMessage(text: string) {
  mode = 'message'
  loadingPath = null
  glasses.show({ kind: 'message', text })
  renderPhone()
}

// =====================================================================
// Actions
// =====================================================================

function runAction(action: Action | undefined) {
  if (!action) return
  switch (action.kind) {
    case 'up':
      showListAround(reading.dir)
      break
    case 'dir':
      reading.dir = action.path
      listPage = 0
      showList()
      break
    case 'note':
      openNote(action.path)
      break
    case 'page':
      listPage += action.delta
      showList()
      break
    case 'refresh':
      refreshNotes(true)
      break
  }
  saveReadingSoon()
}

async function loadMarkdown(path: string): Promise<string> {
  const entry = notes.find(n => n.path === path)
  if (entry) {
    const hit = memCache.get(entry.sha) ?? (await store.loadCachedNote(entry.sha).catch(() => null))
    if (hit != null) return hit
  }
  const md = await fetchNote(cfg!, path)
  if (entry) {
    memCache.set(entry.sha, md)
    if (memCache.size > MEM_CACHE_NOTES) memCache.delete(memCache.keys().next().value!)
    store.cacheNote(entry.sha, md).catch(log) // background lane — never delays drawing
  }
  return md
}

async function openNote(path: string) {
  if (!cfg) return
  const token = ++openToken
  const name = noteName(path)
  loadingPath = path

  // Feedback without changing layout (layout changes are the slow, fragile
  // step): the list header, the reader's status line, or the message text.
  if (mode === 'list') setListHeader(`■ 여는 중: ${short(name, 30)}`)
  else if (mode === 'reader') glasses.show({ kind: 'reader', rows: pages[current] ?? [], status: `여는 중: ${short(name, 30)}` })
  else showMessage(`■ ${name}\n\n불러오는 중...`)

  let result: string[][]
  try {
    const md = await loadMarkdown(path)
    result = await paginateRows(mdToGlasses(md, name), glasses.LINE_W, glasses.LINES_PER_PAGE)
  } catch (e) {
    if (token !== openToken) return
    loadingPath = null
    showMessage(`■ ${name}\n불러오지 못했습니다.\n${errText(e)}\n더블탭: 목록으로`)
    return
  }
  if (token !== openToken) return // user went elsewhere meanwhile

  loadingPath = null
  notePath = path
  pages = result
  current = Math.min(reading.pages[path] ?? 0, pages.length - 1)
  reading.lastNote = path
  reading.open = path
  reading.dir = parentDir(path)
  saveReadingSoon()
  showReader()
}

function cancelLoading() {
  openToken++
  loadingPath = null
  if (mode === 'list') setListHeader(listHeader)
}

function turnPage(delta: number) {
  const next = Math.max(0, Math.min(pages.length - 1, current + delta))
  if (next === current) return
  current = next
  if (notePath) reading.pages[notePath] = current
  saveReadingSoon()
  showReader()
}

let exiting = false
function back() {
  if (loadingPath) {
    cancelLoading()
    return
  }
  if (mode === 'reader') {
    reading.open = null
    saveReadingSoon()
    showListAround(notePath!)
  } else if (mode === 'message' && notes.length) {
    showList()
  } else if (mode === 'list' && reading.dir) {
    showListAround(reading.dir)
  } else {
    // Root (or no vault yet): system exit dialog. If the user cancels it,
    // nothing tells us, so redraw our screen once the dialog is gone.
    glasses
      .exitApp()
      .then(() => setTimeout(() => !exiting && glasses.refresh(), 600))
      .catch(log)
  }
  saveReadingSoon()
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
function saveReadingSoon() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => store.saveReading(reading).catch(log), 1500)
}

// =====================================================================
// Glasses input
// =====================================================================

type Input =
  | { kind: 'double' }
  | { kind: 'select'; index: number; name?: string }
  | { kind: 'tap' }
  | { kind: 'up' }
  | { kind: 'down' }

// CLICK_EVENT is 0 and protobuf omits zero values, so a tap arrives with
// `eventType` undefined. Default it only when the envelope itself exists.
function typeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function parseInput(event: EvenHubEvent): Input | null {
  const sys = typeOf(event.sysEvent)
  const text = typeOf(event.textEvent)
  const list = typeOf(event.listEvent)
  const T = OsEventTypeList
  if (sys === T.DOUBLE_CLICK_EVENT || text === T.DOUBLE_CLICK_EVENT || list === T.DOUBLE_CLICK_EVENT) return { kind: 'double' }
  if (event.listEvent && list === T.CLICK_EVENT) {
    return { kind: 'select', index: event.listEvent.currentSelectItemIndex ?? 0, name: event.listEvent.currentSelectItemName }
  }
  if (text === T.SCROLL_TOP_EVENT) return { kind: 'up' }
  if (text === T.SCROLL_BOTTOM_EVENT) return { kind: 'down' }
  if (sys === T.CLICK_EVENT || text === T.CLICK_EVENT) return { kind: 'tap' }
  return null
}

// One gesture can reach us more than once (e.g. through two envelopes), and a
// double-tap can be trailed by a stray tap. Drop those echoes.
let lastInput = { kind: '', at: -Infinity }
function isEcho(kind: string) {
  const now = performance.now()
  const since = now - lastInput.at
  if (lastInput.kind === 'double' && since < 500) return true
  if (kind === lastInput.kind && since < (kind === 'double' ? 800 : 180)) return true
  lastInput = { kind, at: now }
  return false
}

function handleInput(input: Input) {
  if (input.kind === 'double') {
    back()
    return
  }
  if (mode === 'list' && input.kind === 'select') {
    // Match by the label the firmware echoes back; fall back to the index.
    const byName = input.name ? listLabels.indexOf(input.name) : -1
    runAction(listActions[byName >= 0 ? byName : input.index])
    return
  }
  if (mode === 'reader') {
    if (input.kind === 'up') turnPage(-1)
    else if (input.kind === 'down' || input.kind === 'tap') turnPage(1)
  }
}

bridge.onEvenHubEvent(event => {
  logEvent(event)
  const sys = typeOf(event.sysEvent)
  switch (sys) {
    case OsEventTypeList.SYSTEM_EXIT_EVENT:
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      exiting = true
      store.saveReading(reading).catch(log)
      return
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      store.saveReading(reading).catch(log)
      return
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      glasses.refresh() // the display may have been taken over while we were away
      return
  }

  const input = parseInput(event)
  if (!input) return
  // Input during a layout change was aimed at the previous screen.
  if (glasses.inputBlocked()) return
  if (isEcho(input.kind)) return
  handleInput(input)
})

// =====================================================================
// Loading the vault
// =====================================================================

let refreshing = false
async function refreshNotes(showErrorsOnGlasses: boolean) {
  if (!cfg || refreshing) return
  refreshing = true
  setStatus('노트 목록을 불러오는 중...')
  try {
    const { notes: fresh, truncated } = await fetchNoteList(cfg)
    const changed = fresh.length !== notes.length || fresh.some((n, i) => n.sha !== notes[i]?.sha || n.path !== notes[i]?.path)
    notes = fresh
    setStatus(truncated ? '저장소가 너무 커서 일부 노트만 불러왔습니다.' : '')
    if (mode === 'message' && !loadingPath) showList()
    else if (mode === 'list' && changed && !loadingPath) showList()
    else renderPhone()
    if (changed) store.saveNoteList({ key: cfgKey(cfg), fetchedAt: Date.now(), truncated, notes }).catch(log)
  } catch (e) {
    setStatus(`목록을 불러오지 못했습니다: ${errText(e)}`)
    if (showErrorsOnGlasses && !notes.length) {
      showMessage(`노트 목록을 불러오지 못했습니다.\n${errText(e)}\n휴대폰에서 설정을 확인하세요.\n더블탭: 종료`)
    }
  } finally {
    refreshing = false
    updateListInfo()
  }
}

async function connect(next: RepoConfig) {
  setStatus('연결 확인 중...')
  try {
    const { notes: fresh, truncated } = await fetchNoteList(next)
    const sameRepo = cfg && cfgKey(cfg) === cfgKey(next)
    cfg = next
    notes = fresh
    if (!sameRepo) reading = { dir: '', lastNote: null, open: null, pages: {} }
    listPage = 0
    showList()
    setStatus(`연결되었습니다. 노트 ${notes.length}개`)
    settingsBox.open = false
    await store.saveConfig(cfg)
    await store.saveReading(reading)
    await store.saveNoteList({ key: cfgKey(cfg), fetchedAt: Date.now(), truncated, notes })
  } catch (e) {
    setStatus(`연결 실패: ${errText(e)}`)
  }
  updateListInfo()
}

// =====================================================================
// Phone UI
// =====================================================================

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <main class="wrap">
    <header class="top">
      <h1>Obsidian 리더</h1>
      <button id="refresh" class="btn">새로고침</button>
    </header>
    <div id="status" class="status"></div>

    <section class="card">
      <input id="search" type="search" placeholder="노트 이름 검색" autocomplete="off" />
      <div id="listInfo" class="muted"></div>
      <ul id="results" class="results"></ul>
    </section>

    <section class="card">
      <div class="row">
        <div id="noteTitle" class="name">열린 노트 없음</div>
        <button id="toList" class="btn small">목록으로</button>
      </div>
      <pre id="mirror" class="mirror"></pre>
      <nav class="nav">
        <button id="prev" class="btn">◀ 이전</button>
        <span id="pageCount" class="count"></span>
        <button id="next" class="btn">다음 ▶</button>
      </nav>
    </section>

    <details id="settings" class="card">
      <summary>GitHub 저장소 설정</summary>
      <form id="cfgForm" class="form">
        <label>저장소 주소 또는 이름
          <input name="repo" placeholder="https://github.com/아이디/저장소 또는 아이디/저장소" required autocomplete="off" />
        </label>
        <label>브랜치
          <input name="branch" placeholder="main" autocomplete="off" />
        </label>
        <label>보관함 폴더 (저장소 안의 하위 폴더일 때만)
          <input name="root" placeholder="비워 두면 저장소 전체" autocomplete="off" />
        </label>
        <label>토큰 (비공개 저장소일 때)
          <input name="token" type="password" placeholder="github_pat_..." autocomplete="off" />
        </label>
        <p class="muted">토큰은 GitHub → Settings → Developer settings → Fine-grained tokens에서 이 저장소만, Contents 읽기 권한으로 만드세요. 토큰은 이 휴대폰의 Even 앱 안에만 저장됩니다.</p>
        <button class="btn primary" type="submit">저장하고 연결</button>
      </form>
    </details>

    <details id="diag" class="card">
      <summary>진단 정보 (문제 신고용)</summary>
      <pre id="diagText" class="mirror diag"></pre>
    </details>

    <footer class="muted">안경: 목록에서 탭으로 열기 · 노트에서 탭/아래 스와이프 다음, 위 스와이프 이전 · 더블탭 뒤로</footer>
  </main>
`

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const settingsBox = $<HTMLDetailsElement>('settings')
const form = $<HTMLFormElement>('cfgForm')
const searchInput = $<HTMLInputElement>('search')

function setStatus(msg: string) {
  $('status').textContent = msg
}

function updateListInfo() {
  $('listInfo').textContent = cfg ? `${cfg.owner}/${cfg.repo} · 노트 ${notes.length}개` : ''
}

function renderResults() {
  const ul = $('results')
  ul.innerHTML = ''
  for (const n of searchNotes(notes, searchInput.value, 50)) {
    const li = document.createElement('li')
    const btn = document.createElement('button')
    btn.className = 'result'
    btn.innerHTML = `<span class="rname"></span><span class="rpath"></span>`
    btn.querySelector('.rname')!.textContent = noteName(n.path)
    btn.querySelector('.rpath')!.textContent = parentDir(n.path) || '/'
    btn.addEventListener('click', () => openNote(n.path))
    li.appendChild(btn)
    ul.appendChild(li)
  }
}

function renderPhone() {
  const reader = mode === 'reader' && notePath
  $('noteTitle').textContent = reader ? noteName(notePath!) : '열린 노트 없음'
  $('mirror').textContent = reader ? pages[current]?.join('\n') ?? '' : '안경 목록이나 위 검색에서 노트를 고르세요.'
  $('pageCount').textContent = reader ? `${current + 1} / ${pages.length}` : ''
}

// Diagnostics: recent raw glasses events and render errors, so a problem on
// the glasses can be reported precisely.
const eventLog: string[] = []
function logEvent(event: EvenHubEvent) {
  const t = new Date().toLocaleTimeString()
  eventLog.push(`${t} [${mode}] ${JSON.stringify({ sys: event.sysEvent, text: event.textEvent, list: event.listEvent })}`)
  if (eventLog.length > 15) eventLog.shift()
  renderDiag()
}
function renderDiag() {
  if (!$<HTMLDetailsElement>('diag').open) return
  $('diagText').textContent = [
    `startup: ${glasses.startupResult}  mode: ${mode}  dir: ${reading.dir || '/'}  listPage: ${listPage}`,
    '--- 화면 오류',
    ...glasses.errors,
    '--- 최근 입력',
    ...eventLog,
  ].join('\n')
}
$('diag').addEventListener('toggle', renderDiag)

function parseRepo(input: string): { owner: string; repo: string } | null {
  const m = input.trim().replace(/\.git$/, '').match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+)\/?$/)
  return m ? { owner: m[1], repo: m[2] } : null
}

form.addEventListener('submit', e => {
  e.preventDefault()
  const data = new FormData(form)
  const parsed = parseRepo(String(data.get('repo') ?? ''))
  if (!parsed) {
    setStatus('저장소 주소를 확인하세요. 예: https://github.com/아이디/저장소')
    return
  }
  connect({
    ...parsed,
    branch: String(data.get('branch') ?? '').trim() || 'main',
    root: String(data.get('root') ?? '').trim().replace(/^\/+|\/+$/g, ''),
    token: String(data.get('token') ?? '').trim(),
  })
})

searchInput.addEventListener('input', renderResults)
$('refresh').addEventListener('click', () => refreshNotes(false))
$('prev').addEventListener('click', () => mode === 'reader' && turnPage(-1))
$('next').addEventListener('click', () => mode === 'reader' && turnPage(1))
$('toList').addEventListener('click', () => mode === 'reader' && back())

function fillForm(c: RepoConfig) {
  ;(form.elements.namedItem('repo') as HTMLInputElement).value = `${c.owner}/${c.repo}`
  ;(form.elements.namedItem('branch') as HTMLInputElement).value = c.branch
  ;(form.elements.namedItem('root') as HTMLInputElement).value = c.root
  ;(form.elements.namedItem('token') as HTMLInputElement).value = c.token
}

// =====================================================================
// Startup
// =====================================================================

cfg = await store.loadConfig()
reading = { ...(await store.loadReading()) }
reading.open ??= null

if (!cfg) {
  settingsBox.open = true
  showMessage(SETUP_TEXT)
  // Dev-only: `?demo` pre-fills Obsidian's public help vault for testing.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('demo')) {
    fillForm({ owner: 'obsidianmd', repo: 'obsidian-help', branch: 'master', root: 'en', token: '' })
  }
} else {
  fillForm(cfg)
  const cached = await store.loadNoteList().catch(() => null)
  if (cached && cached.key === cfgKey(cfg)) {
    notes = cached.notes
    // Reopen the note that was on screen when the app was last closed or backgrounded.
    if (reading.open && notes.some(n => n.path === reading.open)) openNote(reading.open)
    else showList()
    refreshNotes(false) // update in the background
  } else {
    showMessage('노트 목록을 불러오는 중...')
    refreshNotes(true)
  }
}
updateListInfo()
renderPhone()
