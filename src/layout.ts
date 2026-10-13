import { measureTextWrap } from '@evenrealities/pretext'

// Pre-wraps text into rows that each fit on one line of a G2 text container,
// using pretext's glyph widths (the same ones the LVGL firmware uses), then
// groups the rows into pages. Each row is later drawn in its own container,
// which is how the reader gets wider line spacing than the firmware's default.

const YIELD_EVERY = 400 // source lines between yields, keeps the WebView responsive

const fitsOneRow = (s: string, width: number) => measureTextWrap(s || ' ', width).lineCount <= 1

export function wrapLine(line: string, width: number): string[] {
  if (!line.trim()) return ['']
  const rows: string[] = []
  let rest = line
  while (rest) {
    if (fitsOneRow(rest, width)) {
      rows.push(rest)
      break
    }
    const chars = Array.from(rest)
    // Longest prefix that fits one row.
    let lo = 1
    let hi = chars.length - 1
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (fitsOneRow(chars.slice(0, mid).join(''), width)) lo = mid
      else hi = mid - 1
    }
    // Prefer breaking at the last space, unless that wastes most of the row.
    let cut = lo
    for (let i = lo; i > lo / 2; i--) {
      if (chars[i] === ' ') {
        cut = i
        break
      }
    }
    rows.push(chars.slice(0, cut).join('').replace(/\s+$/, ''))
    rest = chars.slice(cut).join('').replace(/^\s+/, '')
  }
  return rows
}

export function wrapText(text: string, width: number): string[] {
  return text.split('\n').flatMap(line => wrapLine(line, width))
}

export async function paginateRows(text: string, width: number, rowsPerPage: number): Promise<string[][]> {
  const lines = text.split('\n')
  const pages: string[][] = []
  let page: string[] = []

  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i % YIELD_EVERY === 0) await new Promise(r => setTimeout(r, 0))
    for (const row of wrapLine(lines[i], width)) {
      if (!row && !page.length) continue // never start a page with a blank row
      page.push(row)
      if (page.length === rowsPerPage) {
        pages.push(page)
        page = []
      }
    }
  }
  if (page.some(r => r)) pages.push(page)
  return pages.length ? pages : [['(빈 노트)']]
}
