import { OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { bridge } from './bridge'
import { fetchNote, fetchNoteList, GitHubError, type NoteEntry, type RepoConfig } from './github'
import { mdToGlasses } from './markdown'
import { paginate } from './paginate'
import { listDir, noteName, parentDir, searchNotes } from './vault'
import { BODY_H, BODY_PAD, BODY_W, exitApp, showList, showReader } from './glasses'
import * as store from './storage'

const INNER = { width: BODY_W - 2 * BODY_PAD, height: BODY_H - 2 * BODY_PAD }
const LIST_PAGE = 18 // items per list page when a folder has more than 20 entries

const SETUP_TEXT = [
  'Obsidian 리더',
  '',
  '휴대폰 Even 앱 화면에서',
  'GitHub 저장소를 설정하세요.',
  '',
  '더블탭: 종료',
].join('\n')

type Action =
  | { kind: 'up' }
  | { kind: 'dir'; path: string }
  | { kind: 'note'; path: string }
  | { kind: 'prevPage' }
  | { kind: 'nextPage' }
  | { kind: 'refresh' }

// 'message' = a plain text screen (setup, loading, errors) on the reader layout.
type Mode = 'message' | 'list' | 'reader'

let cfg: RepoConfig | null = null
let notes: NoteEntry[] = []
let reading: store.ReadingState = { dir: '', lastNote: null, pages: {} }
let mode: Mode = 'message'

let listPage = 0
let actions: Action[] = []

let notePath: string | null = null
let pages: string[] = []
let current = 0
let openToken = 0

const cfgKey = (c: RepoConfig) => `${c.owner}/${c.repo}@${c.branch}:${c.root}`
const errText = (e: unknown) => (e instanceof GitHubError ? e.message : String(e))
const clip = (s: string, max: number) => (Array.from(s).length > max ? Array.from(s).slice(0, max - 1).join('') + '…' : s)
const log = (e: unknown) => console.error(e)

// ---------- glasses: folder list ----------

function renderList() {
  mode = 'list'
  const { folders, notes: files } = listDir(notes, reading.dir)
  const all: [string, Action][] = []

  if (reading.dir) all.push(['◀ 상위 폴더', { kind: 'up' }])
  else if (reading.lastNote && notes.some(n => n.path === reading.lastNote)) {
    all.push([`★ 이어 읽기: ${noteName(reading.lastNote)}`, { kind: 'note', path: reading.lastNote }])
  }
  for (const f of folders) all.push([`▷ ${f.name} (${f.count})`, { kind: 'dir', path: f.path }])
  for (const n of files) all.push([noteName(n.path), { kind: 'note', path: n.path }])
  if (!folders.length && !files.length) all.push(['(노트 없음) 다시 불러오기', { kind: 'refresh' }])

  const totalPages = all.length <= 20 ? 1 : Math.ceil(all.length / LIST_PAGE)
  listPage = Math.max(0, Math.min(listPage, totalPages - 1))
  const slice = totalPages === 1 ? all : all.slice(listPage * LIST_PAGE, (listPage + 1) * LIST_PAGE)
  if (listPage > 0) slice.unshift(['▲ 이전 목록', { kind: 'prevPage' }])
  if (listPage < totalPages - 1) slice.push(['▼ 다음 목록', { kind: 'nextPage' }])

  actions = slice.map(([, a]) => a)
  const where = reading.dir ? reading.dir.split('/').slice(-2).join(' / ') : cfg?.root || cfg?.repo || '보관함'
  const header = `■ ${where}` + (totalPages > 1 ? `   ${listPage + 1}/${totalPages}` : '')
  showList(header, slice.map(([label]) => label)).catch(log)
  renderPhone()
}

function runAction(action: Action | undefined) {
  if (!action) return
  switch (action.kind) {
    case 'up':
      goToDir(parentDir(reading.dir))
      break
    case 'dir':
      goToDir(action.path)
      break
    case 'note':
      openNote(action.path)
      break
    case 'prevPage':
      listPage--
      renderList()
      break
    case 'nextPage':
      listPage++
      renderList()
      break
    case 'refresh':
      refreshNotes(true)
      break
  }
}

function goToDir(dir: string) {
  reading.dir = dir
  listPage = 0
  saveReadingSoon()
  renderList()
}

// ---------- glasses: reader ----------

function readerStatus() {
  if (!notePath || pages.length < 2) return notePath ? clip(noteName(notePath), 40) : ' '
  const pct = Math.floor(((current + 1) / pages.length) * 100)
  return `${clip(noteName(notePath), 22)}   ${current + 1} / ${pages.length}   ${pct}%`
}

function renderReader() {
  mode = 'reader'
  showReader(pages[current] ?? '', readerStatus()).catch(log)
  renderPhone()
}

function showMessage(text: string) {
  mode = 'message'
  showReader(text, ' ').catch(log)
}

async function openNote(path: string) {
  if (!cfg) return
  const token = ++openToken
  const name = noteName(path)
  notePath = path
  pages = [`■ ${name}\n\n불러오는 중...`]
  current = 0
  renderReader()

  try {
    const entry = notes.find(n => n.path === path)
    let md = entry ? await store.loadCachedNote(entry.sha).catch(() => null) : null
    if (md == null) {
      md = await fetchNote(cfg, path)
      if (entry) store.cacheNote(entry.sha, md).catch(log)
    }
    const result = await paginate(mdToGlasses(md, name), INNER)
    if (token !== openToken) return
    pages = result
    current = Math.min(reading.pages[path] ?? 0, pages.length - 1)
    reading.lastNote = path
    reading.dir = parentDir(path)
    saveReadingSoon()
  } catch (e) {
    if (token !== openToken) return
    pages = [`■ ${name}\n\n불러오지 못했습니다.\n${errText(e)}\n\n더블탭: 목록으로`]
    current = 0
  }
  renderReader()
}

function turnPage(delta: number) {
  const next = Math.max(0, Math.min(pages.length - 1, current + delta))
  if (next === current) return
  current = next
  if (notePath) reading.pages[notePath] = current
  saveReadingSoon()
  renderReader()
}

function back() {
  if (mode === 'reader') {
    openToken++ // cancel a note that is still loading
    listPage = 0
    renderList()
  } else if (mode === 'list' && reading.dir) {
    goToDir(parentDir(reading.dir))
  } else {
    exitApp().catch(log)
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
function saveReadingSoon() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => store.saveReading(reading).catch(log), 800)
}

// ---------- glasses: input ----------

// CLICK_EVENT is 0 and protobuf omits zero values, so a tap arrives with
// `eventType` undefined. Default it only when the envelope itself exists.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

bridge.onEvenHubEvent(event => {
  const sys = eventTypeOf(event.sysEvent)
  const text = eventTypeOf(event.textEvent)
  const list = eventTypeOf(event.listEvent)
  const D = OsEventTypeList.DOUBLE_CLICK_EVENT

  if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    store.saveReading(reading).catch(log)
    return
  }
  if (sys === D || text === D || list === D) {
    back()
    return
  }

  if (mode === 'list') {
    // List taps arrive as listEvent; the index is undefined for item 0.
    if (event.listEvent && list === OsEventTypeList.CLICK_EVENT) {
      runAction(actions[event.listEvent.currentSelectItemIndex ?? 0])
    }
    return
  }
  if (mode === 'reader') {
    if (text === OsEventTypeList.SCROLL_TOP_EVENT) turnPage(-1)
    else if (text === OsEventTypeList.SCROLL_BOTTOM_EVENT) turnPage(1)
    else if (sys === OsEventTypeList.CLICK_EVENT || text === OsEventTypeList.CLICK_EVENT) turnPage(1)
  }
})

