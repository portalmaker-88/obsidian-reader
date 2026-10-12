import type { NoteEntry } from './github'

// Folder view over the flat note list from the git tree.

export interface DirListing {
  folders: { name: string; path: string; count: number }[]
  notes: NoteEntry[]
}

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' })

export function noteName(path: string) {
  return path.split('/').pop()!.replace(/\.md$/i, '')
}

export function parentDir(path: string) {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export function listDir(notes: NoteEntry[], dir: string): DirListing {
  const prefix = dir ? dir + '/' : ''
  const folderCounts = new Map<string, number>()
  const files: NoteEntry[] = []

  for (const note of notes) {
    if (!note.path.startsWith(prefix)) continue
    const rest = note.path.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash < 0) files.push(note)
    else {
      const name = rest.slice(0, slash)
      folderCounts.set(name, (folderCounts.get(name) ?? 0) + 1)
    }
  }

  return {
    folders: [...folderCounts]
      .sort((a, b) => collator.compare(a[0], b[0]))
      .map(([name, count]) => ({ name, path: prefix + name, count })),
    notes: files.sort((a, b) => collator.compare(noteName(a.path), noteName(b.path))),
  }
}

export function searchNotes(notes: NoteEntry[], query: string, limit = 100): NoteEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const words = q.split(/\s+/)
  return notes
    .filter(n => {
      const p = n.path.toLowerCase()
      return words.every(w => p.includes(w))
    })
    .sort((a, b) => {
      // Name matches before folder-only matches.
      const an = noteName(a.path).toLowerCase().includes(q) ? 0 : 1
      const bn = noteName(b.path).toLowerCase().includes(q) ? 0 : 1
      return an - bn || collator.compare(noteName(a.path), noteName(b.path))
    })
    .slice(0, limit)
}
