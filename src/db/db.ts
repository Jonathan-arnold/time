import Dexie, { type EntityTable } from 'dexie'
import { isoDate } from '../lib/time'
import type {
  Block,
  Budget,
  BudgetAllocation,
  Category,
  Change,
  Era,
  SyncMeta,
  SyncRecordType,
} from './types'

/**
 * Fixed id for the era created on first run / migration. Deterministic so
 * two devices that migrate independently converge on the same record when
 * they later sync, instead of producing two overlapping eras.
 */
export const DEFAULT_ERA_ID = 'era-1'

/**
 * The single IndexedDB database backing the app. All data lives in the
 * browser; there is no server.
 */
export class TimeBudgetDB extends Dexie {
  blocks!: EntityTable<Block, 'start'>
  categories!: EntityTable<Category, 'id'>
  budgets!: EntityTable<Budget, 'id'>
  budgetAllocations!: EntityTable<BudgetAllocation, 'id'>
  eras!: EntityTable<Era, 'id'>
  changes!: EntityTable<Change, 'id'>
  syncMeta!: EntityTable<SyncMeta, 'id'>

  constructor() {
    super('time-budget')
    const v1to4Stores = {
      // `start` is the primary key — one block per 30-minute boundary.
      blocks: 'start, categoryId',
      categories: 'id, parentId, order',
      budgets: 'id, type, priority',
      // Compound index supports "allocations for a budget" lookups.
      budgetAllocations: 'id, budgetId, categoryId, [budgetId+categoryId]',
    }
    this.version(1).stores(v1to4Stores)
    // v2 adds recurrence/coverage fields to budgets — backfill existing rows.
    this.version(2)
      .stores(v1to4Stores)
      .upgrade((tx) =>
        tx
          .table('budgets')
          .toCollection()
          .modify((b: Budget) => {
            b.recurrence ??= b.type === 'recurring' ? 'weekly' : null
            b.monthDays ??= []
            b.coverStart ??= 0
            b.coverEnd ??= 24 * 60
          }),
      )
    // v3 adds scheduleAccepted — existing budgets are treated as accepted.
    this.version(3)
      .stores(v1to4Stores)
      .upgrade((tx) =>
        tx
          .table('budgets')
          .toCollection()
          .modify((b: Budget) => {
            b.scheduleAccepted ??= true
          }),
      )
    // v4 adds allocationMode — existing budgets default to period totals.
    this.version(4)
      .stores(v1to4Stores)
      .upgrade((tx) =>
        tx
          .table('budgets')
          .toCollection()
          .modify((b: Budget) => {
            b.allocationMode ??= 'period'
          }),
      )
    // v5 adds the sync change log + syncMeta. Existing records are backfilled
    // as synthetic 'put' changes so a user who enables sync after months of
    // local-only use still propagates their history to a second device.
    const v5to6Stores = {
      ...v1to4Stores,
      changes:
        '++id, [recordType+recordId], [deviceId+seq], pushed, source, updatedAt',
      syncMeta: 'id',
    }
    this.version(5).stores(v5to6Stores)
    // v6 adds Budget.favorite — existing budgets default to false.
    this.version(6)
      .stores(v5to6Stores)
      .upgrade((tx) =>
        tx
          .table('budgets')
          .toCollection()
          .modify((b: Budget) => {
            b.favorite ??= false
          }),
      )
    // v7 adds eras: categories and budgets become era-scoped. Existing data
    // is folded into a single era covering all history (back to the earliest
    // categorized block).
    this.version(7)
      .stores({
        ...v5to6Stores,
        categories: 'id, parentId, order, eraId',
        budgets: 'id, type, priority, eraId',
        eras: 'id, startDate',
      })
      .upgrade(async (tx) => {
        const firstBlock = (await tx
          .table('blocks')
          .orderBy('start')
          .first()) as Block | undefined
        const era: Era = {
          id: DEFAULT_ERA_ID,
          name: 'First era',
          startDate: isoDate(new Date(firstBlock?.start ?? Date.now())),
          endDate: null,
          createdAt: Date.now(),
        }
        await tx.table('eras').add(era)
        await tx
          .table('categories')
          .toCollection()
          .modify((c: Category) => {
            c.eraId ??= DEFAULT_ERA_ID
          })
        await tx
          .table('budgets')
          .toCollection()
          .modify((b: Budget) => {
            b.eraId ??= DEFAULT_ERA_ID
          })
      })
  }
}

export const db = new TimeBudgetDB()

/**
 * Open a read-write transaction scoped to all sync-affecting tables. Every
 * mutation that should be captured in the change log must run inside this
 * helper so the Dexie hooks (which write to `changes` and `syncMeta`) have
 * the right tables in scope.
 */
export function mutate<T>(fn: () => Promise<T> | T): Promise<T> {
  return db.transaction(
    'rw',
    [
      db.blocks,
      db.categories,
      db.budgets,
      db.budgetAllocations,
      db.eras,
      db.changes,
      db.syncMeta,
    ],
    fn,
  )
}

/**
 * Pure helper: which sync record type does a Dexie table map to? Lives here
 * so the hook installer can be table-agnostic.
 */