// ---------- loading the vault ----------

let refreshing = false
async function refreshNotes(showErrorsOnGlasses: boolean) {
  if (!cfg || refreshing) return
  refreshing = true
  setStatus('노트 목록을 불러오는 중...')
  try {
    const { notes: fresh, truncated } = await fetchNoteList(cfg)
    const changed = fresh.length !== notes.length || fresh.some((n, i) => n.sha !== notes[i]?.sha || n.path !== notes[i]?.path)
    notes = fresh
    await store.saveNoteList({ key: cfgKey(cfg), fetchedAt: Date.now(), truncated, notes })
    setStatus(truncated ? '저장소가 너무 커서 일부 노트만 불러왔습니다.' : '')
    if (mode === 'message' || (mode === 'list' && changed)) renderList()
    else renderPhone()
  } catch (e) {
    setStatus(`목록을 불러오지 못했습니다: ${errText(e)}`)
    if (showErrorsOnGlasses && !notes.length) {
      showMessage(`노트 목록을 불러오지 못했습니다.\n${errText(e)}\n\n휴대폰에서 설정을 확인하세요.\n더블탭: 종료`)
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
    if (!sameRepo) reading = { dir: '', lastNote: null, pages: {} }
    await store.saveConfig(cfg)
    await store.saveNoteList({ key: cfgKey(cfg), fetchedAt: Date.now(), truncated, notes })
    await store.saveReading(reading)
    setStatus(`연결되었습니다. 노트 ${notes.length}개`)
    settingsBox.open = false
    renderList()
  } catch (e) {
    setStatus(`연결 실패: ${errText(e)}`)
  }
  updateListInfo()
}

// ---------- phone UI ----------

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
  $('mirror').textContent = reader ? pages[current] ?? '' : '안경 목록이나 위 검색에서 노트를 고르세요.'
  $('pageCount').textContent = reader ? `${current + 1} / ${pages.length}` : ''
}

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

// ---------- startup ----------

cfg = await store.loadConfig()
reading = await store.loadReading()

if (!cfg) {
  settingsBox.open = true
  showMessage(SETUP_TEXT)
  // Dev-only: `?demo` pre-fills Obsidian's public help vault for testing.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('demo')) {
    fillForm({ owner: 'obsidianmd', repo: 'obsidian-help', branch: 'master', root: 'en', token: '' })
  }
} else {
  fillForm(cfg)
  const cached = await store.loadNoteList()
  if (cached && cached.key === cfgKey(cfg)) {
    notes = cached.notes
    renderList()
    refreshNotes(false) // update in the background
  } else {
    showMessage('노트 목록을 불러오는 중...')
    refreshNotes(true)
  }
}
updateListInfo()
renderPhone()
