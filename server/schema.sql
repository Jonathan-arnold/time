CREATE TABLE IF NOT EXISTS sync_salts (
  sync_id TEXT PRIMARY KEY,
  salt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_rows (
  sync_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ciphertext TEXT NOT NULL,
  PRIMARY KEY (sync_id, device_id, seq)
);

CREATE INDEX IF NOT EXISTS sync_rows_by_sync ON sync_rows(sync_id, seq);
