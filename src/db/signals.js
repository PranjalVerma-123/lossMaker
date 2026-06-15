/**
 * Signal repository — all DB read/write operations
 */

import db from './db.js';

// ── Save a new signal ─────────────────────────────────────────────────────────
export function saveSignal(data) {
  // Prevent duplicate signals for same symbol+scanner on same date
  const existing = db.prepare(`
    SELECT id FROM signals
    WHERE symbol = ? AND scanner = ? AND signal_date = ? AND status IN ('PENDING','OPEN')
  `).get(data.symbol, data.scanner, data.signal_date);

  if (existing) return { duplicate: true, id: existing.id };

  const result = db.prepare(`
    INSERT INTO signals (
      scanner, symbol, signal_date, trade_type,
      entry_type, entry_trigger,
      sl, t1, t2, risk_pct,
      signal_close, signal_high, signal_low,
      forecast_bias, forecast_target, forecast_change_pct,
      forecast_peak, forecast_trough, forecast_upside_pct, forecast_downside_pct,
      nifty_close, meta
    ) VALUES (
      @scanner, @symbol, @signal_date, @trade_type,
      @entry_type, @entry_trigger,
      @sl, @t1, @t2, @risk_pct,
      @signal_close, @signal_high, @signal_low,
      @forecast_bias, @forecast_target, @forecast_change_pct,
      @forecast_peak, @forecast_trough, @forecast_upside_pct, @forecast_downside_pct,
      @nifty_close, @meta
    )
  `).run({
    scanner:              data.scanner,
    symbol:               data.symbol,
    signal_date:          data.signal_date,
    trade_type:           data.trade_type           ?? 'LONG',
    entry_type:           data.entry_type           ?? 'AUTO',
    entry_trigger:        data.entry_trigger        ?? null,
    sl:                   data.sl,
    t1:                   data.t1                   ?? null,
    t2:                   data.t2                   ?? null,
    risk_pct:             data.risk_pct             ?? null,
    signal_close:         data.signal_close         ?? null,
    signal_high:          data.signal_high          ?? null,
    signal_low:           data.signal_low           ?? null,
    forecast_bias:        data.forecast_bias        ?? null,
    forecast_target:      data.forecast_target      ?? null,
    forecast_change_pct:  data.forecast_change_pct  ?? null,
    forecast_peak:        data.forecast_peak        ?? null,
    forecast_trough:      data.forecast_trough      ?? null,
    forecast_upside_pct:  data.forecast_upside_pct  ?? null,
    forecast_downside_pct:data.forecast_downside_pct?? null,
    nifty_close:          data.nifty_close          ?? null,
    meta:                 data.meta ? JSON.stringify(data.meta) : null,
  });

  return { duplicate: false, id: result.lastInsertRowid };
}

// ── Entry confirmation ────────────────────────────────────────────────────────
export function confirmEntry(id, entryPrice, entryDate, isManual = false) {
  db.prepare(`
    UPDATE signals
    SET entry_price = ?, entry_date = ?, status = 'OPEN',
        entry_type = CASE WHEN ? THEN 'MANUAL' ELSE entry_type END
    WHERE id = ? AND status IN ('PENDING', 'OPEN')
  `).run(entryPrice, entryDate, isManual ? 1 : 0, id);
}

// ── T1 hit → scale out, move SL to breakeven ─────────────────────────────────
export function markT1Hit(id) {
  const sig = db.prepare('SELECT entry_price FROM signals WHERE id = ?').get(id);
  if (!sig) return;
  db.prepare(`
    UPDATE signals SET scaled_out = 1, sl = ? WHERE id = ?
  `).run(sig.entry_price, id);

  saveDailyNote(id, 'T1_HIT — SL moved to breakeven');
}

// ── Close a signal ────────────────────────────────────────────────────────────
export function closeSignal(id, exitPrice, exitDate, exitReason) {
  const sig = db.prepare('SELECT * FROM signals WHERE id = ?').get(id);
  if (!sig || !sig.entry_price) return;

  const pnlPct   = ((exitPrice - sig.entry_price) / sig.entry_price * 100);
  const holdDays = Math.round(
    (new Date(exitDate) - new Date(sig.entry_date)) / 86400000
  );

  db.prepare(`
    UPDATE signals
    SET status = 'CLOSED', exit_price = ?, exit_date = ?,
        exit_reason = ?, pnl_pct = ?, hold_days = ?
    WHERE id = ?
  `).run(exitPrice, exitDate, exitReason, Math.round(pnlPct * 100) / 100, holdDays, id);
}

