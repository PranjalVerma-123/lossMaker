/**
 * Hiren Gabani Momentum / Orderly Pullback Scanner — Daily post-market cron
 *
 * Runs Mon–Fri after market close (4:45 PM IST)
 * Scans ALL_OPTION_STOCKS for:
 *   - Stage 2: close > 50 EMA > 200 EMA, 200 EMA rising
 *   - Prior strong leg: ≥20% above the low from 60-150 bars ago
 *   - Orderly pullback: 10-25% below 60-bar swing high
 *   - Volume contracting: 5d avg < 75% of 20d avg
 *   - Inside bar: today fully inside previous candle's range
 *   - Near 10/20 EMA: inside bar's low within ±5% of 10 or 20 EMA
 *
 * Entry plan: buy-stop at today's HIGH tomorrow
 * SL: today's LOW (must be ≤5% from entry)
 *
 * Run manually: node src/cron/jobs/hirenGabaniScanner.js
 */

import axios from 'axios';
import { downloadBatch, calcEMA } from '../../services/yFinance/index.js';
import { ALL_OPTION_STOCKS }      from '../../constant/nseStocks.js';
import 'dotenv/config';
import { fetchForecast } from '../../api/api.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ── Config ────────────────────────────────────────────────────────────────────
const PRIOR_LEG_LO       = 60;
const PRIOR_LEG_HI       = 150;
const PRIOR_LEG_MIN_PCT  = 20;
const PB_MIN_PCT         = 10;
const PB_MAX_PCT         = 25;
const SWING_HIGH_BARS    = 60;
const VOL_CONTRACT_RATIO = 0.75;
const EMA_PROXIMITY_PCT  = 5;
const MAX_SL_PCT         = 5;
const MIN_SL_PCT         = 0.5;

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
  // Need enough bars for prior leg check + EMA calculation
  if (!bars || bars.length < PRIOR_LEG_HI + 10) return null;

  const closes = bars.map(b => b.close);
  const ema10  = calcEMA(closes, 10);
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);

  const n    = bars.length - 1; // today
  const bar  = bars[n];
  const prev = bars[n - 1];

  const c    = bar.close;
  const e10  = ema10[n], e20 = ema20[n], e50 = ema50[n], e200 = ema200[n];
  const date = bar.date.toISOString().slice(0, 10);

  if (!e10 || !e20 || !e50 || !e200 || !ema200[n - 20]) return null;

  // 1. Stage 2
  if (c    <= e50)            return null;
  if (e50  <= e200)           return null;
  if (e200 <= ema200[n - 20]) return null; // 200 EMA rising

  // 2. Prior strong leg
  let priorLow = Infinity;
  for (let j = n - PRIOR_LEG_HI; j < n - PRIOR_LEG_LO; j++) {
    if (j < 0) continue;
    if (bars[j].low < priorLow) priorLow = bars[j].low;
  }
  if ((c - priorLow) / priorLow * 100 < PRIOR_LEG_MIN_PCT) return null;

  // 3. Orderly pullback 10-25% from 60-bar swing high
  let swingHigh = -Infinity;
  for (let j = n - SWING_HIGH_BARS; j < n; j++) {
    if (j < 0) continue;
    if (bars[j].high > swingHigh) swingHigh = bars[j].high;
  }
  const pbPct = (swingHigh - c) / swingHigh * 100;
  if (pbPct < PB_MIN_PCT || pbPct > PB_MAX_PCT) return null;

  // 4. Volume contracting
  let vol5 = 0, vol20 = 0;
  for (let j = n - 5; j < n; j++)  vol5  += bars[j]?.volume ?? 0;
  for (let j = n - 20; j < n; j++) vol20 += bars[j]?.volume ?? 0;
  vol5 /= 5; vol20 /= 20;
  if (vol20 > 0 && vol5 / vol20 > VOL_CONTRACT_RATIO) return null;

  // 5. Inside bar (today fully inside yesterday)
  if (bar.high >= prev.high) return null;
  if (bar.low  <= prev.low)  return null;

  // 6. Today's close above 20 EMA
  if (c < e20) return null;

  // 7. Inside bar's low within ±5% of 10 or 20 EMA
  const nearEMA10 = Math.abs(bar.low - e10) / e10 * 100 <= EMA_PROXIMITY_PCT;
  const nearEMA20 = Math.abs(bar.low - e20) / e20 * 100 <= EMA_PROXIMITY_PCT;
  if (!nearEMA10 && !nearEMA20) return null;

  // Calculate entry plan (buy-stop at today's high)
  const stopPx  = +bar.high.toFixed(2);   // entry trigger
  const slPx    = +bar.low.toFixed(2);    // SL
  const risk    = stopPx - slPx;
  const riskPct = +(risk / stopPx * 100).toFixed(2);

  if (riskPct > MAX_SL_PCT || riskPct < MIN_SL_PCT) return null;

  const t1r = +(stopPx + 1 * risk).toFixed(2);
  const t2r = +(stopPx + 2 * risk).toFixed(2);
  const t4r = +(stopPx + 4 * risk).toFixed(2);

  return {
    symbol,
    date,
    close:     +c.toFixed(2),
    stopEntry: stopPx,
    sl:        slPx,
    riskPct,
    t1r,
    t2r,
    t4r,
    pbPct:     +pbPct.toFixed(1),
    ema10:     +e10.toFixed(2),
    ema20:     +e20.toFixed(2),
    nearEMA:   nearEMA10 ? '10EMA' : '20EMA',
    volRatio:  vol20 > 0 ? +(vol5 / vol20 * 100).toFixed(0) + '%' : 'n/a',
  };
}

