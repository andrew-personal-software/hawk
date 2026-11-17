export type Inline =
  | { t: 'text'; v: string } | { t: 'code'; v: string }
  | { t: 'bold'; c: Inline[] } | { t: 'italic'; c: Inline[] }
  | { t: 'link'; url: string; c: Inline[] }
export type Block =
  | { t: 'para'; c: Inline[] } | { t: 'heading'; c: Inline[] } | { t: 'quote'; c: Inline[] }
  | { t: 'code'; v: string } | { t: 'list'; ordered: boolean; items: Inline[][] }

const HEADING = /^#{1,6}\s+(.*)$/
const ITEM = /^([-*]|\d+\.)\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const FENCE = /^```/

const text = (v: string): Inline => ({ t: 'text', v })
const isAlnum = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9]/.test(ch)

function push(out: Inline[], n: Inline) {
  const last = out[out.length - 1]
  if (n.t === 'text' && last?.t === 'text') last.v += n.v
  else out.push(n)
}

function inline(s: string): Inline[] {
  const out: Inline[] = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '`') {
      const end = s.indexOf('`', i + 1)
      if (end > i + 1) { push(out, { t: 'code', v: s.slice(i + 1, end) }); i = end + 1; continue }
    } else if (s.startsWith('**', i)) {
      let end = s.indexOf('**', i + 2)
      while (end > 0 && s[end + 2] === '*') end++
      if (end > i + 2) { push(out, { t: 'bold', c: inline(s.slice(i + 2, end)) }); i = end + 2; continue }
    } else if (ch === '*' || ch === '_') {
      const end = s.indexOf(ch, i + 1)
      const ok = end > i + 1 && !/\s/.test(s[i + 1]) && (ch === '*' || (!isAlnum(s[i - 1]) && !isAlnum(s[end + 1])))
      if (ok) { push(out, { t: 'italic', c: inline(s.slice(i + 1, end)) }); i = end + 1; continue }
    } else if (ch === '[') {
      const m = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(s.slice(i))
      if (m) { push(out, { t: 'link', url: m[2], c: [text(m[1])] }); i += m[0].length; continue }
    } else if (ch === 'h' && !isAlnum(s[i - 1])) {
      const m = /^https?:\/\/\S+/.exec(s.slice(i))
      if (m) {
        const url = m[0].replace(/[.,;:!?)\]]+$/, '')
        if (/^https?:\/\/./.test(url)) {
          push(out, { t: 'link', url, c: [text(url)] }); i += url.length; continue
        }
      }
    }
    push(out, text(ch))
    i++
  }
  return out
}

const startsBlock = (l: string) => FENCE.test(l) || HEADING.test(l) || ITEM.test(l) || QUOTE.test(l)

export function parse(md: string): Block[] {
  const lines = md.split(/\r?\n/)
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    let m: RegExpExecArray | null
    if (line.trim() === '') { i++; continue }
    if (FENCE.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++])
      i++
      blocks.push({ t: 'code', v: body.join('\n') })
    } else if ((m = HEADING.exec(line))) {
      blocks.push({ t: 'heading', c: inline(m[1]) }); i++
    } else if (ITEM.test(line)) {
      const ordered = /^\d/.test(line)
      const items: Inline[][] = []
      while (i < lines.length && (m = ITEM.exec(lines[i])) && /^\d/.test(lines[i]) === ordered) {
        items.push(inline(m[2])); i++
      }
      blocks.push({ t: 'list', ordered, items })
    } else if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && (m = QUOTE.exec(lines[i]))) { body.push(m[1]); i++ }
      blocks.push({ t: 'quote', c: inline(body.join('\n')) })
    } else {
      const body: string[] = []
      while (i < lines.length && lines[i].trim() !== '' && (body.length === 0 || !startsBlock(lines[i]))) body.push(lines[i++])
      blocks.push({ t: 'para', c: inline(body.join('\n')) })
    }
  }
  return blocks
}
