/**
 * Signal Tracker — Daily monitor for all open/pending signals
 *
 * Runs at 4:05 PM IST (after market close, before scanners)
 *
 * Flow:
 *  1. PENDING signals from yesterday → confirm entry (auto or buy-stop check)
 *  2. OPEN signals → check SL / T1 / T2 from today's bar
 *  3. Save daily tracking row for each open signal
 *  4. Send Telegram report
 *
 * Run manually: node src/cron/jobs/signalTracker.js
 */

import axios       from 'axios';
import 'dotenv/config';
import YahooFinance from 'yahoo-finance2';
import {
  getPendingSignals, getOpenSignals,
  confirmEntry, markT1Hit, closeSignal,
  expireSignal, saveDailyTracking, getStats,
} from '../../db/signals.js';

const yf      = new YahooFinance({ suppressNotices: ['ripHistorical'] });
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const CONCURRENCY    = 8;
const PENDING_EXPIRY = 3; // days before PENDING signal is marked EXPIRED (buy-stop never triggered)

// ── Fetch today's OHLCV bar ───────────────────────────────────────────────────
async function fetchTodayBar(symbol) {
  try {
    const ticker = symbol.startsWith('^') ? symbol : `${symbol}.NS`;
    const now    = new Date();
    const from   = new Date(now);
    from.setDate(from.getDate() - 5); // 5 days back to ensure we get today

    const result = await yf.chart(ticker, { period1: from, period2: now, interval: '1d' });
    if (!result?.quotes?.length) return null;

    const bars = result.quotes
      .filter(q => q.close != null && q.open != null)
      .sort((a, b) => new Date(b.date) - new Date(a.date)); // newest first

    const today = bars[0];
    if (!today) return null;

    return {
      date:  new Date(today.date).toISOString().slice(0, 10),
      open:  today.open,
      high:  today.high,
      low:   today.low,
      close: today.adjclose ?? today.close,
    };
  } catch { return null; }
}

// ── Process PENDING signals (confirm entry or expire) ─────────────────────────
async function processPending(pending, today) {
  const confirmed = [], expired = [], stillPending = [];

  for (const sig of pending) {
    const bar = await fetchTodayBar(sig.symbol);
    if (!bar || bar.date !== today) { stillPending.push(sig); continue; }

    const signalAge = Math.round(
      (new Date(today) - new Date(sig.signal_date)) / 86400000
    );

    if (sig.entry_type === 'AUTO') {
      // Breakout / MTF: entry at next day's open
      confirmEntry(sig.id, bar.open, today);
      confirmed.push({ ...sig, entry_price: bar.open });

    } else if (sig.entry_type === 'BUY_STOP') {
      // HirenGabani / ConfV2: entry only if today's high crossed the trigger
      if (sig.entry_trigger && bar.high >= sig.entry_trigger) {
        confirmEntry(sig.id, sig.entry_trigger, today);
        confirmed.push({ ...sig, entry_price: sig.entry_trigger });
      } else if (signalAge >= PENDING_EXPIRY) {
        expireSignal(sig.id);
        expired.push(sig);
      } else {
        stillPending.push(sig);
      }
    }
  }

  return { confirmed, expired, stillPending };
}

// ── Process OPEN signals (check SL / T1 / T2) ────────────────────────────────
async function processOpen(open, today) {
  const closedToday = [], updates = [];

  for (const sig of open) {
    const bar = await fetchTodayBar(sig.symbol);
    if (!bar) { updates.push({ sig, bar: null, pnlPct: null, note: 'No data' }); continue; }

    const entry    = sig.entry_price;
    const pnlPct   = (bar.close - entry) / entry * 100;
    let   note     = null;
    let   closed   = false;

    // ── Check SL hit ──
    if (bar.low <= sig.sl) {
      const slPrice  = sig.sl;
      const slPnl    = (slPrice - entry) / entry * 100;
      const reason   = sig.scaled_out ? 'BE_SL' : 'SL_HIT';
      closeSignal(sig.id, slPrice, today, reason);
      closedToday.push({ sig, exitPrice: slPrice, pnlPct: slPnl, reason });
      closed = true;

    // ── Check T2 hit ──
    } else if (sig.t2 && bar.high >= sig.t2) {
      const t2Pnl = sig.scaled_out
        ? ((sig.t1 - entry) / entry * 100 * 0.5 + (sig.t2 - entry) / entry * 100 * 0.5)
        : (sig.t2 - entry) / entry * 100;
      closeSignal(sig.id, sig.t2, today, 'T2_HIT');
      closedToday.push({ sig, exitPrice: sig.t2, pnlPct: Math.round(t2Pnl * 100) / 100, reason: 'T2_HIT' });
      closed = true;

    // ── Check T1 hit (scale out, move SL to BE) ──
    } else if (sig.t1 && bar.high >= sig.t1 && !sig.scaled_out) {
      markT1Hit(sig.id);
      note = 'T1 HIT — SL moved to breakeven';
    }

    if (!closed) {
      saveDailyTracking(
        sig.id, today, bar,
        Math.round(pnlPct * 100) / 100,
        sig.scaled_out ? 'SCALED_OUT' : 'OPEN',
        note,
      );
      updates.push({ sig, bar, pnlPct: Math.round(pnlPct * 100) / 100, note });
    }
  }

  return { closedToday, updates };
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) { console.log(text); return; }
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID, text, parse_mode: 'HTML',
    });
  } catch (e) { console.error('[Tracker] Telegram failed:', e.message); }
}

