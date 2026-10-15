// @vitest-environment happy-dom
//
// Drives the whole app against a fake glasses bridge that has realistic call
// latency, so navigation bugs reported on real hardware can be reproduced
// without glasses: list paging, tap echoes, input during screen changes,
// rapid page turns, overlapping bridge calls, and relaunch.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const state = {
    startupResult: 0,
    screen: null as any,
    calls: [] as string[],
    inFlight: 0,
    maxInFlight: 0,
    lastCallAt: 0,
    lastRebuildAt: -Infinity,
    droppedRebuilds: 0,
    storage: new Map<string, string>(),
    handler: null as null | ((e: any) => void),
    exitDialogs: 0,
  }
  async function op<T>(name: string, ms: number, fn: () => T): Promise<T> {
    state.calls.push(name)
    state.inFlight++
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
    try {
      await sleep(ms)
      return fn()
    } finally {
      state.inFlight--
      state.lastCallAt = performance.now()
    }
  }
  const bridge = {
    createStartUpPageContainer: (c: any) =>
      op('create', 60, () => {
        if (state.startupResult === 0) state.screen = c
        return state.startupResult
      }),
    // Models the suspected hardware behaviour: a layout change that arrives
    // while the glasses are still applying the previous one (or the startup
    // page) reports success but is dropped.
    rebuildPageContainer: (c: any) => {
      const tooSoon = performance.now() - state.lastRebuildAt < 400
      return op('rebuild', 150, () => {
        if (tooSoon) state.droppedRebuilds++
        else state.screen = c
        state.lastRebuildAt = performance.now()
        return true
      })
    },
    textContainerUpgrade: (u: any) =>
      op('upgrade', 40, () => {
        const t = state.screen?.textObject?.find((x: any) => x.containerID === u.containerID && x.containerName === u.containerName)
        if (!t) return false
        t.content = u.content
        return true
      }),
    getLocalStorage: (k: string) => op('get', 5, () => state.storage.get(k) ?? ''),
    setLocalStorage: (k: string, v: string) => op('set', 20, () => (state.storage.set(k, v), true)),
    shutDownPageContainer: () => op('exit', 10, () => (state.exitDialogs++, true)),
    onEvenHubEvent: (cb: (e: any) => void) => {
      state.handler = cb
      return () => {}
    },
  }
  return { state, bridge, sleep }
})

vi.mock('@evenrealities/even_hub_sdk', () => {
  class Bag {
    constructor(o: object = {}) {
      Object.assign(this, o)
    }
  }
  return {
    waitForEvenAppBridge: async () => fake.bridge,
    TextContainerProperty: Bag,
    ListContainerProperty: Bag,
    ListItemContainerProperty: Bag,
    CreateStartUpPageContainer: Bag,
    RebuildPageContainer: Bag,
    TextContainerUpgrade: Bag,
    OsEventTypeList: {
      CLICK_EVENT: 0, SCROLL_TOP_EVENT: 1, SCROLL_BOTTOM_EVENT: 2, DOUBLE_CLICK_EVENT: 3,
      FOREGROUND_ENTER_EVENT: 4, FOREGROUND_EXIT_EVENT: 5, ABNORMAL_EXIT_EVENT: 6, SYSTEM_EXIT_EVENT: 7,
    },
  }
})

const BIG = Array.from({ length: 50 }, (_, i) => ({ path: `큰폴더/노트 ${String(i + 1).padStart(2, '0')}.md`, sha: `b${i}` }))
const NOTES = [
  ...BIG,
  { path: '일기/2026-10-12.md', sha: 'd1' },
  { path: '긴 노트.md', sha: 'long' },
  { path: '시작.md', sha: 'start' },
]
const LONG_MD = Array.from({ length: 60 }, (_, i) => `${i + 1}번째 줄입니다. 안경에서 페이지를 넘기며 읽는 테스트 문장.`).join('\n')

