/**
 * Sync engine: setup, push, pull, merge. The engine sits between the
 * Dexie change log and the server. It never touches plaintext on the
 * wire — payloads are sealed with kEnc, requests are signed with kAuth.
 *
 * Conflict policy: last-write-wins per recordId, ordered by `updatedAt`
 * with deviceId as tiebreaker. The change log keeps every event so a
 * device that comes online later still observes any deletes that
 * happened while it was offline.
 */
import { v4 as uuidv4 } from 'uuid'
import {
  db,
  mutate,
  refreshSeqState,
  withSuppressedHooks,
  type Block,
  type Budget,
  type BudgetAllocation,
  type Category,
  type Change,
  type SyncMeta,
  type SyncRecordType,
} from '../../db'
import {
  b64ToBytes,
  bytesToB64,
  decryptJson,
  deriveIdentity,
  encryptJson,
  normalizeUsername,
  signRequest,
} from './crypto'
import type {
  PullResponse,
  PullRow,
  PushRequest,
  PushRow,
  SealedChange,
} from './protocol'

const META_KEY = 'config' as const

/** Read the current sync configuration, or null if sync isn't set up. */
export async function loadMeta(): Promise<SyncMeta | null> {
  return (await db.syncMeta.get(META_KEY)) ?? null
}

/**
 * Provision sync on this device. The (username, passphrase) pair
 * deterministically derives the bucket id and the encryption keys — no
 * server round-trip is needed for setup. A second device joins by entering
 * the same pair and computing the same syncId locally; the first sync
 * pulls the existing history. A freshly seeded device also backfills the
 * change log from any pre-existing local rows.
 */
export async function setupSync(opts: {
  serverUrl: string
  username: string
  passphrase: string
}): Promise<{ syncId: string }> {
  const serverUrl = opts.serverUrl.replace(/\/$/, '')
  const username = normalizeUsername(opts.username)
  const deviceId = uuidv4()

  const { kEnc, kAuth, syncId } = await deriveIdentity(
    username,
    opts.passphrase,
  )

  const meta: SyncMeta = {
    id: META_KEY,
    username,
    syncId,
    deviceId,
    kEncB64: await bytesToB64(kEnc),
    kAuthB64: await bytesToB64(kAuth),
    serverUrl,
    localSeq: 0,
    cursors: {},
    lastSyncedAt: null,
  }

  // Backfill: convert any pre-existing local data into synthetic change rows
  // so a user enabling sync after months of local-only use still propagates
  // their full history to a second device on the next sync.
  await mutate(async () => {
    await db.syncMeta.put(meta)
    // Wipe any pre-sync change rows; we're re-attributing them to this device.
    await db.changes.where('deviceId').equals('pre-sync').delete()
    let seq = 0
    const now = Date.now()
    const blocks = await db.blocks.toArray()
    const categories = await db.categories.toArray()
    const budgets = await db.budgets.toArray()
    const allocations = await db.budgetAllocations.toArray()

    const rows: Change[] = []
    for (const b of blocks) {
      rows.push(makeBackfillRow(deviceId, ++seq, 'block', String(b.start), b, now))
    }
    for (const c of categories) {
      rows.push(makeBackfillRow(deviceId, ++seq, 'category', c.id, c, now))
    }
    for (const b of budgets) {
      rows.push(makeBackfillRow(deviceId, ++seq, 'budget', b.id, b, now))
    }
    for (const a of allocations) {
      rows.push(makeBackfillRow(deviceId, ++seq, 'allocation', a.id, a, now))
    }
    if (rows.length > 0) await db.changes.bulkAdd(rows)
    await db.syncMeta.update(META_KEY, { localSeq: seq })
    refreshSeqState(deviceId, seq)
  })

  return { syncId }
}

function makeBackfillRow(
  deviceId: string,
  seq: number,
  recordType: SyncRecordType,
  recordId: string,
  payload: unknown,
  updatedAt: number,
): Change {
  return {
    deviceId,
    seq,
    recordType,
    recordId,
    op: 'put',
    updatedAt,
    payload,
    source: 'local',
    pushed: 0,
  }
}

/** Disable sync and wipe the keys. Local data is untouched. */
export async function disableSync(): Promise<void> {
  await db.syncMeta.delete(META_KEY)
}

/**
 * One full sync round-trip: push all unpushed local rows, then pull anything
 * new from peers and apply it with LWW merging.
 */
export async function syncOnce(): Promise<{ pushed: number; pulled: number }> {
  const meta = await loadMeta()
  if (!meta) throw new Error('sync is not configured')
  const pushed = await pushAll(meta)
  const pulled = await pullAll(meta)
  await db.syncMeta.update(META_KEY, { lastSyncedAt: Date.now() })
  return { pushed, pulled }
}

