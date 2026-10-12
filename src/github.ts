// Reads an Obsidian vault that is synced to a GitHub repository (e.g. by the
// Obsidian Git plugin). api.github.com sends CORS headers, so the Even App
// WebView can call it directly — no proxy needed. Private repos need a
// fine-grained token with read-only "Contents" permission.

export interface RepoConfig {
  owner: string
  repo: string
  branch: string
  /** Vault folder inside the repo, '' when the vault is the repo root. */
  root: string
  token: string
}

export interface NoteEntry {
  /** Path relative to the vault root, e.g. "일기/2026-10-12.md". */
  path: string
  /** Git blob sha — changes whenever the note's content changes. */
  sha: string
}

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

const API = 'https://api.github.com'
const TIMEOUT_MS = 20_000

async function request(cfg: RepoConfig, url: string, accept: string): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { Accept: accept }
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`
    const res = await fetch(url, { headers, signal: ctrl.signal })
    if (!res.ok) throw new GitHubError(explain(res, !!cfg.token), res.status)
    return res
  } catch (err) {
    if (err instanceof GitHubError) throw err
    if (ctrl.signal.aborted) throw new GitHubError('GitHub 응답 시간이 초과되었습니다.', 0)
    throw new GitHubError('네트워크에 연결할 수 없습니다.', 0)
  } finally {
    clearTimeout(timer)
  }
}

function explain(res: Response, hasToken: boolean): string {
  if (res.status === 401) return '토큰이 잘못되었거나 만료되었습니다.'
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    return hasToken
      ? 'GitHub 요청 한도를 넘었습니다. 잠시 후 다시 시도하세요.'
      : 'GitHub 요청 한도(시간당 60회)를 넘었습니다. 토큰을 넣으면 한도가 늘어납니다.'
  }
  if (res.status === 403) return '이 저장소에 접근할 권한이 없습니다. 토큰 권한을 확인하세요.'
  if (res.status === 404) {
    return hasToken
      ? '저장소, 브랜치 또는 파일을 찾을 수 없습니다. 이름과 토큰의 저장소 권한을 확인하세요.'
      : '저장소, 브랜치 또는 파일을 찾을 수 없습니다. 비공개 저장소라면 토큰이 필요합니다.'
  }
  return `GitHub 오류 (${res.status})`
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/')
const normRoot = (root: string) => root.trim().replace(/^\/+|\/+$/g, '')

export async function fetchNoteList(cfg: RepoConfig): Promise<{ notes: NoteEntry[]; truncated: boolean }> {
  const url = `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`
  const data = (await (await request(cfg, url, 'application/vnd.github+json')).json()) as {
    tree: { path: string; type: string; sha: string }[]
    truncated: boolean
  }
  const root = normRoot(cfg.root)
  const prefix = root ? root + '/' : ''
  const notes: NoteEntry[] = []
  for (const item of data.tree) {
    if (item.type !== 'blob' || !/\.md$/i.test(item.path) || !item.path.startsWith(prefix)) continue
    const path = item.path.slice(prefix.length)
    // Skip .obsidian, .trash and other hidden folders.
    if (path.split('/').some(seg => seg.startsWith('.'))) continue
    notes.push({ path, sha: item.sha })
  }
  return { notes, truncated: data.truncated }
}

export async function fetchNote(cfg: RepoConfig, path: string): Promise<string> {
  const root = normRoot(cfg.root)
  const full = root ? `${root}/${path}` : path
  const url = `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${encodePath(full)}?ref=${encodeURIComponent(cfg.branch)}`
  return (await request(cfg, url, 'application/vnd.github.raw+json')).text()
}
