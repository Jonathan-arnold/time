# time-sync worker

Minimal Cloudflare Worker backing the Time Budget app's end-to-end encrypted sync.

## Local dev

```sh
cd server
npx wrangler dev
```

Defaults to `http://localhost:8787`. Storage is in-memory and resets every restart — fine for round-trip testing the client.

## Production

1. `npx wrangler d1 create time-sync` and copy the `database_id` into `wrangler.toml`.
2. `npx wrangler d1 execute time-sync --file schema.sql`
3. Uncomment the `[[d1_databases]]` block in `wrangler.toml`.
4. `npx wrangler deploy`.

## What the server sees

Per-user: an opaque `syncId` (the output of Argon2id over the client's passphrase + username), a per-device `deviceId`, monotonic `seq` numbers, ciphertext sizes, and push timestamps. **Never:** plaintext data, record types, usernames, or the passphrase.

## What it doesn't do (intentionally)

- **No setup endpoint.** Clients derive `syncId` and keys deterministically from `(username, passphrase)`, so a second device joins by typing the same pair — no server round-trip to fetch a salt.
- **Passphrase rotation.** Changes the syncId and keys; you'd have to migrate the log. Out of scope for v1.
- **Account recovery.** Lose the username or passphrase → data is unrecoverable. The server has nothing to help with.
- **Real signature verification.** v1 only checks that the `x-sync-sig` header is present. The brute-force barrier is Argon2id on the client; an attacker still has to guess both username and passphrase to derive any valid `syncId`. Ed25519-pinning on first push is the documented hardening path.
- **Log compaction.** Years of personal time data fits in a few MB; revisit if it ever matters.
