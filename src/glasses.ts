import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { bridge, serial } from './bridge'

// Two glasses layouts:
//   list   — header line + native firmware list (folder / note picker)
//   reader — one text container per visual line + status line
//
// The firmware draws text at a fixed 27px line height with no spacing
// control, so the reader puts each line in its own container on a 40px pitch
// (≈1.5×). Lines are pre-wrapped to fit one row each (see layout.ts).
//
// createStartUpPageContainer only works once per host session: on a second
// launch it can be silently ignored. So boot() draws a placeholder with it and
// every real screen is drawn with rebuildPageContainer.

export const LINE_W = 568 // usable text width of a line container
export const LINES_PER_PAGE = 6
const LINE_X = 4
const LINE_TOP = 4
const LINE_PITCH = 40 // 27px glyph row × 1.5
const LINE_H = 36

const LIST_MAX_ITEMS = 20
const ITEM_MAX_CHARS = 64

type Layout = 'boot' | 'list' | 'reader'
let layout: Layout = 'boot'
let shownLines: string[] = []
let shownStatus = ''
// Last screen drawn, so it can be redrawn when the app returns to the foreground.
let lastScreen: (() => Promise<void>) | null = null

export let startupResult: number | null = null

export function boot(message: string) {
  return serial(async () => {
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

async function rebuild(page: { textObject?: TextContainerProperty[]; listObject?: ListContainerProperty[] }) {
  const containerTotalNum = (page.textObject?.length ?? 0) + (page.listObject?.length ?? 0)
  const ok = await bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum, ...page }))
  if (!ok) throw new Error('rebuildPageContainer failed')
}

const clip = (s: string, max: number) => (Array.from(s).length > max ? Array.from(s).slice(0, max - 3).join('') + '...' : s)

export function showList(header: string, items: string[]) {
  const names = items.slice(0, LIST_MAX_ITEMS).map(s => clip(s || ' ', ITEM_MAX_CHARS))
  const draw = async () => {
    await rebuild({
      textObject: [
        new TextContainerProperty({
          xPosition: 0, yPosition: 0, width: 576, height: 34,
          borderWidth: 0, borderColor: 5, paddingLength: 4,
          containerID: 1, containerName: 'header',
          content: clip(header, 60), isEventCapture: 0,
        }),
      ],
      listObject: [
        new ListContainerProperty({
          xPosition: 0, yPosition: 36, width: 576, height: 252,
          borderWidth: 0, borderColor: 5, paddingLength: 0,
          containerID: 2, containerName: 'list', isEventCapture: 1,
          itemContainer: new ListItemContainerProperty({
            itemCount: names.length, itemWidth: 0, isItemSelectBorderEn: 1, itemName: names,
          }),
        }),
      ],
    })
    layout = 'list'
  }
  lastScreen = draw
  return serial(draw, 15_000)
}

/** `lines` must already be wrapped to one row each (max LINES_PER_PAGE). */
export function showReader(lines: string[], status: string) {
  const rows = Array.from({ length: LINES_PER_PAGE }, (_, i) => lines[i] || ' ')
  status ||= ' '

  const fullDraw = async () => {
    // Invisible full-screen layer that receives input, declared first so it sits behind the text.
    const textObject = [
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
    ]
    await rebuild({ textObject })
    layout = 'reader'
    shownLines = rows
    shownStatus = status
  }

  lastScreen = fullDraw
  return serial(async () => {
    if (layout !== 'reader') return fullDraw()
    // Same layout: update only the rows that changed (flicker-free).
    for (let i = 0; i < rows.length; i++) {
      if (rows[i] === shownLines[i]) continue
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 10 + i, containerName: `line${i}`, content: rows[i] }))
      shownLines[i] = rows[i]
    }
    if (status !== shownStatus) {
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 2, containerName: 'status', content: status }))
      shownStatus = status
    }
  })
}

/** Full redraw of the current screen, e.g. after the app returns to the foreground. */
export function redraw() {
  if (!lastScreen) return Promise.resolve()
  return serial(lastScreen, 15_000)
}

export const exitApp = () => serial(() => bridge.shutDownPageContainer(1))