// ── Format daily report ───────────────────────────────────────────────────────
function formatReport(today, confirmed, expired, closedToday, updates, stats) {
  let msg = `<b>Signal Tracker — ${today}</b>\n`;
  msg += `<i>${confirmed.length} confirmed | ${closedToday.length} closed today | ${updates.length} open</i>\n\n`;

  // Newly confirmed entries
  if (confirmed.length) {
    msg += `<b>New Entries (${confirmed.length})</b>\n`;
    for (const s of confirmed) {
      msg += `  <b>${s.symbol}</b> [${s.scanner}]  entry ₹${s.entry_price?.toFixed(2)}\n`;
      msg += `  SL ₹${s.sl}  |  T1 ${s.t1 ? '₹' + s.t1 : 'n/a'}  |  T2 ${s.t2 ? '₹' + s.t2 : 'n/a'}\n\n`;
    }
  }

  // Closed today
  if (closedToday.length) {
    msg += `<b>Closed Today (${closedToday.length})</b>\n`;
    for (const { sig, exitPrice, pnlPct, reason } of closedToday) {
      const sign = pnlPct >= 0 ? '+' : '';
      msg += `  <b>${sig.symbol}</b> [${sig.scanner}]  ${reason}  ${sign}${pnlPct?.toFixed(2)}%  exit ₹${exitPrice}\n`;
    }
    msg += '\n';
  }

  // Expired (buy-stop never triggered)
  if (expired.length) {
    msg += `<b>Expired (buy-stop not triggered)</b>\n`;
    for (const s of expired) msg += `  ${s.symbol} [${s.scanner}]\n`;
    msg += '\n';
  }

  // Open positions
  if (updates.length) {
    msg += `<b>Open Positions (${updates.length})</b>\n`;
    for (const { sig, bar, pnlPct, note } of updates) {
      if (!bar) { msg += `  ${sig.symbol} — no data\n`; continue; }
      const sign     = pnlPct >= 0 ? '+' : '';
      const days     = Math.round((new Date(today) - new Date(sig.entry_date)) / 86400000);
      const slGap    = ((bar.close - sig.sl) / bar.close * 100).toFixed(1);
      const t1Gap    = sig.t1 ? ((sig.t1 - bar.close) / bar.close * 100).toFixed(1) : null;
      const scaledStr = sig.scaled_out ? ' [T1 done, SL=BE]' : '';

      msg += `  <b>${sig.symbol}</b> [${sig.scanner}]  Day ${days}${scaledStr}\n`;
      msg += `  P&L: ${sign}${pnlPct}%  |  Close ₹${bar.close}  |  SL gap: -${slGap}%`;
      if (t1Gap) msg += `  |  T1 gap: +${t1Gap}%`;
      if (note)  msg += `  |  <i>${note}</i>`;
      msg += '\n\n';
    }
  }

  if (!confirmed.length && !closedToday.length && !updates.length) {
    msg += 'No active signals today.\n\n';
  }

  // Overall stats (only show if we have closed trades)
  if (stats.overall?.total > 0) {
    const o = stats.overall;
    const winPct = o.total > 0 ? Math.round(o.wins / o.total * 100) : 0;
    msg += `<b>All-time Stats</b>  (${o.total} closed)\n`;
    msg += `Win ${winPct}%  |  Avg P&amp;L ${o.avg_pnl}%  |  Best ${o.best_trade}%  |  Worst ${o.worst_trade}%\n`;
  }

  return msg;
}

// ── Main ──────────────────────────────────────────────────────────────────────
export async function runSignalTracker() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`[SignalTracker] Running for ${today}`);

  const pending = getPendingSignals();
  const open    = getOpenSignals();

  console.log(`[SignalTracker] ${pending.length} pending | ${open.length} open`);

  // Process in batches to avoid hammering Yahoo Finance
  const { confirmed, expired, stillPending } = await processPending(pending, today);
  const { closedToday, updates }             = await processOpen(open, today);

  console.log(`[SignalTracker] Confirmed: ${confirmed.length} | Closed: ${closedToday.length} | Still open: ${updates.length}`);

  const stats = getStats();
  const report = formatReport(today, confirmed, expired, closedToday, updates, stats);

  await sendTelegram(report);
  console.log('[SignalTracker] Report sent');
}

// ── Run directly ──────────────────────────────────────────────────────────────
if (process.argv[1].includes('signalTracker')) {
  runSignalTracker().catch(console.error);
}
