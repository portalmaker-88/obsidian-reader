import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'

export const bridge = await waitForEvenAppBridge()

// Every bridge call shares one BLE link: render and storage calls that overlap
// can drop the connection, so they all go through this one queue. Each call is
// capped so a single flaky hop can't stall everything behind it.
// Never call `serial` from inside a function already running in `serial`.
let chain: Promise<unknown> = Promise.resolve()

export function serial<T>(fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const run = chain.then(() =>
    Promise.race([
      fn(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('bridge call timed out')), timeoutMs)),
    ]),
  )
  chain = run.catch(() => undefined)
  return run
}
