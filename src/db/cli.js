/**
 * Signal Tracker CLI — Manual commands
 *
 * Usage:
 *   node src/db/cli.js list                          — all active signals
 *   node src/db/cli.js all [limit]                  — all signals (default 50)
 *   node src/db/cli.js confirm <id> <price>         — manually confirm entry
 *   node src/db/cli.js close <id> <price> [reason]  — manually close a signal
 *   node src/db/cli.js skip <id>                    — skip/dismiss a signal
 *   node src/db/cli.js stats                        — win/loss analytics
 *   node src/db/cli.js show <id>                    — show full detail for one signal
 */

import 'dotenv/config';
import {
  getActiveSignals, getAllSignals, getSignalById,
  confirmEntry, closeSignal, skipSignal, getStats,
} from './signals.js';

const [,, cmd, ...args] = process.argv;
const today = new Date().toISOString().slice(0, 10);

function fmt(n) { return n != null ? String(n) : '—'; }
function pnlStr(p) {
  if (p == null) return '—';
  return (p >= 0 ? '+' : '') + p.toFixed(2) + '%';
}

// ── list ──────────────────────────────────────────────────────────────────────
if (!cmd || cmd === 'list') {
  const signals = getActiveSignals();
  if (!signals.length) { console.log('No active signals.'); process.exit(0); }

  console.log(`\n${'═'.repeat(100)}`);
  console.log(`  ACTIVE SIGNALS (${signals.length})`);
  console.log('═'.repeat(100));
  console.log(
    'ID'.padEnd(5) + 'Symbol'.padEnd(14) + 'Scanner'.padEnd(16) +
    'Date'.padEnd(12) + 'Status'.padEnd(10) + 'Entry'.padEnd(10) +
    'SL'.padEnd(10) + 'T1'.padEnd(10) + 'T2'.padEnd(10) + 'Type'
  );
  console.log('─'.repeat(100));
  for (const s of signals) {
    console.log(
      String(s.id).padEnd(5) +
      s.symbol.padEnd(14) +
      s.scanner.padEnd(16) +
      s.signal_date.padEnd(12) +
      s.status.padEnd(10) +
      fmt(s.entry_price).padEnd(10) +
      fmt(s.sl).padEnd(10) +
      fmt(s.t1).padEnd(10) +
      fmt(s.t2).padEnd(10) +
      (s.entry_type ?? '')
    );
  }
  console.log('═'.repeat(100) + '\n');
}

// ── all ───────────────────────────────────────────────────────────────────────
else if (cmd === 'all') {
  const limit   = parseInt(args[0]) || 50;
  const signals = getAllSignals(limit);
  if (!signals.length) { console.log('No signals found.'); process.exit(0); }

  console.log(`\n${'═'.repeat(110)}`);
  console.log(`  ALL SIGNALS — last ${limit}`);
  console.log('═'.repeat(110));
  console.log(
    'ID'.padEnd(5) + 'Symbol'.padEnd(14) + 'Scanner'.padEnd(16) +
    'Date'.padEnd(12) + 'Status'.padEnd(10) + 'Entry'.padEnd(10) +
    'Exit'.padEnd(10) + 'P&L'.padEnd(10) + 'Days'.padEnd(6) + 'Exit Reason'
  );
  console.log('─'.repeat(110));
  for (const s of signals) {
    console.log(
      String(s.id).padEnd(5) +
      s.symbol.padEnd(14) +
      s.scanner.padEnd(16) +
      s.signal_date.padEnd(12) +
      s.status.padEnd(10) +
      fmt(s.entry_price).padEnd(10) +
      fmt(s.exit_price).padEnd(10) +
      pnlStr(s.pnl_pct).padEnd(10) +
      fmt(s.hold_days).padEnd(6) +
      (s.exit_reason ?? '—')
    );
  }
  console.log('═'.repeat(110) + '\n');
}

// ── show <id> ─────────────────────────────────────────────────────────────────
else if (cmd === 'show') {
  const id  = parseInt(args[0]);
  const sig = getSignalById(id);
  if (!sig) { console.log(`Signal ${id} not found.`); process.exit(1); }

  const meta = sig.meta ? JSON.parse(sig.meta) : {};
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Signal #${sig.id} — ${sig.symbol} [${sig.scanner}]`);
  console.log('═'.repeat(60));
  console.log(`  Status        : ${sig.status}`);
  console.log(`  Signal date   : ${sig.signal_date}`);
  console.log(`  Trade type    : ${sig.trade_type}`);
  console.log(`  Entry type    : ${sig.entry_type}`);
  console.log(`  Entry trigger : ${fmt(sig.entry_trigger)}`);
  console.log(`  Entry price   : ${fmt(sig.entry_price)}  (${sig.entry_date ?? 'not yet'})`);
  console.log(`  SL            : ${fmt(sig.sl)}  ${sig.scaled_out ? '[moved to BE]' : ''}`);
  console.log(`  T1            : ${fmt(sig.t1)}`);
  console.log(`  T2            : ${fmt(sig.t2)}`);
  console.log(`  Risk          : ${fmt(sig.risk_pct)}%`);
  console.log(`  Signal close  : ${fmt(sig.signal_close)}`);
  if (sig.status === 'CLOSED') {
    console.log(`  Exit price    : ${fmt(sig.exit_price)}  (${sig.exit_date})`);
    console.log(`  Exit reason   : ${sig.exit_reason}`);
    console.log(`  P&L           : ${pnlStr(sig.pnl_pct)}`);
    console.log(`  Hold days     : ${fmt(sig.hold_days)}`);
  }
  if (sig.forecast_bias) {
    console.log(`\n  ── Forecast ──`);
    console.log(`  Bias          : ${sig.forecast_bias}`);
    console.log(`  Target        : ₹${fmt(sig.forecast_target)}  (${fmt(sig.forecast_change_pct)}%)`);
    console.log(`  Peak / Trough : ₹${fmt(sig.forecast_peak)} / ₹${fmt(sig.forecast_trough)}`);
  }
  if (Object.keys(meta).length) {
    console.log(`\n  ── Metadata ──`);
    for (const [k, v] of Object.entries(meta)) console.log(`  ${k.padEnd(14)}: ${v}`);
  }
  console.log('═'.repeat(60) + '\n');
}

