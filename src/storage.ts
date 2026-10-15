import { bridge, call } from './bridge'
import type { NoteEntry, RepoConfig } from './github'

// Everything persists through the SDK key-value store — browser storage does
// not reliably survive restarts in the Even App WebView. Large values are
// chunked across keys, with the chunk count written last so a half-written
// value is never read back.

const PREFIX = 'obsreader.'
const CHUNK = 20_000
const MAX_CACHED_NOTES = 10
const MAX_NOTE_CHARS = 300_000

// Reads are on the UI lane (something on screen is waiting for them);
// writes go to the background lane so they never delay drawing.
const get = (key: string) => call(() => bridge.getLocalStorage(PREFIX + key), 'ui', 5_000)
const set = (key: string, value: string) => call(() => bridge.setLocalStorage(PREFIX + key, value), 'bg', 8_000)

async function getJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await get(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
const setJson = (key: string, value: unknown) => set(key, JSON.stringify(value))

async function setBig(key: string, text: string) {
  const n = Math.ceil(text.length / CHUNK)
  for (let i = 0; i < n; i++) await set(`${key}_${i}`, text.slice(i * CHUNK, (i + 1) * CHUNK))
  await set(`${key}_n`, `${n}:${text.length}`)
}

async function getBig(key: string): Promise<string | null> {
  const meta = await get(`${key}_n`)
  if (!meta) return null
  const [n, len] = meta.split(':').map(Number)
  const parts: string[] = []
  for (let i = 0; i < n; i++) parts.push(await get(`${key}_${i}`))
  const text = parts.join('')
  return text.length === len ? text : null
}

// ---------- config ----------

export const loadConfig = () => getJson<RepoConfig | null>('config', null)
export const saveConfig = (cfg: RepoConfig) => setJson('config', cfg)

// ---------- note list ----------

export interface CachedList {
  key: string // which repo/branch/root this list belongs to
  fetchedAt: number
  truncated: boolean
  notes: NoteEntry[]
}

// Stored compactly as parallel arrays so even a big vault's list is a few chunks.
export async function loadNoteList(): Promise<CachedList | null> {
  try {
    const raw = await getBig('list2')
    if (!raw) return null
    const c = JSON.parse(raw) as { key: string; fetchedAt: number; truncated: boolean; paths: string[]; shas: string[] }
    return { key: c.key, fetchedAt: c.fetchedAt, truncated: c.truncated, notes: c.paths.map((path, i) => ({ path, sha: c.shas[i] })) }
  } catch {
    return null
  }
}

export const saveNoteList = (list: CachedList) =>
  setBig(
    'list2',
    JSON.stringify({
      key: list.key,
      fetchedAt: list.fetchedAt,
      truncated: list.truncated,
      paths: list.notes.map(n => n.path),
      shas: list.notes.map(n => n.sha),
    }),
  )

// ---------- note contents (keyed by blob sha, small LRU) ----------

export async function loadCachedNote(sha: string): Promise<string | null> {
  const index = await getJson<string[]>('noteIndex', [])
  return index.includes(sha) ? getBig(`note_${sha}`) : null
}

export async function cacheNote(sha: string, text: string) {
  if (text.length > MAX_NOTE_CHARS) return
  const index = (await getJson<string[]>('noteIndex', [])).filter(s => s !== sha)
  await setBig(`note_${sha}`, text)
  index.push(sha)
  const evicted = index.splice(0, Math.max(0, index.length - MAX_CACHED_NOTES))
  await setJson('noteIndex', index)
  for (const old of evicted) await set(`note_${old}_n`, '')
}

// ---------- reading state ----------

export interface ReadingState {
  dir: string
  lastNote: string | null
  open: string | null // note on screen when last closed, reopened on launch
  pages: Record<string, number> // note path -> page index
}

export const loadReading = () => getJson<ReadingState>('reading', { dir: '', lastNote: null, open: null, pages: {} })

export function saveReading(state: ReadingState) {
  const entries = Object.entries(state.pages).slice(-200)
  return setJson('reading', { ...state, pages: Object.fromEntries(entries) })
}
