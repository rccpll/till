-- Till: voucher wallet schema.
-- Money is integer cents. Dates are ISO strings. Status transitions are guarded
-- in the API; this schema only enforces shape.

CREATE TABLE vouchers (
  id                TEXT PRIMARY KEY,
  issuer            TEXT NOT NULL,                 -- gift-card group, user-supplied at upload (e.g. 'coop')
  symbology         TEXT NOT NULL DEFAULT 'gs1-128',
  code              TEXT NOT NULL UNIQUE,          -- 34 digits; the dedupe key
  gtin              TEXT NOT NULL,                 -- AI (01)
  gs1_serial        TEXT NOT NULL,                 -- AI (21)
  printed_serial    TEXT,
  face_value_cents  INTEGER NOT NULL,
  remaining_cents   INTEGER NOT NULL,
  expires_at        TEXT NOT NULL,                 -- ISO yyyy-mm-dd
  status            TEXT NOT NULL CHECK (status IN ('available','used','voided')),
  barcode_png       BLOB,                          -- original crop, ~4.5 KB
  created_at        TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  used_at           TEXT,
  used_by           TEXT
);
CREATE INDEX idx_v_status  ON vouchers(status);
CREATE INDEX idx_v_expires ON vouchers(expires_at);

CREATE TABLE voucher_events (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id               TEXT NOT NULL REFERENCES vouchers(id),
  type                     TEXT NOT NULL CHECK (type IN
                             ('added','spent','used','unmarked','voided','already_empty','scan_failed')),
  amount_cents             INTEGER,
  previous_remaining_cents INTEGER,                -- makes un-mark trivial and auditable
  actor                    TEXT NOT NULL,
  note                     TEXT,
  client_action_id         TEXT UNIQUE,            -- idempotency for the offline queue
  created_at               TEXT NOT NULL
);
CREATE INDEX idx_e_voucher ON voucher_events(voucher_id);

CREATE TABLE gtin_amounts (
  gtin             TEXT PRIMARY KEY,
  face_value_cents INTEGER NOT NULL,
  confirmed_by     TEXT NOT NULL,
  confirmed_at     TEXT NOT NULL
);

CREATE TABLE app_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
