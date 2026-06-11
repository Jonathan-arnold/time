/** Day of week, 0 = Sunday … 6 = Saturday (matches Date.getDay()). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/**
 * A continuous stretch of time with its own categories and budgets. Eras
 * partition the timeline: each one begins the day after the previous one
 * ends, and the current era has no end date. Past eras stay frozen — their
 * categories and budgets are kept as they were so metrics can be reviewed.
 */
export interface Era {
  id: string
  name: string
  /** Inclusive ISO date (yyyy-MM-dd) the era begins. */
  startDate: string
  /** Inclusive ISO end date; null marks the current era. */
  endDate: string | null
  createdAt: number
}

/**
 * A category of time. Categories nest via `parentId`; a null parent is a
 * top-level category. Categories belong to one era; starting a new era can
 * copy the previous era's tree so history stays untouched by later edits.
 */
export interface Category {
  id: string
  name: string
  parentId: string | null
  /** Hex color used in charts and the transaction grid. */
  color: string
  /** Sort order among siblings. */
  order: number
  /** The era this category belongs to. */
  eraId: string
}

/**
 * A 30-minute slice of past time, identified by the timestamp of its start.
 * Block starts are always aligned to :00 and :30 of the hour.
 */
export interface Block {
  /** Epoch milliseconds of the block's start, aligned to a 30-minute boundary. */
  start: number
  categoryId: string
}

export type BudgetType = 'recurring' | 'oneoff'

/**
 * A budget allocates minutes-per-day across categories.
 *
 * - Recurring budgets apply on the weekdays listed in `weekdays`.
 * - One-off budgets apply on every day within [startDate, endDate] and always
 *   override recurring budgets on overlapping days.
 */
/** How a recurring budget repeats. */
export type Recurrence = 'weekly' | 'monthly'

export interface Budget {
  id: string
  name: string
  type: BudgetType
  /** Recurring only: how the schedule repeats. Null for one-off budgets. */
  recurrence: Recurrence | null
  /** Recurring + weekly: weekdays this budget applies to. */
  weekdays: Weekday[]
  /** Recurring + monthly: days-of-month (1–31) this budget applies to. */
  monthDays: number[]
  /** Minutes from midnight the coverage window starts (30-min aligned). */
  coverStart: number
  /** Minutes from midnight the coverage window ends (30-min aligned). */
  coverEnd: number
  /** Whether the schedule has been accepted, unlocking the assignment view. */
  scheduleAccepted: boolean
  /**
   * How allocations are entered and summarized in the assignment view.
   * - `daily`: numbers are minutes-per-day, applied to every day of the period.
   * - `period`: numbers are totals for the whole period.
   * Stored allocations are always canonical period totals; this only changes
   * how they are displayed and edited, so toggling never loses data.
   */
  allocationMode: 'daily' | 'period'
  /** One-off only: inclusive ISO date (yyyy-MM-dd) range. */
  startDate: string | null
  endDate: string | null
  /**
   * Tie-breaker when multiple budgets of the same type apply on a day.
   * Higher wins. One-offs always beat recurring regardless of priority.
   */
  priority: number
  /**
   * Whether this is the user's currently-favorited recurring budget. At most
   * one budget should have this set; favoriting another flips this off
   * elsewhere.
   */
  favorite: boolean
  /** The era this budget belongs to. */
  eraId: string
  createdAt: number
}

/**
 * Minutes allocated to one category within one budget, for the whole
 * budgeting period (a week, a calendar month, or the one-off's span).
 */
export interface BudgetAllocation {
  id: string
  budgetId: string
  categoryId: string
  minutes: number
}

export type SyncRecordType =
  | 'block'
  | 'category'
  | 'budget'
  | 'allocation'
  | 'era'
export type SyncOp = 'put' | 'del'

/**
 * One row of the per-device append-only change log. Local writes append
 * rows here via Dexie hooks; the sync engine encrypts and ships them to
 * peers. Tombstones (op:'del') are kept forever so devices that come
 * online after a delete still see the deletion.
 */
export interface Change {
  /** Auto-incremented local rowid. */
  id?: number
  deviceId: string
  /** Monotonic per-device sequence number. */
  seq: number
  recordType: SyncRecordType
  recordId: string
  op: SyncOp
  /** Epoch ms — the LWW tiebreaker when merging concurrent edits. */
  updatedAt: number
  /** Full record snapshot for 'put'; null for 'del'. */
  payload: unknown
  /** 'local' = produced here; 'remote' = pulled from a peer. */
  source: 'local' | 'remote'
  /** True once this local row has been pushed to the server. */
  pushed: 0 | 1
}

/**
 * Singleton row holding sync configuration and cursors. Key is always 'config'.
 *
 * Keys live in IndexedDB alongside the plaintext data, so encryption here
 * is about what the *server* sees, not about local-device attackers.
 */
export interface SyncMeta {
  id: 'config'
  /**
   * The user-chosen identity name. Combined with the passphrase, it
   * deterministically derives `syncId` and the keys — so the recovery
   * sheet is "remember these two strings," nothing UUID-shaped.
   */
  username: string
  /**
   * Opaque per-user bucket id, derived from (username, passphrase).
   * The server treats this as the only routing key it understands.
   */
  syncId: string
  /** Random per-device id, included on every change row. */
  deviceId: string
  /** Base64 32-byte XChaCha20-Poly1305 key derived from passphrase. */
  kEncB64: string
  /** Base64 32-byte HMAC key derived from passphrase. */
  kAuthB64: string
  /** Server base URL, no trailing slash. */
  serverUrl: string
  /** Next local seq to assign. */
  localSeq: number
  /**
   * Highest seq we've successfully applied per peer device (includes our own,
   * so a clean reinstall can fast-forward from the server).
   */
  cursors: Record<string, number>
  /** Epoch ms of the last successful sync round-trip. */
  lastSyncedAt: number | null
}
