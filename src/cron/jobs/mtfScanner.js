/**
 * MTF False Breakout Scanner — Daily post-market cron
 *
 * Runs Mon–Fri after market close (4:15 PM IST)
 * Scans F&O stocks for:
 *   SHORT setup → today's candle pierced above Prev Week High but closed below it
 *   LONG  setup → today's candle pierced below Prev Week Low  but closed above it
 *
 * Sends Telegram alert with entry zone, SL, T1, T2 for paper trading.
 * Run manually: node src/cron/jobs/mtfScanner.js
 */

import axios from 'axios';
import 'dotenv/config';
import { downloadBatch, resampleWeekly } from '../../services/yFinance/index.js';
import { ALL_OPTION_STOCKS } from '../../constant/nseStocks.js';
import { fetchForecast } from '../../api/api.js';
import { saveSignal }    from '../../db/signals.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ── Config ────────────────────────────────────────────────────────────────────
const SL_BUFFER_PCT = 0.3;    // % above/below signal candle for SL
const MIN_RISK_PCT  = 0.5;    // skip if risk < 0.5%
const MAX_RISK_PCT  = 8;      // skip if risk > 8%

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('\n[Telegram] (not configured — printing to console)\n');
    console.log(text);
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID, text, parse_mode: 'HTML',
    });
  } catch (e) {
    console.error('[Telegram] Failed:', e.message);
  }
}

// ── Analyse one stock ─────────────────────────────────────────────────────────
function analyseStock(symbol, bars) {
  if (!bars || bars.length < 15) return null;

  // Get previous completed week's H/L via weekly resample
  const weekly = resampleWeekly(bars);
  if (weekly.length < 2) return null;

  // weekly[-1] is the current (possibly incomplete) week
  // weekly[-2] is the previous completed week
  const prevWeek = weekly[weekly.length - 2];
  const pwh = prevWeek.high;
  const pwl = prevWeek.low;

  // Today is the last daily bar
  const today = bars[bars.length - 1];
  const { high, low, close, open } = today;
  const date = today.date.toISOString().slice(0, 10);

  // ── False Breakout (SHORT setup) ──────────────────────────────────────────
  if (high > pwh && close < pwh) {
    const sl      = +(high * (1 + SL_BUFFER_PCT / 100)).toFixed(2);
    // Entry = next morning open ≈ today's close (approx)
    const entry   = close;
    const risk    = sl - entry;
    const riskPct = +(risk / entry * 100).toFixed(2);
    if (riskPct < MIN_RISK_PCT || riskPct > MAX_RISK_PCT) return null;
    const t1 = +(entry - risk).toFixed(2);            // 1:1
    const t2 = +pwl.toFixed(2);                       // prev week low
    const rr = +((entry - t2) / risk).toFixed(1);    // total R:R to T2

    return {
      symbol, type: 'SHORT', date,
      pwh: +pwh.toFixed(2), pwl: +pwl.toFixed(2),
      sigHigh: +high.toFixed(2), sigLow: +low.toFixed(2),
      close: +close.toFixed(2),
      entryZone: +close.toFixed(2),   // next morning open near this
      sl, t1, t2, riskPct, rr,
    };
  }

  // ── False Breakdown (LONG setup) ──────────────────────────────────────────
  if (low < pwl && close > pwl) {
    const sl      = +(low * (1 - SL_BUFFER_PCT / 100)).toFixed(2);
    const entry   = close;
    const risk    = entry - sl;
    const riskPct = +(risk / entry * 100).toFixed(2);
    if (riskPct < MIN_RISK_PCT || riskPct > MAX_RISK_PCT) return null;
    const t1 = +(entry + risk).toFixed(2);            // 1:1
    const t2 = +pwh.toFixed(2);                       // prev week high
    const rr = +((t2 - entry) / risk).toFixed(1);

    return {
      symbol, type: 'LONG', date,
      pwh: +pwh.toFixed(2), pwl: +pwl.toFixed(2),
      sigHigh: +high.toFixed(2), sigLow: +low.toFixed(2),
      close: +close.toFixed(2),
      entryZone: +close.toFixed(2),
      sl, t1, t2, riskPct, rr,
    };
  }

  return null;
}

