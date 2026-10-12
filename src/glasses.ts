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
//   reader — text body + status line (paged note text)
// The first layout shown uses createStartUpPageContainer (allowed once);
// switching layouts uses rebuildPageContainer; page turns inside the reader
// use flicker-free textContainerUpgrade.

export const BODY_W = 576
export const BODY_H = 250
export const BODY_PAD = 4

const LIST_MAX_ITEMS = 20
const ITEM_MAX_CHARS = 64
const REBUILD_MAX_CHARS = 1000

type Layout = 'none' | 'list' | 'reader'
let layout: Layout = 'none'

async function showLayout(page: { textObject?: TextContainerProperty[]; listObject?: ListContainerProperty[] }) {
  const containerTotalNum = (page.textObject?.length ?? 0) + (page.listObject?.length ?? 0)
  if (layout === 'none') {
    const res = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum, ...page }))
    if (res !== 0) console.error('createStartUpPageContainer failed:', res)
  } else {
    const ok = await bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum, ...page }))
    if (!ok) console.error('rebuildPageContainer failed')
  }
}

const clip = (s: string, max: number) => (Array.from(s).length > max ? Array.from(s).slice(0, max - 3).join('') + '...' : s)

export function showList(header: string, items: string[]) {
  const names = items.slice(0, LIST_MAX_ITEMS).map(s => clip(s || ' ', ITEM_MAX_CHARS))
  return serial(async () => {
    await showLayout({
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
  }, 15_000)
}

export function showReader(body: string, status: string) {
  body ||= ' '
  status ||= ' '
  return serial(async () => {
    if (layout !== 'reader') {
      await showLayout({
        textObject: [
          new TextContainerProperty({
            xPosition: 0, yPosition: 0, width: BODY_W, height: BODY_H,
            borderWidth: 0, borderColor: 5, paddingLength: BODY_PAD,
            containerID: 1, containerName: 'body',
            content: body.slice(0, REBUILD_MAX_CHARS), isEventCapture: 1,
          }),
          new TextContainerProperty({
            xPosition: 0, yPosition: 256, width: 576, height: 30,
            borderWidth: 0, borderColor: 5, paddingLength: 2,
            containerID: 2, containerName: 'status',
            content: status, isEventCapture: 0,
          }),
        ],
      })
      layout = 'reader'
      if (body.length <= REBUILD_MAX_CHARS) return
    }
    await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'body', content: body }))
    await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 2, containerName: 'status', content: status }))
  })
}

export const exitApp = () => serial(() => bridge.shutDownPageContainer(1))
