import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { bridge, call, holdBackground } from './bridge'

// Glasses renderer.
//
// Callers never draw directly: they describe the screen they want with show().
// A single loop brings the display to the latest wanted screen using the
// cheapest bridge calls that get there, and re-checks between calls, so rapid
// taps collapse into one final screen instead of a backlog of stale ones.
//
// Layouts:
//   list   — header line + native firmware list (folder / note picker)
//   reader — invisible full-screen input layer + one container per text row
//            on a 40px pitch (≈1.5× the firmware's fixed 27px line height) + status line
//
// createStartUpPageContainer works only once per host session (a relaunch can
// silently ignore it), so boot() uses it for a placeholder and every real
// screen is drawn with rebuildPageContainer.

export const LINE_W = 568
export const LINES_PER_PAGE = 6
const LINE_X = 4
const LINE_TOP = 4
const LINE_PITCH = 40
const LINE_H = 36

export const LIST_MAX_ITEMS = 20
const ITEM_MAX_CHARS = 64
const HEADER_MAX_CHARS = 60
/** Ignore input this long after a layout change, so taps aimed at the old screen don't hit the new one. */
const SETTLE_MS = 350

export type Screen =
  | { kind: 'list'; header: string; items: string[] }
  | { kind: 'reader'; rows: string[]; status: string }

interface Drawn {
  layout: 'boot' | 'list' | 'reader' | 'unknown'
  header: string
  itemsKey: string
  rows: string[]
  status: string
}

let drawn: Drawn = { layout: 'boot', header: '', itemsKey: '', rows: [], status: '' }
let wanted: Screen | null = null
let wantedVersion = 0
let drawnVersion = 0
let loop: Promise<void> | null = null
let rebuilding = false
let settledAt = 0

export let startupResult: number | null = null
export const errors: string[] = []

function note(err: unknown) {
  errors.push(`${new Date().toLocaleTimeString()} ${String(err)}`)
  if (errors.length > 20) errors.shift()
  console.error(err)
}

// ---------- labels ----------

function clip(s: string, max: number) {
  const chars = Array.from(s || ' ')
  return chars.length > max ? chars.slice(0, max - 3).join('') + '...' : chars.join('')
}

/**
 * Turns list labels into exactly what the firmware will show: clipped and made
 * unique. The firmware echoes the selected label back in list events, so
 * callers should match against these returned strings.
 */
export function fitListItems(labels: string[]): string[] {
  const seen = new Map<string, number>()
  return labels.slice(0, LIST_MAX_ITEMS).map(label => {
    let s = clip(label, ITEM_MAX_CHARS)
    const n = (seen.get(s) ?? 0) + 1
    seen.set(s, n)
    if (n > 1) s = clip(label, ITEM_MAX_CHARS - 4) + ` (${n})`
    return s
  })
}

// ---------- public API ----------

export function boot(message: string) {
  return call(async () => {
    startupResult = await bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [
          new TextContainerProperty({
            xPosition: 0, yPosition: 0, width: 576, height: 288,
            borderWidth: 0, borderColor: 5, paddingLength: 8,
            containerID: 1, containerName: 'boot',
            content: message, isEventCapture: 1,
          }),
        ],
      }),
    )
  })
}

export function show(screen: Screen) {
  wanted =
    screen.kind === 'list'
      ? { kind: 'list', header: clip(screen.header, HEADER_MAX_CHARS), items: screen.items.slice(0, LIST_MAX_ITEMS) }
      : {
          kind: 'reader',
          rows: Array.from({ length: LINES_PER_PAGE }, (_, i) => screen.rows[i] || ' '),
          status: screen.status || ' ',
        }
  wantedVersion++
  kick()
}

/** Redraw everything from scratch, e.g. after the app comes back to the foreground. */
export function refresh() {
  drawn.layout = 'unknown'
  wantedVersion++
  kick()
}

/** True while a layout change is on its way to the glasses or has only just landed. */
export function inputBlocked() {
  return rebuilding || performance.now() - settledAt < SETTLE_MS
}

export const exitApp = () => call(() => bridge.shutDownPageContainer(1), 'ui', 30_000)

// ---------- render loop ----------

function kick() {
  if (!loop) loop = run().finally(() => (loop = null))
}

