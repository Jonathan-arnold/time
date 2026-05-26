/**
 * Minimal sync server for the Time Budget app, designed to run as a
 * Cloudflare Worker. Two routes:
 *
 *   POST /sync/{syncId}/push    -> store opaque encrypted rows
 *   POST /sync/{syncId}/pull    -> return rows past per-device cursors
 *
 * The server never decrypts ciphertext and never inspects sealed payloads.
 * It treats syncId as an opaque routing key — clients derive it
 * deterministically from (username, passphrase), so no setup or salt
 * distribution endpoint is needed.
 *
 * Auth: this v1 accepts any well-formed signed request. The brute-force
 * barrier is that `syncId` is the output of Argon2id over the passphrase;
 * a stranger has to guess both the username and the passphrase before
 * they can even derive the bucket. Hardening (Ed25519 request signatures
 * pinned at first push) is a documented follow-up.
 *
 * Storage adapters:
 *   - MemoryStore for `wrangler dev` smoke tests (volatile).
 *   - D1Store for production; bind `DB` in wrangler.toml.
 */

export interface Env {
  /** Optional D1 binding. If unset, falls back to in-process memory store. */
  DB?: D1Database
}

interface StoredRow {
  deviceId: string
  seq: number
  updatedAt: number
  ciphertext: string
}

interface Store {
  /** Idempotent: re-inserting (syncId, deviceId, seq) is a no-op. */
  appendRows(syncId: string, rows: StoredRow[]): Promise<void>
  rowsAfter(
    syncId: string,
    cursors: Record<string, number>,
  ): Promise<StoredRow[]>
}

// --- Memory adapter (wrangler dev / unit tests) -----------------------------

class MemoryStore implements Store {
  private rows = new Map<string, StoredRow[]>()

  async appendRows(syncId: string, rows: StoredRow[]) {
    const bucket = this.rows.get(syncId) ?? []
    const seen = new Set(bucket.map((r) => `${r.deviceId}:${r.seq}`))
    for (const r of rows) {
      if (seen.has(`${r.deviceId}:${r.seq}`)) continue
      bucket.push(r)
      seen.add(`${r.deviceId}:${r.seq}`)
    }
    this.rows.set(syncId, bucket)
  }
  async rowsAfter(syncId: string, cursors: Record<string, number>) {
    const bucket = this.rows.get(syncId) ?? []
    return bucket
      .filter((r) => r.seq > (cursors[r.deviceId] ?? 0))
      .sort((a, b) => a.seq - b.seq)
  }
}

// --- D1 adapter -------------------------------------------------------------

class D1Store implements Store {
  constructor(private db: D1Database) {}

  async appendRows(syncId: string, rows: StoredRow[]) {
    if (rows.length === 0) return
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO sync_rows (sync_id, device_id, seq, updated_at, ciphertext) VALUES (?, ?, ?, ?, ?)',
    )
    await this.db.batch(
      rows.map((r) =>
        stmt.bind(syncId, r.deviceId, r.seq, r.updatedAt, r.ciphertext),
      ),
    )
  }
  async rowsAfter(syncId: string, cursors: Record<string, number>) {
    // Simple approach: pull everything for this syncId and filter in JS.
    // Sync volumes per user are tiny (years of personal data = MBs), so the
    // index scan is cheap.
    const result = await this.db
      .prepare(
        'SELECT device_id, seq, updated_at, ciphertext FROM sync_rows WHERE sync_id = ? ORDER BY seq ASC',
      )
      .bind(syncId)
      .all<{
        device_id: string
        seq: number
        updated_at: number
        ciphertext: string
      }>()
    return (result.results ?? [])
      .filter((r) => r.seq > (cursors[r.device_id] ?? 0))
      .map((r) => ({
        deviceId: r.device_id,
        seq: r.seq,
        updatedAt: r.updated_at,
        ciphertext: r.ciphertext,
      }))
  }
}

// --- Router -----------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-sync-sig',
      'access-control-allow-methods': 'POST, OPTIONS',
    },
  })
}

const memStore = new MemoryStore()

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'content-type, x-sync-sig',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-max-age': '86400',
        },
      })
    }

    const url = new URL(req.url)
    const match = url.pathname.match(/^\/sync\/([^/]+)\/(push|pull)$/)
    if (!match || req.method !== 'POST') {
      return json({ error: 'not found' }, 404)
    }
    const syncId = match[1]
    const action = match[2]
    const store: Store = env.DB ? new D1Store(env.DB) : memStore

    // Require the signature header — keeps casual scanners from poking buckets.
    // Real cryptographic verification is a documented follow-up.
    if (!req.headers.get('x-sync-sig')) {
      return json({ error: 'unauthorized' }, 401)
    }

    const body = await req.text()

    if (action === 'push') {
      const { rows } = JSON.parse(body) as { rows: StoredRow[] }
      if (!Array.isArray(rows) || rows.length > 5000) {
        return json({ error: 'bad rows' }, 400)
      }
      await store.appendRows(syncId, rows)
      return json({ ok: true, accepted: rows.length })
    }

    if (action === 'pull') {
      const { cursors } = JSON.parse(body) as {
        cursors?: Record<string, number>
      }
      const rows = await store.rowsAfter(syncId, cursors ?? {})
      return json({ rows })
    }

    return json({ error: 'not found' }, 404)
  },
}
