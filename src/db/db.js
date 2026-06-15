/**
 * SQLite connection + schema
 * Database file: data/signals.db
 */

import Database from 'better-sqlite3';
import path     from 'path';
import fs       from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR    = path.join(__dirname, '..', '..', 'data');
const DB_PATH   = path.join(DB_DIR, 'signals.db');

fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // better concurrent read performance
db.pragma('foreign_keys = ON');

db.exec(`
  -- ── Main signals table ───────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS signals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    scanner         TEXT NOT NULL,        -- 'breakout' | 'hiren_gabani' | 'confluence_v2' | 'mtf'
    symbol          TEXT NOT NULL,
    signal_date     TEXT NOT NULL,        -- YYYY-MM-DD when signal was generated
    trade_type      TEXT DEFAULT 'LONG',  -- 'LONG' | 'SHORT'

    -- Entry
    entry_type      TEXT DEFAULT 'AUTO',  -- 'AUTO' (next open) | 'BUY_STOP' (price must cross) | 'MANUAL'
    entry_trigger   REAL,                 -- for BUY_STOP: price that must be crossed
    entry_price     REAL,                 -- actual entry price (filled after confirmation)
    entry_date      TEXT,                 -- YYYY-MM-DD of actual entry

    -- Levels (at signal time)
    sl              REAL NOT NULL,
    t1              REAL,
    t2              REAL,
    risk_pct        REAL,

    -- Status
    status          TEXT DEFAULT 'PENDING',  -- PENDING | OPEN | CLOSED | SKIPPED | EXPIRED
    scaled_out      INTEGER DEFAULT 0,        -- 1 = T1 hit, SL moved to breakeven
    exit_price      REAL,
    exit_date       TEXT,
    exit_reason     TEXT,   -- SL_HIT | T1_HIT | T2_HIT | BE_SL | MANUAL | EXPIRED | EMA_EXIT
    pnl_pct         REAL,
    hold_days       INTEGER,

    -- Price context on signal day
    signal_close    REAL,
    signal_high     REAL,
    signal_low      REAL,

    -- Forecast (from forecast API at signal time)
    forecast_bias           TEXT,   -- BULLISH | BEARISH | NEUTRAL
    forecast_target         REAL,   -- predicted end price (22d)
    forecast_change_pct     REAL,
    forecast_peak           REAL,
    forecast_trough         REAL,
    forecast_upside_pct     REAL,
    forecast_downside_pct   REAL,

    -- Market context
    nifty_close     REAL,

    -- Scanner-specific metadata (JSON string)
    meta            TEXT,

    created_at      TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- ── Daily tracking: one row per signal per day ───────────────────────────
  CREATE TABLE IF NOT EXISTS daily_tracking (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id   INTEGER NOT NULL,
    track_date  TEXT NOT NULL,
    open        REAL,
    high        REAL,
    low         REAL,
    close       REAL,
    pnl_pct     REAL,
    status      TEXT,
    note        TEXT,
    FOREIGN KEY (signal_id) REFERENCES signals(id),
    UNIQUE(signal_id, track_date)
  );

  -- ── Indexes ──────────────────────────────────────────────────────────────
  CREATE INDEX IF NOT EXISTS idx_signals_status   ON signals(status);
  CREATE INDEX IF NOT EXISTS idx_signals_symbol   ON signals(symbol);
  CREATE INDEX IF NOT EXISTS idx_signals_scanner  ON signals(scanner);
  CREATE INDEX IF NOT EXISTS idx_signals_date     ON signals(signal_date);
`);

export default db;
