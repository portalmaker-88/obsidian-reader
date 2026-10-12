// Converts Obsidian-flavoured Markdown into plain text the G2 can show.
//
// The glasses have one font, no bold/italic and silently drop glyphs that
// aren't in the firmware font, so structure is expressed with the few symbols
// known to render (■ ▶ ▷ □ │ ─) and everything else is stripped to its text.

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic)$/i

export function mdToGlasses(md: string, title?: string): string {
  let src = md.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  src = src.replace(/^---\n[\s\S]*?\n---[ \t]*(\n|$)/, '') // YAML frontmatter
  src = src.replace(/%%[\s\S]*?%%/g, '').replace(/<!--[\s\S]*?-->/g, '')

  const out: string[] = []
  const blank = () => {
    if (out.length && out[out.length - 1] !== '') out.push('')
  }
  let inCode = false

  for (const raw of src.split('\n')) {
    const line = raw.replace(/\t/g, '    ')
    let m: RegExpMatchArray | null

    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode
      out.push(inCode ? '──── 코드 ────' : '─────────────')
      continue
    }
    if (inCode) {
      out.push('  ' + line.replace(/\s+$/, ''))
      continue
    }

    if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      const level = m[1].length
      blank()
      out.push((level === 1 ? '■ ' : level === 2 ? '▶ ' : '▷ ') + inline(m[2]))
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('─────────────')
      continue
    }
    if ((m = line.match(/^\s*>\s?(.*)$/))) {
      let text = m[1]
      const callout = text.match(/^\[!([\w-]+)\][+-]?\s*(.*)$/)
      if (callout) text = `[${callout[1]}] ${callout[2]}`.trim()
      out.push('│ ' + inline(text))
      continue
    }
    if ((m = line.match(/^(\s*)[-*+]\s+\[(.)\]\s+(.*)$/))) {
      out.push(indent(m[1]) + (m[2] === ' ' ? '□ ' : '■ ') + inline(m[3]))
      continue
    }
    if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) {
      out.push(indent(m[1]) + '- ' + inline(m[2]))
      continue
    }
    if ((m = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/))) {
      out.push(indent(m[1]) + m[2] + '. ' + inline(m[3]))
      continue
    }
    // Tables: drop the |---|---| row, join cells with a bar.
    if (/^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{0,}:?\s*\|?\s*$/.test(line)) continue
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|')
      out.push(cells.map(c => inline(c.trim())).join(' │ '))
      continue
    }

    out.push(inline(line.replace(/\s+$/, '')))
  }

  let text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  // Show the file name as a title unless the note opens with its own H1.
  if (title && !text.startsWith('■ ')) text = `■ ${title}\n\n${text}`
  return text || '(빈 노트)'
}

function indent(ws: string) {
  return '  '.repeat(Math.min(4, Math.ceil(ws.length / 4)))
}

function baseName(target: string) {
  return target.split('/').pop()!.replace(/\.md$/i, '')
}

function inline(s: string): string {
  return (
    s
      // ![[embed.png]] / ![[Other note]]
      .replace(/!\[\[([^\]|#]+)[^\]]*\]\]/g, (_, t: string) =>
        IMAGE_EXT.test(t) ? `[이미지: ${baseName(t)}]` : `[포함: ${baseName(t)}]`,
      )
      // ![alt](url)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => `[이미지${alt ? ': ' + alt : ''}]`)
      // [[Note|alias]], [[Note#Heading]], [[Note]]
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, alias?: string) => {
        if (alias) return alias
        const [note, heading] = target.split('#')
        const name = note ? baseName(note) : ''
        const h = heading?.replace(/^\^/, '')
        return name && h ? `${name} > ${h}` : name || h || ''
      })
      // [text](url)
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1$2')
      .replace(/(^|[^\w])_(?!\s)([^_]+?)_(?!\w)/g, '$1$2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/==(.+?)==/g, '$1')
      .replace(/\s\^[\w-]+$/, '') // block ids
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
  )
}
