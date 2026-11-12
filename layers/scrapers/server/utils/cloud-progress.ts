import { setTimeout as delay } from 'node:timers/promises'

/** Callbacks preservam ordem e snapshot, inclusive quando uma fonte acaba antes de outra. */
export function orderedCloudProgress<T>(send: (snapshot: T) => Promise<void>, failed: (error: unknown) => void, wait: (ms: number) => Promise<void> = ms => delay(ms)) {
  let pending = Promise.resolve()
  return (value: T): Promise<void> => {
    const snapshot = structuredClone(value)
    const next = pending.then(async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { await send(snapshot); return } catch (error) {
          if (attempt === 3) { failed(error); return }
          await wait(attempt * 500)
        }
      }
    })
    pending = next.catch(() => undefined)
    return next
  }
}
