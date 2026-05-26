/**
 * Auto-sync scheduler. Local mutations call `scheduleSync()` via the change
 * log hook; it debounces a `syncOnce()` so a burst of edits coalesces into a
 * single round-trip. Tab focus and a slow periodic timer also poke the
 * scheduler so peer changes show up without manual intervention.
 *
 * Failures are swallowed by design — a missing server, an offline laptop, or
 * a sync that isn't configured yet must never break the local app. The next
 * scheduled run picks up where this one left off because change rows stay
 * `pushed:0` until the server acks them.
 */
import { setOnLocalChange } from '../../db'
import { loadMeta, syncOnce } from './engine'

/** Debounce window after a local change before pushing. */
const DEBOUNCE_MS = 600
/** Periodic pull while the tab is visible, to catch peer changes. */
const POLL_MS = 30_000

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let inFlight: Promise<void> | null = null
let queued = false
let pollTimer: ReturnType<typeof setInterval> | null = null
let listenersInstalled = false

/**
 * Run a sync now, serialized so two overlapping triggers don't race. If a
 * sync is already in flight, mark `queued` so a follow-up runs as soon as
 * the current one completes — that captures changes made during the sync.
 */
async function runSync(): Promise<void> {
  if (inFlight) {
    queued = true
    return inFlight
  }
  inFlight = (async () => {
    try {
      const meta = await loadMeta()
      if (!meta) return
      await syncOnce()
    } catch {
      // Network down, server unreachable, etc. The unpushed rows are still
      // pending; the next trigger will retry.
    } finally {
      inFlight = null
      if (queued) {
        queued = false
        // Schedule the follow-up rather than recursing so the stack stays flat.
        scheduleSync(0)
      }
    }
  })()
  return inFlight
}

/**
 * Request a sync soon. Called from the change-log hook for every local
 * mutation; safe to call freely. Pass `delay=0` to bypass the debounce
 * (used by focus/visibility handlers).
 */
export function scheduleSync(delay: number = DEBOUNCE_MS): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void runSync()
  }, delay)
}

/**
 * Install tab-level listeners that pull on focus and on a slow timer. Idempotent
 * — safe to call from React effects that may re-run.
 */
export function installAutoSync(): void {
  if (listenersInstalled || typeof window === 'undefined') return
  listenersInstalled = true

  // Local mutations debounce-push.
  setOnLocalChange(() => scheduleSync())

  const kick = () => scheduleSync(0)
  window.addEventListener('focus', kick)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick()
  })
  // Initial pull on load.
  scheduleSync(0)

  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') scheduleSync(0)
  }, POLL_MS)
}

/** Exposed for tests / teardown. Stops the polling timer. */
export function stopAutoSync(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  setOnLocalChange(() => {})
  listenersInstalled = false
}
