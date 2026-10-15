import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'

export const bridge = await waitForEvenAppBridge()

// Bridge call scheduler.
//
// All bridge calls share one link to the phone app/glasses, and overlapping
// calls can drop it, so exactly one call runs at a time. Calls go into two lanes:
//   ui — glasses drawing and the reads it waits on; always runs first
//   bg — storage writes; runs only while the screen is idle
// so saving a note to the cache can never hold up a page turn.
// Each call is capped so one flaky hop can't stall everything behind it.

export type Lane = 'ui' | 'bg'

interface Task {
  fn: () => Promise<unknown>
  timeoutMs: number
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

const queues: Record<Lane, Task[]> = { ui: [], bg: [] }
let running = false
let uiHolds = 0

export function call<T>(fn: () => Promise<T>, lane: Lane = 'ui', timeoutMs = 8_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queues[lane].push({ fn, timeoutMs, resolve: resolve as (v: unknown) => void, reject })
    pump()
  })
}

/** Keep background calls parked while a multi-step screen update is in progress. */
export function holdBackground(on: boolean) {
  uiHolds = Math.max(0, uiHolds + (on ? 1 : -1))
  if (!on) pump()
}

async function pump() {
  if (running) return
  running = true
  try {
    for (;;) {
      const task = queues.ui.shift() ?? (uiHolds === 0 ? queues.bg.shift() : undefined)
      if (!task) break
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          task.fn(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('bridge call timed out')), task.timeoutMs)
          }),
        ])
        task.resolve(result)
      } catch (err) {
        task.reject(err)
      } finally {
        clearTimeout(timer)
      }
    }
  } finally {
    running = false
  }
}