// ── Format single-signal Telegram message (with optional forecast) ────────────
function formatSignalMessage(s, scanDate, forecast) {
  let msg = `<b>Hiren Gabani — ${s.symbol}</b>  [${scanDate}]\n`;
  msg += `<i>Pullback ${s.pbPct}% from swing high | near ${s.nearEMA} | vol dry ${s.volRatio}</i>\n\n`;

  msg += `  Close today  : ₹${s.close}\n`;
  msg += `  Buy-Stop     : ₹${s.stopEntry}  (today's high — wait for cross)\n`;
  msg += `  SL           : ₹${s.sl}  (today's low)\n`;
  msg += `  Risk         : ${s.riskPct}%\n`;
  msg += `  2R → BE SL   : ₹${s.t2r}\n`;
  msg += `  4R → 1/3 out : ₹${s.t4r}\n`;

  if (forecast) {
    const biasIcon = forecast.bias === 'BULLISH' ? '▲' : forecast.bias === 'BEARISH' ? '▼' : '—';
    msg += `\n  — Forecast (22d) —\n`;
    msg += `  Bias         : ${biasIcon} ${forecast.bias}\n`;
    msg += `  Target price : ₹${forecast.end_price.toFixed(2)}  (${forecast.change_pct >= 0 ? '+' : ''}${forecast.change_pct.toFixed(2)}%)\n`;
    msg += `  Peak / Trough: ₹${forecast.peak.toFixed(2)} / ₹${forecast.trough.toFixed(2)}\n`;
    msg += `  Upside / Down: +${forecast.upside_pct.toFixed(2)}% / ${forecast.downside_pct.toFixed(2)}%\n`;
  }

  msg += `\n<i>Trail: exit 1/3 on 10 EMA cross, final 1/3 on 20 EMA cross</i>`;
  return msg;
}

// ── Console print ─────────────────────────────────────────────────────────────
function printConsole(signals, scanDate) {
  console.log('\n' + '═'.repeat(100));
  console.log(`  HIREN GABANI SCAN — ${scanDate}  |  ${signals.length} setup(s)`);
  console.log('═'.repeat(100));

  if (!signals.length) {
    console.log('  No setups today.');
    console.log('═'.repeat(100));
    return;
  }

  console.log(
    'Symbol'.padEnd(14) + 'Close'.padEnd(10) + 'Stop'.padEnd(10) + 'SL'.padEnd(10) +
    'Risk%'.padEnd(8) + '2R(BE)'.padEnd(11) + '4R(1/3)'.padEnd(11) +
    'PullB%'.padEnd(9) + 'Near'.padEnd(8) + 'VolDry'
  );
  console.log('─'.repeat(100));

  for (const s of signals) {
    console.log(
      s.symbol.padEnd(14) +
      String(s.close).padEnd(10) +
      String(s.stopEntry).padEnd(10) +
      String(s.sl).padEnd(10) +
      (s.riskPct + '%').padEnd(8) +
      String(s.t2r).padEnd(11) +
      String(s.t4r).padEnd(11) +
      (s.pbPct + '%').padEnd(9) +
      s.nearEMA.padEnd(8) +
      s.volRatio
    );
  }

  console.log('═'.repeat(100));
  console.log('  Entry: set buy-stop at STOP price above. Enter only if price crosses up through it.');
  console.log('  SL  : today\'s low. At 2R → move SL to breakeven. At 4R → book 1/3.');
  console.log('  Trail: exit 1/3 on 10 EMA close below, final 1/3 on 20 EMA close below.');
  console.log('═'.repeat(100));
}

// ── Main ──────────────────────────────────────────────────────────────────────
export async function runHirenGabaniScanner() {
  const scanDate = new Date().toISOString().slice(0, 10);
  console.log(`[HirenGabani] Scanning ${ALL_OPTION_STOCKS.length} stocks...`);

  // Need 150+ bars for prior leg check
  const allBars = await downloadBatch(ALL_OPTION_STOCKS, '9mo', '1d', 20);
  const signals = [];

  for (const [symbol, bars] of Object.entries(allBars)) {
    const sig = analyseStock(symbol, bars);
    if (sig) signals.push(sig);
  }

  // Sort by pullback % (cleanest pullback first — closest to ideal 12-15%)
  const IDEAL_PB = 15;
  signals.sort((a, b) => Math.abs(a.pbPct - IDEAL_PB) - Math.abs(b.pbPct - IDEAL_PB));

  console.log(`[HirenGabani] Found ${signals.length} setup(s)`);

  printConsole(signals, scanDate);

  if (!signals.length) {
    await sendTelegram(`<b>Hiren Gabani Scan — ${scanDate}</b>\nNo setups found today.`);
    return signals;
  }

  // Send one message per signal as soon as its forecast arrives
  await Promise.all(signals.map(async (s) => {
    const forecast = await fetchForecast(s.symbol, 'stock_nse').catch(() => null);
    const msg = formatSignalMessage(s, scanDate, forecast);
    await sendTelegram(msg);
    console.log(`[HirenGabani] Sent: ${s.symbol}`);
  }));
  

  return signals;
}

// ── Run directly if called as script ─────────────────────────────────────────
if (process.argv[1].includes('hirenGabaniScanner')) {
  runHirenGabaniScanner().catch(console.error);
}