vi.mock('../src/github', () => ({
  GitHubError: class extends Error {},
  fetchNoteList: async () => {
    await fake.sleep(50)
    return { notes: NOTES, truncated: false }
  },
  fetchNote: async (_cfg: unknown, path: string) => {
    await fake.sleep(200)
    return path === '긴 노트.md' ? LONG_MD : `# ${path}\n\n짧은 내용`
  },
}))

// ---------- helpers ----------

const S = fake.state
const T = { tap: { sysEvent: {} }, double: { sysEvent: { eventType: 3 } }, down: { textEvent: { eventType: 2 } }, up: { textEvent: { eventType: 1 } } }

function emit(event: object) {
  S.handler!(event)
}

async function idle() {
  // Bridge quiet for longer than a note fetch, then past the input settle
  // window; repeat if anything was drawn meanwhile.
  for (;;) {
    while (S.inFlight > 0 || performance.now() - S.lastCallAt < 300) await fake.sleep(30)
    const mark = S.calls.length
    await fake.sleep(400)
    if (S.calls.length === mark) return
  }
}

const listItems = (): string[] => S.screen?.listObject?.[0]?.itemContainer?.itemName ?? []
const header = (): string => S.screen?.textObject?.find((t: any) => t.containerName === 'header')?.content ?? ''
const status = (): string => S.screen?.textObject?.find((t: any) => t.containerName === 'status')?.content ?? ''
const isReader = () => !!S.screen?.textObject?.some((t: any) => t.containerName === 'line0')

function select(label: string) {
  const items = listItems()
  const index = items.indexOf(label)
  expect(index, `"${label}" in ${JSON.stringify(items)}`).toBeGreaterThanOrEqual(0)
  emit({ listEvent: { containerID: 2, containerName: 'list', currentSelectItemName: label, currentSelectItemIndex: index || undefined } })
}
const selectStarting = (prefix: string) => select(listItems().find(l => l.startsWith(prefix))!)

async function launch(startupResult = 0) {
  vi.resetModules()
  S.startupResult = startupResult
  S.screen = null
  S.calls = []
  S.maxInFlight = 0
  S.droppedRebuilds = 0
  S.storage.set(
    'obsreader.config',
    JSON.stringify({ owner: 'me', repo: 'vault', branch: 'main', root: '', token: '' }),
  )
  document.body.innerHTML = '<div id="app"></div>'
  await import('../src/main')
  await idle()
}

beforeEach(() => {
  S.storage.clear()
})

// ---------- scenarios ----------

describe('folder navigation', () => {
  it('pages through a 50-note folder with ▼/▲ and every page fits the 20-item list limit', async () => {
    await launch()
    expect(listItems().length).toBeGreaterThan(0)
    selectStarting('▷ 큰폴더')
    await idle()

    const seen: string[] = []
    for (let page = 1; ; page++) {
      const items = listItems()
      expect(items.length).toBeLessThanOrEqual(20)
      expect(header()).toContain(`${page}/3쪽`)
      seen.push(...items.filter(l => l.startsWith('노트 ')))
      const next = items.find(l => l.startsWith('▼ 다음'))
      if (!next) break
      select(next)
      await idle()
    }
    expect(new Set(seen).size).toBe(50)

    selectStarting('▲ 이전')
    await idle()
    expect(header()).toContain('2/3쪽')
  }, 30_000)

  it('returns from a note to the list page that contains it, and double-tap climbs one level at a time', async () => {
    await launch()
    selectStarting('▷ 큰폴더')
    await idle()
    selectStarting('▼ 다음')
    await idle()
    select('노트 20')
    await idle()
    expect(isReader()).toBe(true)

    emit(T.double)
    await idle()
    expect(header()).toContain('2/3쪽')
    expect(listItems()).toContain('노트 20')

    emit(T.double)
    await idle()
    expect(listItems().some(l => l.startsWith('▷ 큰폴더'))).toBe(true) // root
    expect(S.exitDialogs).toBe(0)
  }, 30_000)
})

