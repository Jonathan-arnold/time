/**
 * Wire types for the sync HTTP protocol. The server stores these rows
 * opaquely — it never decrypts `ciphertext` and never inspects what
 * `recordType`/`recordId` mean. The only fields it acts on are syncId,
 * deviceId, and seq (for routing and idempotency).
 */

/** Sent by clients on POST /sync/{syncId}/push, one row per change. */
export interface PushRow {
  deviceId: string
  seq: number
  /** Epoch ms of the local edit; used for LWW tiebreaking on peers. */
  updatedAt: number
  /** Encrypted JSON of { recordType, recordId, op, payload }. */
  ciphertext: string
}

/** Returned by the server on GET /sync/{syncId}/pull. */
export interface PullRow extends PushRow {}

export interface SetupResponse {
  /** Existing salt for this syncId, or a new one if first-time setup. */
  saltB64: string
  /** True if the syncId was already known (other device has set up). */
  existed: boolean
}

export interface PushRequest {
  rows: PushRow[]
}

export interface PullRequest {
  /** Highest seq already applied per peer device. */
  cursors: Record<string, number>
}

export interface PullResponse {
  rows: PullRow[]
}

/** Shape sealed inside each row's ciphertext. */
export interface SealedChange {
  recordType: 'block' | 'category' | 'budget' | 'allocation'
  recordId: string
  op: 'put' | 'del'
  payload: unknown
}
