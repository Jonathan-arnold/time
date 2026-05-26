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

Per-user: a random `syncId`, a per-device `deviceId`, monotonic `seq` numbers, ciphertext sizes, and push timestamps. **Never:** plaintext data, record types, or the passphrase.

## What it doesn't do (intentionally)

- **Passphrase rotation.** Re-encrypting the whole log is left to a future migration.
- **Account recovery.** Lose the passphrase + sync ID → data is unrecoverable. This is the deal.
- **HMAC verification.** v1 accepts any well-formed signed request for a known `syncId`. Hardening (challenge-response or MAC pinning at setup time) is a follow-up; the bucket id is opaque enough that this is acceptable for a personal-scale deployment.
- **Log compaction.** Years of personal time data fits in a few MB; revisit if it ever matters.