// ── Skip / expire ─────────────────────────────────────────────────────────────
export function skipSignal(id)   { db.prepare(`UPDATE signals SET status = 'SKIPPED'  WHERE id = ?`).run(id); }
export function expireSignal(id) { db.prepare(`UPDATE signals SET status = 'EXPIRED'  WHERE id = ?`).run(id); }

// ── Daily tracking log ────────────────────────────────────────────────────────
export function saveDailyTracking(signalId, date, bar, pnlPct, status, note = null) {
  db.prepare(`
    INSERT INTO daily_tracking (signal_id, track_date, open, high, low, close, pnl_pct, status, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(signal_id, track_date) DO UPDATE SET
      open = excluded.open, high = excluded.high, low = excluded.low,
      close = excluded.close, pnl_pct = excluded.pnl_pct,
      status = excluded.status, note = excluded.note
  `).run(signalId, date, bar.open, bar.high, bar.low, bar.close,
         Math.round(pnlPct * 100) / 100, status, note);
}

function saveDailyNote(id, note) {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO daily_tracking (signal_id, track_date, note)
    VALUES (?, ?, ?)
    ON CONFLICT(signal_id, track_date) DO UPDATE SET note = excluded.note
  `).run(id, today, note);
}

// ── Queries ───────────────────────────────────────────────────────────────────
export function getPendingSignals() {
  return db.prepare(`SELECT * FROM signals WHERE status = 'PENDING' ORDER BY signal_date DESC`).all();
}

export function getOpenSignals() {
  return db.prepare(`SELECT * FROM signals WHERE status = 'OPEN' ORDER BY entry_date ASC`).all();
}

export function getActiveSignals() {
  return db.prepare(`SELECT * FROM signals WHERE status IN ('PENDING','OPEN') ORDER BY created_at DESC`).all();
}

export function getAllSignals(limit = 100) {
  return db.prepare(`SELECT * FROM signals ORDER BY created_at DESC LIMIT ?`).all(limit);
}

export function getSignalById(id) {
  return db.prepare(`SELECT * FROM signals WHERE id = ?`).get(id);
}

export function getOpenBySymbol(symbol) {
  return db.prepare(`
    SELECT * FROM signals WHERE symbol = ? AND status IN ('PENDING','OPEN')
    ORDER BY created_at DESC LIMIT 1
  `).get(symbol);
}

// ── Analytics ─────────────────────────────────────────────────────────────────
export function getStats() {
  const byScanner = db.prepare(`
    SELECT
      scanner,
      COUNT(*)                                                        AS total,
      SUM(CASE WHEN pnl_pct > 0  THEN 1 ELSE 0 END)                 AS wins,
      SUM(CASE WHEN pnl_pct <= 0 THEN 1 ELSE 0 END)                 AS losses,
      ROUND(AVG(pnl_pct), 2)                                         AS avg_pnl,
      ROUND(AVG(CASE WHEN pnl_pct > 0  THEN pnl_pct END), 2)        AS avg_win,
      ROUND(AVG(CASE WHEN pnl_pct <= 0 THEN pnl_pct END), 2)        AS avg_loss,
      ROUND(AVG(hold_days), 1)                                        AS avg_hold_days
    FROM signals WHERE status = 'CLOSED'
    GROUP BY scanner
  `).all();

  const byForecast = db.prepare(`
    SELECT
      forecast_bias,
      COUNT(*)                                              AS total,
      SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END)        AS wins,
      ROUND(AVG(pnl_pct), 2)                               AS avg_pnl
    FROM signals WHERE status = 'CLOSED' AND forecast_bias IS NOT NULL
    GROUP BY forecast_bias
  `).all();

  const byExitReason = db.prepare(`
    SELECT exit_reason, COUNT(*) AS count, ROUND(AVG(pnl_pct), 2) AS avg_pnl
    FROM signals WHERE status = 'CLOSED'
    GROUP BY exit_reason ORDER BY count DESC
  `).all();

  const overall = db.prepare(`
    SELECT
      COUNT(*)                                              AS total,
      SUM(CASE WHEN pnl_pct > 0  THEN 1 ELSE 0 END)       AS wins,
      SUM(CASE WHEN pnl_pct <= 0 THEN 1 ELSE 0 END)        AS losses,
      ROUND(AVG(pnl_pct), 2)                               AS avg_pnl,
      ROUND(MAX(pnl_pct), 2)                               AS best_trade,
      ROUND(MIN(pnl_pct), 2)                               AS worst_trade
    FROM signals WHERE status = 'CLOSED'
  `).get();

  return { overall, byScanner, byForecast, byExitReason };
}