// ── confirm <id> <price> ──────────────────────────────────────────────────────
else if (cmd === 'confirm') {
  const id    = parseInt(args[0]);
  const price = parseFloat(args[1]);
  if (!id || !price) { console.log('Usage: node cli.js confirm <id> <price>'); process.exit(1); }
  confirmEntry(id, price, today, true);
  console.log(`Signal #${id} confirmed — entry ₹${price} on ${today}`);
}

// ── close <id> <price> [reason] ───────────────────────────────────────────────
else if (cmd === 'close') {
  const id     = parseInt(args[0]);
  const price  = parseFloat(args[1]);
  const reason = args[2]?.toUpperCase() || 'MANUAL';
  if (!id || !price) { console.log('Usage: node cli.js close <id> <price> [reason]'); process.exit(1); }
  closeSignal(id, price, today, reason);
  const sig = getSignalById(id);
  console.log(`Signal #${id} (${sig?.symbol}) closed — exit ₹${price}  P&L: ${pnlStr(sig?.pnl_pct)}  reason: ${reason}`);
}

// ── skip <id> ─────────────────────────────────────────────────────────────────
else if (cmd === 'skip') {
  const id = parseInt(args[0]);
  if (!id) { console.log('Usage: node cli.js skip <id>'); process.exit(1); }
  skipSignal(id);
  const sig = getSignalById(id);
  console.log(`Signal #${id} (${sig?.symbol}) marked as SKIPPED`);
}

// ── stats ─────────────────────────────────────────────────────────────────────
else if (cmd === 'stats') {
  const s = getStats();

  if (!s.overall?.total) { console.log('No closed trades yet.'); process.exit(0); }

  const o = s.overall;
  const winPct = Math.round(o.wins / o.total * 100);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  OVERALL STATS  (${o.total} closed trades)`);
  console.log('═'.repeat(60));
  console.log(`  Win rate    : ${winPct}%  (${o.wins}W / ${o.losses}L)`);
  console.log(`  Avg P&L     : ${pnlStr(o.avg_pnl)}`);
  console.log(`  Best trade  : ${pnlStr(o.best_trade)}`);
  console.log(`  Worst trade : ${pnlStr(o.worst_trade)}`);

  if (s.byScanner.length) {
    console.log(`\n── By Scanner ──`);
    for (const r of s.byScanner) {
      const wp = r.total > 0 ? Math.round(r.wins / r.total * 100) : 0;
      console.log(
        `  ${r.scanner.padEnd(16)} ${r.total} trades | Win ${wp}% | Avg ${pnlStr(r.avg_pnl)} | ` +
        `AvgWin ${pnlStr(r.avg_win)} | AvgLoss ${pnlStr(r.avg_loss)} | Hold ${r.avg_hold_days}d`
      );
    }
  }

  if (s.byForecast.length) {
    console.log(`\n── Forecast Accuracy ──`);
    for (const r of s.byForecast) {
      const wp = r.total > 0 ? Math.round(r.wins / r.total * 100) : 0;
      console.log(`  ${r.forecast_bias.padEnd(10)} ${r.total} trades | Win ${wp}% | Avg ${pnlStr(r.avg_pnl)}`);
    }
  }

  if (s.byExitReason.length) {
    console.log(`\n── Exit Reasons ──`);
    for (const r of s.byExitReason) {
      console.log(`  ${r.exit_reason.padEnd(16)} ${r.count} trades | Avg ${pnlStr(r.avg_pnl)}`);
    }
  }

  console.log('═'.repeat(60) + '\n');
}

else {
  console.log(`
Signal Tracker CLI
  node src/db/cli.js list                         — active signals
  node src/db/cli.js all [limit]                  — all signals
  node src/db/cli.js show <id>                    — signal detail
  node src/db/cli.js confirm <id> <price>         — confirm entry manually
  node src/db/cli.js close <id> <price> [reason]  — close manually
  node src/db/cli.js skip <id>                    — skip signal
  node src/db/cli.js stats                        — analytics
`);
}