// ── Format single-signal Telegram message ─────────────────────────────────────
function formatSignalMessage(s, scanDate, forecast) {
  const isShort = s.type === 'SHORT';
  const typeLabel = isShort
    ? 'SHORT — false breakout above prev week high'
    : 'LONG  — false breakdown below prev week low';
  const cashNote = isShort
    ? '<i>Requires F&amp;O — paper trade if cash delivery</i>'
    : '<i>Cash delivery friendly</i>';

  let msg = `<b>MTF False Breakout — ${s.symbol}</b>  [${scanDate}]\n`;
  msg += `${typeLabel}\n${cashNote}\n\n`;

  if (isShort) {
    msg += `  Prev Week High : ₹${s.pwh}\n`;
    msg += `  Signal candle  : H ₹${s.sigHigh}  C ₹${s.close}\n`;
  } else {
    msg += `  Prev Week Low  : ₹${s.pwl}\n`;
    msg += `  Signal candle  : L ₹${s.sigLow}  C ₹${s.close}\n`;
  }
  msg += `  Entry zone     : ₹${s.entryZone}  (next open — wait for 15-min MSS)\n`;
  msg += `  SL             : ₹${s.sl}\n`;
  msg += `  T1 (1:1)       : ₹${s.t1}\n`;
  msg += `  T2 (full exit) : ₹${s.t2}  (${isShort ? 'prev week low' : 'prev week high'})\n`;
  msg += `  Risk           : ${s.riskPct}%  |  R:R to T2: 1:${s.rr}\n`;

  if (forecast) {
    const biasIcon = forecast.bias === 'BULLISH' ? '▲' : forecast.bias === 'BEARISH' ? '▼' : '—';
    msg += `\n  — Forecast (22d) —\n`;
    msg += `  Bias         : ${biasIcon} ${forecast.bias}\n`;
    msg += `  Target price : ₹${forecast.end_price.toFixed(2)}  (${forecast.change_pct >= 0 ? '+' : ''}${forecast.change_pct.toFixed(2)}%)\n`;
    msg += `  Peak / Trough: ₹${forecast.peak.toFixed(2)} / ₹${forecast.trough.toFixed(2)}\n`;
    msg += `  Upside / Down: +${forecast.upside_pct.toFixed(2)}% / ${forecast.downside_pct.toFixed(2)}%\n`;
  }

  msg += `\n<i>Enter when 15-min chart breaks swing ${isShort ? 'low (short)' : 'high (long)'} after open</i>`;
  return msg;
}

// ── Paper trade tracker console print ─────────────────────────────────────────
function printConsole(signals, scanDate) {
  console.log('\n' + '═'.repeat(90));
  console.log(`  MTF FALSE BREAKOUT SCAN — ${scanDate}  |  ${signals.length} signal(s)`);
  console.log('═'.repeat(90));

  if (!signals.length) {
    console.log('  No setups found today.');
    console.log('═'.repeat(90));
    return;
  }

  const header = () => console.log(
    'Symbol'.padEnd(14) + 'Type'.padEnd(8) + 'PWH/PWL'.padEnd(12) +
    'SigHi/Lo'.padEnd(12) + 'Close'.padEnd(10) + 'SL'.padEnd(10) +
    'T1'.padEnd(10) + 'T2'.padEnd(10) + 'Risk%'.padEnd(8) + 'R:R'
  );

  const shorts = signals.filter(s => s.type === 'SHORT');
  const longs  = signals.filter(s => s.type === 'LONG');

  if (shorts.length) {
    console.log('\n  SHORT setups — false breakout above prev week high (needs F&O):');
    console.log('─'.repeat(90));
    header();
    console.log('─'.repeat(90));
    for (const s of shorts) {
      console.log(
        s.symbol.padEnd(14) + 'SHORT'.padEnd(8) +
        String(s.pwh).padEnd(12) + String(s.sigHigh).padEnd(12) +
        String(s.close).padEnd(10) + String(s.sl).padEnd(10) +
        String(s.t1).padEnd(10) + String(s.t2).padEnd(10) +
        (s.riskPct + '%').padEnd(8) + '1:' + s.rr
      );
    }
  }

  if (longs.length) {
    console.log('\n  LONG setups — false breakdown below prev week low (cash delivery OK):');
    console.log('─'.repeat(90));
    header();
    console.log('─'.repeat(90));
    for (const s of longs) {
      console.log(
        s.symbol.padEnd(14) + 'LONG'.padEnd(8) +
        String(s.pwl).padEnd(12) + String(s.sigLow).padEnd(12) +
        String(s.close).padEnd(10) + String(s.sl).padEnd(10) +
        String(s.t1).padEnd(10) + String(s.t2).padEnd(10) +
        (s.riskPct + '%').padEnd(8) + '1:' + s.rr
      );
    }
  }

  console.log('═'.repeat(90));
  console.log('  Entry: next morning — wait for 15-min MSS (swing break) before entering');
  console.log('  SHORT: 15-min swing LOW breaks → enter  |  LONG: 15-min swing HIGH breaks → enter');
  console.log('═'.repeat(90));
}