describe('input robustness', () => {
  it('a double-tap delivered twice (two envelopes) goes back only one level', async () => {
    await launch()
    selectStarting('▷ 일기')
    await idle()
    select('2026-10-12')
    await idle()
    expect(isReader()).toBe(true)

    emit(T.double)
    emit({ listEvent: { eventType: 3 } })
    await fake.sleep(100)
    emit({ textEvent: { eventType: 3 } })
    await idle()
    expect(header()).toContain('일기') // still inside the folder, not at the root
  }, 30_000)

  it('taps that arrive while the screen is changing are ignored', async () => {
    await launch()
    select('긴 노트')
    // Note loads (~200ms) then the reader is rebuilt (~150ms); tap throughout.
    for (let i = 0; i < 8; i++) {
      await fake.sleep(60)
      if (isReader() || S.calls.includes('rebuild')) emit(T.tap)
    }
    await idle()
    expect(isReader()).toBe(true)
    expect(status()).toMatch(/ 1 \/ \d+ /)
  }, 30_000)

  it('a single tap is never treated as a double-tap after a screen change', async () => {
    await launch()
    select('긴 노트')
    await idle()
    emit(T.tap)
    await idle()
    expect(isReader()).toBe(true)
    expect(status()).toMatch(/ 2 \/ /)
  }, 30_000)

  it('rapid page turns land on the right page with far fewer bridge calls than taps × rows', async () => {
    await launch()
    select('긴 노트')
    await idle()
    const before = S.calls.length
    for (let i = 0; i < 6; i++) {
      emit(i % 2 ? T.down : T.tap)
      await fake.sleep(220)
    }
    await idle()
    expect(status()).toMatch(/ 7 \/ /)
    expect(S.calls.length - before).toBeLessThan(6 * 7)
  }, 30_000)

  it('never runs two bridge calls at once', async () => {
    await fake.sleep(2000) // let the previous test's app instance finish its delayed saves
    await launch()
    select('긴 노트')
    for (let i = 0; i < 5; i++) {
      await fake.sleep(250)
      emit(T.tap)
    }
    emit(T.double)
    await idle()
    expect(S.maxInFlight).toBe(1)
  }, 30_000)
})

describe('lifecycle', () => {
  it('draws the list even when createStartUpPageContainer is ignored on relaunch', async () => {
    await launch(1)
    expect(listItems().length).toBeGreaterThan(0)
  }, 30_000)

  it('without a cached list, startup goes from the loading message to the folder list (no dropped layout changes)', async () => {
    S.storage.delete('obsreader.list2_n')
    await launch()
    expect(listItems().some(l => l.startsWith('▷ 큰폴더'))).toBe(true)
    expect(S.droppedRebuilds).toBe(0)
  }, 30_000)

  it('caches the note list so the next launch opens straight into the folder list', async () => {
    await launch()
    await fake.sleep(1500) // background save
    expect(S.storage.get('obsreader.list2_n')).toBeTruthy()
    await launch()
    expect(S.calls.filter(c => c === 'rebuild').length).toBe(1) // boot -> list, nothing in between
    expect(listItems().length).toBeGreaterThan(0)
  }, 30_000)

  it('rapid navigation never sends a layout change the glasses would drop', async () => {
    await launch()
    // Hammer the glasses faster than screens can change; some input is
    // (intentionally) ignored, but every layout change that is sent must land.
    for (let i = 0; i < 12; i++) {
      const items = listItems()
      const target = items.find(l => l.startsWith('▷ ')) ?? items.find(l => l === '긴 노트')
      if (target && i % 3 !== 2) select(target)
      else emit(T.double)
      await fake.sleep(250)
    }
    await idle()
    expect(S.droppedRebuilds).toBe(0)
    expect(S.calls.filter(c => c === 'rebuild').length).toBeGreaterThan(3)
  }, 30_000)

  it('reopens the note that was on screen when the app was closed', async () => {
    await launch()
    select('긴 노트')
    await idle()
    emit(T.tap)
    await idle()
    emit({ sysEvent: { eventType: 5 } }) // foreground exit -> save
    await idle()
    await launch() // fresh module, same storage
    expect(isReader()).toBe(true)
    expect(status()).toMatch(/ 2 \/ /)
  }, 30_000)
})
