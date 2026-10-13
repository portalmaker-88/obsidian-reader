import { bridge, serial } from './bridge'
import type { NoteEntry, RepoConfig } from './github'

// Everything persists through the SDK key-value store — browser storage does
// not reliably survive restarts in the Even App WebView. Large values are
// chunked across keys, with the chunk count written last so a half-written
// value is never read back.

const PREFIX = 'obsreader.'
const CHUNK = 50_000
const MAX_CACHED_NOTES = 10
const MAX_NOTE_CHARS = 300_000

const get = (key: string) => serial(() => bridge.getLocalStorage(PREFIX + key), 5_000)
const set = (key: string, value: string) => serial(() => bridge.setLocalStorage(PREFIX + key, value))

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

export async function loadNoteList(): Promise<CachedList | null> {
  try {
    const raw = await getBig('list')
    return raw ? (JSON.parse(raw) as CachedList) : null
  } catch {
    return null
  }
}
export const saveNoteList = (list: CachedList) => setBig('list', JSON.stringify(list))

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