// ── Main ──────────────────────────────────────────────────────────────────────
export async function runMTFScanner() {
  const scanDate = new Date().toISOString().slice(0, 10);
  console.log(`[MTF] Scanning ${ALL_OPTION_STOCKS.length} F&O stocks...`);

  // Need 45 days to get at least 2 full weeks + current week
  const allBars = await downloadBatch(ALL_OPTION_STOCKS, '45d', '1d', 20);
  const signals = [];

  for (const [symbol, bars] of Object.entries(allBars)) {
    const sig = analyseStock(symbol, bars);
    if (sig) signals.push(sig);
  }

  // Sort: shorts first (by rr desc), then longs (by rr desc)
  signals.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'SHORT' ? -1 : 1;
    return b.rr - a.rr;
  });

  console.log(`[MTF] Found ${signals.length} signal(s) — ${signals.filter(s=>s.type==='SHORT').length} short, ${signals.filter(s=>s.type==='LONG').length} long`);

  printConsole(signals, scanDate);

  if (!signals.length) {
    await sendTelegram(`<b>MTF False Breakout Scan — ${scanDate}</b>\nNo setups found today.`);
    return signals;
  }

  // Send one message per signal as soon as its forecast arrives + save to DB
  await Promise.all(signals.map(async (s) => {
    const forecast = await fetchForecast(s.symbol, 'stock_nse').catch(() => null);
    const msg = formatSignalMessage(s, scanDate, forecast);
    await sendTelegram(msg);
    console.log(`[MTF] Sent: ${s.symbol} (${s.type})`);

    const saved = saveSignal({
      scanner:               'mtf',
      symbol:                s.symbol,
      signal_date:           scanDate,
      trade_type:            s.type,          // LONG or SHORT
      entry_type:            'AUTO',           // next day open near MSS
      sl:                    s.sl,
      t1:                    s.t1,
      t2:                    s.t2,
      risk_pct:              s.riskPct,
      signal_close:          s.close,
      signal_high:           s.sigHigh,
      signal_low:            s.sigLow,
      forecast_bias:         forecast?.bias              ?? null,
      forecast_target:       forecast?.end_price         ?? null,
      forecast_change_pct:   forecast?.change_pct        ?? null,
      forecast_peak:         forecast?.peak              ?? null,
      forecast_trough:       forecast?.trough            ?? null,
      forecast_upside_pct:   forecast?.upside_pct        ?? null,
      forecast_downside_pct: forecast?.downside_pct      ?? null,
      meta: { pwh: s.pwh, pwl: s.pwl, rr: s.rr },
    });
    if (!saved.duplicate) console.log(`[MTF] Saved DB id=${saved.id}`);
  }));

  return signals;
}

// ── Run directly if called as script ─────────────────────────────────────────
if (process.argv[1].includes('mtfScanner')) {
  runMTFScanner().catch(console.error);
}
