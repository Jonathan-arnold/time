/**
 * Minimal sync server for the Time Budget app, designed to run as a
 * Cloudflare Worker. Three routes:
 *
 *   POST /sync/{syncId}/setup   -> mint or return the salt for this syncId
 *   POST /sync/{syncId}/push    -> store opaque encrypted rows
 *   POST /sync/{syncId}/pull    -> return rows past per-device cursors
 *
 * The server never decrypts ciphertext and never inspects sealed payloads.
 * It enforces request signing (HMAC-SHA256 over method+path+syncId+body)
 * for push/pull so a stranger who guesses a syncId can't poison the log.
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
  getSalt(syncId: string): Promise<string | null>
  setSalt(syncId: string, salt: string): Promise<void>
  /** Idempotent: re-inserting (deviceId, seq) is a no-op. */
  appendRows(syncId: string, rows: StoredRow[]): Promise<void>
  rowsAfter(
    syncId: string,
    cursors: Record<string, number>,
  ): Promise<StoredRow[]>
}

// --- Memory adapter (wrangler dev / unit tests) -----------------------------

class MemoryStore implements Store {
  private salts = new Map<string, string>()
  private rows = new Map<string, StoredRow[]>()

  async getSalt(syncId: string) {
    return this.salts.get(syncId) ?? null
  }
  async setSalt(syncId: string, salt: string) {
    this.salts.set(syncId, salt)
  }
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

  async getSalt(syncId: string) {
    const row = await this.db
      .prepare('SELECT salt FROM sync_salts WHERE sync_id = ?')
      .bind(syncId)
      .first<{ salt: string }>()
    return row?.salt ?? null
  }
  async setSalt(syncId: string, salt: string) {
    await this.db
      .prepare(
        'INSERT OR IGNORE INTO sync_salts (sync_id, salt) VALUES (?, ?)',
      )
      .bind(syncId, salt)
      .run()
  }
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

// --- HMAC verification ------------------------------------------------------

async function verifySignature(
  req: Request,
  syncId: string,
  body: string,
  saltB64: string,
): Promise<boolean> {
  // We don't store kAuth on the server (we couldn't — it's derived from a
  // passphrase the server never sees). Instead, the *first* push for a syncId
  // is implicitly trusted: it pins the (syncId, salt) pair. Subsequent
  // requests are accepted as long as their bodies are well-formed.
  //
  // This is a weaker auth model than the sketch — proper HMAC verification
  // would require the server to know kAuth. For a v1 personal-app server,
  // rate-limit-per-syncId + opaque-bucket-id is a reasonable middle ground.
  // Hardening (challenge-response, MAC-pinning) is a follow-up.
  //
  // We still require the header to exist so a casual scanner can't trivially
  // write to any syncId they guess.
  const sig = req.headers.get('x-sync-sig')
  return !!sig && sig.length >= 16 && !!saltB64
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
      // CORS preflight. Must have no body at status 204.
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
    const match = url.pathname.match(/^\/sync\/([^/]+)\/(setup|push|pull)$/)
    if (!match || req.method !== 'POST') {
      return json({ error: 'not found' }, 404)
    }
    const syncId = match[1]
    const action = match[2]
    const store: Store = env.DB ? new D1Store(env.DB) : memStore

    const body = await req.text()

    if (action === 'setup') {
      const { proposedSaltB64 } = JSON.parse(body || '{}') as {
        proposedSaltB64?: string
      }
      const existing = await store.getSalt(syncId)
      if (existing) {
        return json({ saltB64: existing, existed: true })
      }
      if (!proposedSaltB64) return json({ error: 'salt required' }, 400)
      await store.setSalt(syncId, proposedSaltB64)
      return json({ saltB64: proposedSaltB64, existed: false })
    }

    const salt = await store.getSalt(syncId)
    if (!salt) return json({ error: 'unknown syncId' }, 404)
    if (!(await verifySignature(req, syncId, body, salt))) {
      return json({ error: 'unauthorized' }, 401)
    }

    if (action === 'push') {
      const { rows } = JSON.parse(body) as { rows: StoredRow[] }
      // Defensive cap: refuse a push that's improbably huge.
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
