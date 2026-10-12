import { measureTextWrap } from '@evenrealities/pretext'

// Line-based pagination for plain .txt files, using pretext's pixel-accurate
// glyph measurements (the same ones LVGL uses on the G2 firmware).
//
// Unlike prose-with-blank-lines, .txt files usually break on single newlines,
// so each source line is measured and packed individually. Lines taller than
// the remaining space are split at word boundaries (or per character for long
// unspaced runs) so pages always fill to the bottom.
//
// Pass the container's *inner* box (width/height minus padding and border).
// Line height is a fixed 27px in EvenHub's LVGL build.

const LINE_HEIGHT = 27
// Yield to the event loop this often so big files don't freeze the WebView.
const YIELD_EVERY = 1500

export interface PaginateBox {
  width: number
  height: number
}

export async function paginate(
  source: string,
  box: PaginateBox,
  onProgress?: (ratio: number) => void,
): Promise<string[]> {
  const maxLines = Math.max(1, Math.floor(box.height / LINE_HEIGHT))
  const lines = source.split('\n')

  const pages: string[] = []
  let buffer: string[] = []
  let used = 0

  const flush = () => {
    if (buffer.length) pages.push(buffer.join('\n'))
    buffer = []
    used = 0
  }
  const linesOf = (s: string) => measureTextWrap(s || ' ', box.width).lineCount

  for (let i = 0; i < lines.length; i++) {
    if (i % YIELD_EVERY === 0 && i > 0) {
      onProgress?.(i / lines.length)
      await new Promise(r => setTimeout(r, 0))
    }

    let line = lines[i]
    // Never open a page with a blank line.
    if (!line.trim()) {
      if (used > 0 && used < maxLines) {
        buffer.push('')
        used++
      }
      continue
    }

    let cost = linesOf(line)
    if (used + cost <= maxLines) {
      buffer.push(line)
      used += cost
      continue
    }

    // Short line that just doesn't fit: start a fresh page with it.
    if (cost <= maxLines && used > 0 && maxLines - used < 2) {
      flush()
      buffer.push(line)
      used = cost
      continue
    }

    // Otherwise split it across the bottom of this page and following pages.
    while (line) {
      const room = maxLines - used
      let [head, tail] = takeFitting(line, box.width, room)
      if (!head && used === 0) {
        // Guard against a token that can't fit even an empty page.
        const chars = Array.from(line)
        head = chars[0]
        tail = chars.slice(1).join('')
      }
      if (head) buffer.push(head)
      line = tail
      if (!line) {
        used += head ? linesOf(head) : 0
        break
      }
      flush()
      cost = linesOf(line)
      if (cost <= maxLines) {
        buffer.push(line)
        used = cost
        break
      }
    }
    if (used >= maxLines) flush()
  }
  flush()
  onProgress?.(1)
  return pages.length ? pages : ['(빈 파일)']
}

// Returns the longest prefix of `text` that wraps into at most `maxLines`
// lines, plus the remainder (with leading whitespace dropped).
function takeFitting(text: string, width: number, maxLines: number): [string, string] {
  const tokens = tokenize(text)
  let head = ''
  let i = 0
  for (; i < tokens.length; i++) {
    const candidate = head + tokens[i]
    if (measureTextWrap(candidate, width).lineCount > maxLines) break
    head = candidate
  }
  const tail = tokens.slice(i).join('').replace(/^\s+/, '')
  return [head.replace(/\s+$/, ''), tail]
}

function tokenize(text: string): string[] {
  const out: string[] = []
  for (const tok of text.match(/\s+|\S+/g) ?? []) {
    // Long unspaced runs (URLs, CJK without spaces) are split per character.
    if (tok.length > 16 && !/\s/.test(tok)) out.push(...Array.from(tok))
    else out.push(tok)
  }
  return out
}