function recordTypeFor(table: string): SyncRecordType | null {
  if (table === 'blocks') return 'block'
  if (table === 'categories') return 'category'
  if (table === 'budgets') return 'budget'
  if (table === 'budgetAllocations') return 'allocation'
  if (table === 'eras') return 'era'
  return null
}

/**
 * Stringify the primary key of a record for storage in the change log.
 * Block primary keys are numeric (timestamp); everything else is already
 * a string id.
 */
function pkOf(table: string, obj: unknown, fallbackKey: unknown): string {
  if (table === 'blocks') {
    const start = (obj as { start?: number } | null)?.start ?? fallbackKey
    return String(start)
  }
  return String((obj as { id?: string } | null)?.id ?? fallbackKey)
}

/**
 * Allow remote-apply code paths to suppress local change-log emission while
 * they write incoming peer rows. Without this, applying a pulled change would
 * loop back into the log as a fresh 'local' change.
 */
let suppressHooks = 0
export function withSuppressedHooks<T>(fn: () => Promise<T>): Promise<T> {
  suppressHooks++
  return Promise.resolve(fn()).finally(() => {
    suppressHooks--
  })
}

/**
 * In-memory sequence + device id, hydrated from `syncMeta` on startup.
 * Kept in memory so hook-fired writes don't race on a read-then-write of
 * the counter. JS is single-threaded within a tab; cross-tab is not
 * supported (matches the rest of the app's single-tab assumption).
 */
const seqState = {
  hydrated: false,
  deviceId: 'pre-sync' as string,
  localSeq: 0,
}

async function hydrateSeqState(): Promise<void> {
  if (seqState.hydrated) return
  const meta = await db.syncMeta.get('config')
  if (meta) {
    seqState.deviceId = meta.deviceId
    seqState.localSeq = meta.localSeq
  } else {
    // Bootstrap localSeq from any pre-existing change rows (backfill or otherwise).
    const last = await db.changes
      .where('deviceId')
      .equals(seqState.deviceId)
      .last()
    if (last) seqState.localSeq = last.seq
  }
  seqState.hydrated = true
}

/**
 * Update the in-memory seq state after sync setup completes so subsequent
 * change rows are attributed to the configured device.
 */
export function refreshSeqState(deviceId: string, localSeq: number) {
  seqState.deviceId = deviceId
  seqState.localSeq = localSeq
  seqState.hydrated = true
}

/**
 * Callback fired after a local change row is committed, used by the sync
 * scheduler to coalesce edits into a push. Wired up via {@link onLocalChange}
 * so this module stays free of any sync imports (avoids a cycle).
 */
let onLocalChange: () => void = () => {}
export function setOnLocalChange(fn: () => void): void {
  onLocalChange = fn
}

/**
 * Append a single row to the change log inside the current transaction.
 * Must be called only inside a `mutate()` transaction so the changes/syncMeta
 * tables are in scope. The in-memory seq is incremented synchronously; the
 * persisted `syncMeta.localSeq` is updated in the same tx as the change row.
 */
function appendChange(
  recordType: SyncRecordType,
  recordId: string,
  op: 'put' | 'del',
  payload: unknown,
): void {
  // Schedule the write on the current Dexie transaction without awaiting,
  // so the originating mutation's hook returns promptly. Dexie ties this
  // call into the current tx because we're inside one.
  void (async () => {
    await hydrateSeqState()
    seqState.localSeq += 1
    const seq = seqState.localSeq
    await db.changes.add({
      deviceId: seqState.deviceId,
      seq,
      recordType,
      recordId,
      op,
      updatedAt: Date.now(),
      payload: op === 'put' ? payload : null,
      source: 'local',
      pushed: 0,
    } as Change)
    const meta = await db.syncMeta.get('config')
    if (meta) await db.syncMeta.update('config', { localSeq: seq })
    // Notify the scheduler outside the tx — Dexie tx commit hasn't fired yet,
    // but the row is staged and the scheduler is debounced, so by the time it
    // fires `syncOnce()` the commit has landed.
    try {
      onLocalChange()
    } catch {
      // The scheduler must never break a write.
    }
  })()
}

/**
 * Install hooks on each data table to populate the change log. Hooks fire
 * inside the current transaction; callers must use `mutate()` so the tx scope
 * includes `changes` and `syncMeta`.
 */
function installChangeLogHooks() {
  const tables = [
    'blocks',
    'categories',
    'budgets',
    'budgetAllocations',
    'eras',
  ] as const
  for (const tableName of tables) {
    const type = recordTypeFor(tableName)!
    const table = db.table(tableName)

    table.hook('creating', function (primKey, obj) {
      if (suppressHooks > 0) return
      const id = pkOf(tableName, obj, primKey)
      this.onsuccess = () => appendChange(type, id, 'put', obj)
    })

    table.hook('updating', function (mods, primKey, obj) {
      if (suppressHooks > 0) return
      const id = pkOf(tableName, obj, primKey)
      this.onsuccess = (updated) =>
        appendChange(type, id, 'put', updated ?? { ...obj, ...mods })
    })

    table.hook('deleting', function (primKey, obj) {
      if (suppressHooks > 0) return
      const id = pkOf(tableName, obj, primKey)
      this.onsuccess = () => appendChange(type, id, 'del', null)
    })
  }
}

installChangeLogHooks()
