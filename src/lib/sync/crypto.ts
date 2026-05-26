/**
 * Symmetric crypto for the sync protocol. The threat model is: the server must
 * never see plaintext data or even know which records changed. Local-device
 * attackers are out of scope (they can read IndexedDB anyway).
 *
 * - Keys are derived from a user passphrase via Argon2id.
 * - Record payloads are sealed with XChaCha20-Poly1305 (libsodium secretbox).
 * - Requests are signed with HMAC-SHA256 using a separate auth key.
 *
 * We use `libsodium-wrappers-sumo` rather than the slim default, because the
 * default build omits `crypto_pwhash` (Argon2id) and `crypto_auth_hmacsha256`.
 * All exported helpers `await sodium.ready` first so callers don't have to.
 */
import sodium from 'libsodium-wrappers-sumo'

/** Resolve once libsodium's wasm has finished initializing. */
export function readyCrypto(): Promise<void> {
  return sodium.ready
}

export interface DerivedKeys {
  kEnc: Uint8Array
  kAuth: Uint8Array
}

/**
 * Argon2id passphrase → (kEnc, kAuth). The 64-byte output is split in half
 * so the encryption key and the request-signing key are independent.
 * `INTERACTIVE` ops/memory are right for a personal app — strong enough that
 * a stolen blob isn't trivially brute-forced, fast enough that setup on a
 * phone doesn't feel broken.
 */
export async function deriveKeys(
  passphrase: string,
  saltB64: string,
): Promise<DerivedKeys> {
  await sodium.ready
  const salt = sodium.from_base64(saltB64, sodium.base64_variants.ORIGINAL)
  const out = sodium.crypto_pwhash(
    64,
    passphrase,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  )
  return { kEnc: out.subarray(0, 32), kAuth: out.subarray(32, 64) }
}

/** Generate a 16-byte salt, base64 (libsodium ORIGINAL variant). */
export async function newSaltB64(): Promise<string> {
  await sodium.ready
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES)
  return sodium.to_base64(salt, sodium.base64_variants.ORIGINAL)
}

/**
 * Encrypt a JSON-serializable payload. Output: base64 of `nonce || ciphertext`,
 * which is the standard "self-contained sealed message" shape — recipients
 * don't need a separate nonce field.
 */
export async function encryptJson(
  value: unknown,
  kEnc: Uint8Array,
): Promise<string> {
  await sodium.ready
  const plaintext = sodium.from_string(JSON.stringify(value))
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, kEnc)
  const combined = new Uint8Array(nonce.length + ciphertext.length)
  combined.set(nonce, 0)
  combined.set(ciphertext, nonce.length)
  return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL)
}

/** Inverse of {@link encryptJson}. Returns the decoded JSON value. */
export async function decryptJson<T = unknown>(
  combinedB64: string,
  kEnc: Uint8Array,
): Promise<T> {
  await sodium.ready
  const combined = sodium.from_base64(combinedB64, sodium.base64_variants.ORIGINAL)
  const nonce = combined.subarray(0, sodium.crypto_secretbox_NONCEBYTES)
  const ciphertext = combined.subarray(sodium.crypto_secretbox_NONCEBYTES)
  const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, kEnc)
  return JSON.parse(sodium.to_string(plaintext)) as T
}

/**
 * HMAC-SHA256 of a request, hex-encoded. Inputs are concatenated with `\n`
 * so the signature commits to method/path/syncId/body together — a server
 * that re-signs an attacker's modified body would have to forge the MAC.
 */
export async function signRequest(
  kAuth: Uint8Array,
  method: string,
  path: string,
  syncId: string,
  body: string,
): Promise<string> {
  await sodium.ready
  const msg = sodium.from_string([method, path, syncId, body].join('\n'))
  const mac = sodium.crypto_auth_hmacsha256(msg, kAuth)
  return sodium.to_hex(mac)
}

/** Base64-encode raw bytes for storage in syncMeta. */
export async function bytesToB64(b: Uint8Array): Promise<string> {
  await sodium.ready
  return sodium.to_base64(b, sodium.base64_variants.ORIGINAL)
}

/** Decode a base64 string from syncMeta back to raw bytes. */
export async function b64ToBytes(s: string): Promise<Uint8Array> {
  await sodium.ready
  return sodium.from_base64(s, sodium.base64_variants.ORIGINAL)
}