async function pushAll(meta: SyncMeta): Promise<number> {
  const unpushed = await db.changes
    .where('pushed')
    .equals(0)
    .filter((c) => c.source === 'local' && c.deviceId === meta.deviceId)
    .sortBy('seq')
  if (unpushed.length === 0) return 0

  const kEnc = await b64ToBytes(meta.kEncB64)
  const kAuth = await b64ToBytes(meta.kAuthB64)

  const rows: PushRow[] = await Promise.all(
    unpushed.map(async (c): Promise<PushRow> => {
      const sealed: SealedChange = {
        recordType: c.recordType,
        recordId: c.recordId,
        op: c.op,
        payload: c.payload,
      }
      return {
        deviceId: c.deviceId,
        seq: c.seq,
        updatedAt: c.updatedAt,
        ciphertext: await encryptJson(sealed, kEnc),
      }
    }),
  )

  const body = JSON.stringify({ rows } satisfies PushRequest)
  const path = `/sync/${meta.syncId}/push`
  const sig = await signRequest(kAuth, 'POST', path, meta.syncId, body)
  const res = await fetch(`${meta.serverUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sync-sig': sig,
    },
    body,
  })
  if (!res.ok) throw new Error(`push failed: ${res.status}`)

  // Mark the just-pushed rows as pushed. We do this after server ack so a
  // failed push gets retried next time.
  const ids = unpushed.map((c) => c.id!).filter((id) => id != null)
  await db.changes.bulkUpdate(ids.map((id) => ({ key: id, changes: { pushed: 1 } })))
  return rows.length
}

async function pullAll(meta: SyncMeta): Promise<number> {
  const kEnc = await b64ToBytes(meta.kEncB64)
  const kAuth = await b64ToBytes(meta.kAuthB64)

  const cursors = { ...meta.cursors }
  const path = `/sync/${meta.syncId}/pull`
  const body = JSON.stringify({ cursors })
  const sig = await signRequest(kAuth, 'POST', path, meta.syncId, body)
  const res = await fetch(`${meta.serverUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sync-sig': sig,
    },
    body,
  })
  if (!res.ok) throw new Error(`pull failed: ${res.status}`)
  const { rows } = (await res.json()) as PullResponse
  if (rows.length === 0) return 0

  // Decrypt all rows up-front so the merge transaction is purely Dexie work.
  const decrypted: { row: PullRow; sealed: SealedChange }[] = []
  for (const row of rows) {
    if (row.deviceId === meta.deviceId) {
      // This is our own change echoed back — fast-forward our cursor without re-applying.
      const cur = cursors[row.deviceId] ?? 0
      if (row.seq > cur) cursors[row.deviceId] = row.seq
      continue
    }
    try {
      const sealed = await decryptJson<SealedChange>(row.ciphertext, kEnc)
      decrypted.push({ row, sealed })
    } catch {
      // A row we can't decrypt means a key mismatch — skip rather than crash
      // the whole sync. Surface in the UI later if useful.
    }
  }

  await mutate(async () => {
    await withSuppressedHooks(async () => {
      for (const { row, sealed } of decrypted) {
        await applyRemoteChange(row, sealed)
        const cur = cursors[row.deviceId] ?? 0
        if (row.seq > cur) cursors[row.deviceId] = row.seq
      }
    })
    await db.syncMeta.update(META_KEY, { cursors })
  })

  return decrypted.length
}

/**
 * Apply one remote change with LWW. We re-emit the change into our local
 * `changes` table (marked `source:'remote'`) so a third device pulling from
 * us — or this device after losing local IndexedDB — gets the full picture.
 */
async function applyRemoteChange(
  row: PullRow,
  sealed: SealedChange,
): Promise<void> {
  // Has any later change to this record already been applied? If so, LWW says
  // keep what we have and just record the tombstone.
  const newest = await db.changes
    .where('[recordType+recordId]')
    .equals([sealed.recordType, sealed.recordId])
    .reverse()
    .sortBy('updatedAt')
  const winning = newest[0]
  const shouldWin = winning
    ? row.updatedAt > winning.updatedAt ||
      (row.updatedAt === winning.updatedAt && row.deviceId > winning.deviceId)
    : true

  // Always record the pulled change so the log stays the full history.
  await db.changes.add({
    deviceId: row.deviceId,
    seq: row.seq,
    recordType: sealed.recordType,
    recordId: sealed.recordId,
    op: sealed.op,
    updatedAt: row.updatedAt,
    payload: sealed.payload,
    source: 'remote',
    pushed: 1, // remote rows are never pushed back
  } as Change)

  if (!shouldWin) return

  // Materialize into the typed table.
  if (sealed.op === 'del') {
    await deleteRecord(sealed.recordType, sealed.recordId)
  } else {
    await putRecord(sealed.recordType, sealed.payload)
  }
}

async function deleteRecord(
  type: SyncRecordType,
  recordId: string,
): Promise<void> {
  switch (type) {
    case 'block':
      await db.blocks.delete(Number(recordId))
      return
    case 'category':
      await db.categories.delete(recordId)
      return
    case 'budget':
      await db.budgets.delete(recordId)
      return
    case 'allocation':
      await db.budgetAllocations.delete(recordId)
      return
  }
}

async function putRecord(
  type: SyncRecordType,
  payload: unknown,
): Promise<void> {
  switch (type) {
    case 'block':
      await db.blocks.put(payload as Block)
      return
    case 'category':
      await db.categories.put(payload as Category)
      return
    case 'budget':
      await db.budgets.put(payload as Budget)
      return
    case 'allocation':
      await db.budgetAllocations.put(payload as BudgetAllocation)
      return
  }
}