async function run() {
  holdBackground(true)
  try {
    let failures = 0
    while (wanted && drawnVersion !== wantedVersion) {
      const version = wantedVersion
      try {
        const finished = await apply(wanted, () => version !== wantedVersion)
        if (finished) drawnVersion = version
        failures = 0
      } catch (err) {
        note(err)
        drawn.layout = 'unknown' // next attempt does a full rebuild
        if (++failures >= 2) {
          drawnVersion = version // give up on this screen; the next show()/refresh() retries
          failures = 0
        }
      }
    }
  } finally {
    holdBackground(false)
  }
}

/** Returns false if it stopped early because a newer screen was requested. */
async function apply(target: Screen, stale: () => boolean): Promise<boolean> {
  if (target.kind === 'list') {
    const itemsKey = target.items.join('\u0000')
    if (drawn.layout === 'list' && drawn.itemsKey === itemsKey) {
      if (drawn.header !== target.header) {
        await upgrade(1, 'header', target.header)
        drawn.header = target.header
      }
      return true
    }
    await rebuild(listPage(target.header, target.items))
    drawn = { layout: 'list', header: target.header, itemsKey, rows: [], status: '' }
    return true
  }

  if (drawn.layout !== 'reader') {
    await rebuild(readerPage(target.rows, target.status))
    drawn = { layout: 'reader', header: '', itemsKey: '', rows: [...target.rows], status: target.status }
    return true
  }
  // Same layout: update only rows that changed, checking for a newer page between calls.
  for (let i = 0; i < target.rows.length; i++) {
    if (stale()) return false
    if (target.rows[i] === drawn.rows[i]) continue
    await upgrade(10 + i, `line${i}`, target.rows[i])
    drawn.rows[i] = target.rows[i]
  }
  if (stale()) return false
  if (target.status !== drawn.status) {
    await upgrade(2, 'status', target.status)
    drawn.status = target.status
  }
  return true
}

async function rebuild(page: { textObject?: TextContainerProperty[]; listObject?: ListContainerProperty[] }) {
  const containerTotalNum = (page.textObject?.length ?? 0) + (page.listObject?.length ?? 0)
  rebuilding = true
  try {
    const ok = await call(() => bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum, ...page })), 'ui', 8_000)
    if (!ok) throw new Error('rebuildPageContainer returned false')
  } finally {
    rebuilding = false
    settledAt = performance.now()
  }
}

async function upgrade(containerID: number, containerName: string, content: string) {
  const ok = await call(
    () => bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID, containerName, content })),
    'ui',
    4_000,
  )
  if (!ok) throw new Error(`textContainerUpgrade(${containerName}) returned false`)
}

function listPage(header: string, items: string[]) {
  return {
    textObject: [
      new TextContainerProperty({
        xPosition: 0, yPosition: 0, width: 576, height: 34,
        borderWidth: 0, borderColor: 5, paddingLength: 4,
        containerID: 1, containerName: 'header', content: header, isEventCapture: 0,
      }),
    ],
    listObject: [
      new ListContainerProperty({
        xPosition: 0, yPosition: 36, width: 576, height: 252,
        borderWidth: 0, borderColor: 5, paddingLength: 0,
        containerID: 2, containerName: 'list', isEventCapture: 1,
        itemContainer: new ListItemContainerProperty({
          itemCount: items.length, itemWidth: 0, isItemSelectBorderEn: 1, itemName: items,
        }),
      }),
    ],
  }
}

function readerPage(rows: string[], status: string) {
  return {
    textObject: [
      // Declared first so it sits behind the text; it is the one that receives input.
      new TextContainerProperty({
        xPosition: 0, yPosition: 0, width: 576, height: 288,
        borderWidth: 0, borderColor: 0, paddingLength: 0,
        containerID: 1, containerName: 'input', content: ' ', isEventCapture: 1,
      }),
      ...rows.map(
        (content, i) =>
          new TextContainerProperty({
            xPosition: LINE_X, yPosition: LINE_TOP + i * LINE_PITCH, width: LINE_W, height: LINE_H,
            borderWidth: 0, borderColor: 0, paddingLength: 0,
            containerID: 10 + i, containerName: `line${i}`, content, isEventCapture: 0,
          }),
      ),
      new TextContainerProperty({
        xPosition: 0, yPosition: 256, width: 576, height: 30,
        borderWidth: 0, borderColor: 0, paddingLength: 2,
        containerID: 2, containerName: 'status', content: status, isEventCapture: 0,
      }),
    ],
  }
}
