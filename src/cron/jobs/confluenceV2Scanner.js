/**
 * Confluence V2 Scanner — Daily post-market cron
 *
 * Scans for: Monthly CPR + 20/50 EMA confluence + NR4/Inside Bar + Volume squeeze
 * Runs Mon–Fri after market close (5:15 PM IST)
 *
 * Strategy summary:
 *   Signal : NR4 or inside bar forming near a key level (monthly CPR or 20/50 EMA)
 *   Entry  : buy-stop tomorrow at today's HIGH (only if volume confirms breakout)
 *   SL     : today's LOW (max 4% from entry)
 *   T1     : +2R → book 50%, SL → breakeven
 *   T2     : +4R → book 50%
 *   R:R    : 1:3 (blended 3R average win)
 *
 * Run manually: node src/cron/jobs/confluenceV2Scanner.js
 */

import axios from 'axios';
import 'dotenv/config';
import { downloadOHLC, downloadBatch, calcEMA, calcCPR } from '../../services/yFinance/index.js';
import { ALL_OPTION_STOCKS }                             from '../../constant/nseStocks.js';
import { fetchForecast } from '../../api/api.js';
import { saveSignal }    from '../../db/signals.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ── Config ────────────────────────────────────────────────────────────────────
const MAX_SL_PCT        = 4;
const MIN_SL_PCT        = 0.5;
const VOL_DRY_RATIO     = 0.9;
const RSI_MIN           = 50;
const RSI_MAX           = 72;
const EMA_LEVEL_TOL_PCT = 3;
const FROM_20H_MAX_PCT  = 15;

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

// ── Wilder RSI ────────────────────────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return closes.map(() => 50);
  const rsi = new Array(closes.length).fill(50);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += -d;
  }
  let ag = gains / period, al = losses / period;
  rsi[period] = 100 - 100 / (1 + (al > 0 ? ag / al : 1e10));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsi[i] = 100 - 100 / (1 + (al > 0 ? ag / al : 1e10));
  }
  return rsi;
}

// ── Monthly CPR map ───────────────────────────────────────────────────────────
function buildMonthlyCPRMap(bars) {
  const months = {};
  for (const b of bars) {
    const k = `${b.date.getFullYear()}-${String(b.date.getMonth() + 1).padStart(2, '0')}`;
    if (!months[k]) months[k] = { high: -Infinity, low: Infinity, close: 0 };
    months[k].high  = Math.max(months[k].high, b.high);
    months[k].low   = Math.min(months[k].low,  b.low);
    months[k].close = b.close;
  }
  return bars.map(b => {
    const m      = b.date.getMonth();
    const y      = b.date.getFullYear();
    const prevM  = m === 0 ? 12 : m;
    const prevY  = m === 0 ? y - 1 : y;
    const key    = `${prevY}-${String(prevM).padStart(2, '0')}`;
    const prev   = months[key];
    if (!prev || prev.high === -Infinity) return null;
    return calcCPR(prev.high, prev.low, prev.close);
  });
}

// ── Regime: check if Nifty is in bull mode ────────────────────────────────────
async function isRegimeBull() {
  const bars = await downloadOHLC('^NSEI', '6mo', '1d');
  if (!bars || bars.length < 30) return true; // assume bull if no data
  const closes = bars.map(b => b.close);
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  const n      = bars.length - 1;
  const bullEMA   = bars[n].close > ema50[n];
  const emaStack  = ema20[n] > ema50[n];
  const bullMomL  = n >= 20 ? bars[n].close > bars[n - 20].close : false;
  const bullMomS  = n >= 5  ? bars[n].close > bars[n - 5].close  : false;
  return bullEMA && emaStack && bullMomL && bullMomS;
}

// ── Level proximity ───────────────────────────────────────────────────────────
function nearLevel(price, level, pct) {
  if (!level || level <= 0) return false;
  return Math.abs(price - level) / level * 100 <= pct;
}

// ── Analyse one stock ─────────────────────────────────────────────────────────
function analyseStock(symbol, bars) {
  if (!bars || bars.length < 100) return null;

  const closes = bars.map(b => b.close);
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const rsi    = calcRSI(closes, 14);
  const cprArr = buildMonthlyCPRMap(bars);

  const n    = bars.length - 1;
  const bar  = bars[n];
  const prev = bars[n - 1];
  const c    = bar.close;

  const e20  = ema20[n], e50 = ema50[n], e200 = ema200[n];
  if (!e20 || !e50 || !e200) return null;
  if (n < 25) return null;
  if (!ema200[n - 20] || !ema50[n - 10] || !ema20[n - 5]) return null;

  // Stage 2: perfect EMA stack
  if (c <= e20 || e20 <= e50 || e50 <= e200)  return null;

  // All EMAs rising
  if (e200 <= ema200[n - 20]) return null;
  if (e50  <= ema50[n - 10])  return null;
  if (e20  <= ema20[n - 5])   return null;

  // RSI
  const r = rsi[n];
  if (!r || r < RSI_MIN || r > RSI_MAX) return null;

  // NR4 or inside bar
  const range       = bar.high - bar.low;
  const isInsideBar = bar.high < prev.high && bar.low > prev.low;
  let   isNR4       = true;
  for (let j = n - 3; j < n; j++) {
    if (j >= 0 && (bars[j].high - bars[j].low) <= range) { isNR4 = false; break; }
  }
  if (!isInsideBar && !isNR4) return null;

  // Volume drying
  let vol20 = 0;
  for (let j = n - 20; j < n; j++) vol20 += bars[j]?.volume ?? 0;
  vol20 /= 20;
  if (vol20 > 0 && (bar.volume ?? 0) > VOL_DRY_RATIO * vol20) return null;

  // Bullish candle
  if (range > 0 && (bar.close - bar.low) / range < 0.40) return null;

  // Level confluence
  const cpr = cprArr[n];
  const confluenceHits = [];
  if (nearLevel(bar.low, e20,       EMA_LEVEL_TOL_PCT)) confluenceHits.push('20EMA');
  if (nearLevel(bar.low, e50,       EMA_LEVEL_TOL_PCT)) confluenceHits.push('50EMA');
  if (cpr) {
    if (nearLevel(bar.low, cpr.TC,  EMA_LEVEL_TOL_PCT)) confluenceHits.push('CPR-TC');
    if (nearLevel(bar.low, cpr.P,   EMA_LEVEL_TOL_PCT)) confluenceHits.push('CPR-P');
    if (nearLevel(bar.low, cpr.BC,  EMA_LEVEL_TOL_PCT)) confluenceHits.push('CPR-BC');
  }
  if (confluenceHits.length === 0) return null;

  // Within 15% of 20-bar high
  let hi20 = -Infinity;
  for (let j = n - 20; j <= n; j++) { if (j >= 0 && bars[j].high > hi20) hi20 = bars[j].high; }
  if ((hi20 - c) / hi20 * 100 > FROM_20H_MAX_PCT) return null;

  // Entry plan
  const stopPx  = +bar.high.toFixed(2);
  const slPx    = +bar.low.toFixed(2);
  const risk    = stopPx - slPx;
  const riskPct = +(risk / stopPx * 100).toFixed(2);
  if (riskPct > MAX_SL_PCT || riskPct < MIN_SL_PCT) return null;

  const t1  = +(stopPx + 2 * risk).toFixed(2);
  const t2  = +(stopPx + 4 * risk).toFixed(2);
  const volRatioPct = vol20 > 0 ? Math.round((bar.volume ?? 0) / vol20 * 100) : 0;

  return {
    symbol,
    date:           bar.date.toISOString().slice(0, 10),
    close:          +c.toFixed(2),
    stopEntry:      stopPx,
    sl:             slPx,
    riskPct,
    t1,
    t2,
    ema20:          +e20.toFixed(2),
    ema50:          +e50.toFixed(2),
    rsi:            +r.toFixed(1),
    pattern:        isInsideBar ? 'InsideBar' : 'NR4',
    confluences:    confluenceHits,
    volDryPct:      volRatioPct,
    cprTC:          cpr ? +cpr.TC.toFixed(2) : null,
    cprP:           cpr ? +cpr.P.toFixed(2)  : null,
  };
}

// ── Format single-signal Telegram message ─────────────────────────────────────
function formatSignalMessage(s, scanDate, regimeBull, forecast) {
  const regimeStr = regimeBull ? 'Nifty: BULL' : 'Nifty: CAUTION';
  const strength  = s.confluences.length >= 2 ? ' ★★' : ' ★';

  let msg = `<b>Confluence V2 — ${s.symbol}${strength}</b>  [${scanDate}]\n`;
  msg += `<i>${s.pattern} | ${s.confluences.join(' + ')} | ${regimeStr}</i>\n\n`;

  msg += `  Close today    : ₹${s.close}  |  RSI: ${s.rsi}\n`;
  msg += `  Buy-Stop       : ₹${s.stopEntry}  (today's high — place order now)\n`;
  msg += `  SL             : ₹${s.sl}  |  Risk: ${s.riskPct}%\n`;
  msg += `  T1 (2R, 50%)   : ₹${s.t1}  →  SL to entry\n`;
  msg += `  T2 (4R, 50%)   : ₹${s.t2}  →  full exit\n`;
  msg += `  Vol today      : ${s.volDryPct}% of 20d avg\n`;
  if (s.cprP) msg += `  Monthly CPR    : P=₹${s.cprP}  TC=₹${s.cprTC}\n`;

  if (forecast) {
    const biasIcon = forecast.bias === 'BULLISH' ? '▲' : forecast.bias === 'BEARISH' ? '▼' : '—';
    msg += `\n  — Forecast (22d) —\n`;
    msg += `  Bias         : ${biasIcon} ${forecast.bias}\n`;
    msg += `  Target price : ₹${forecast.end_price.toFixed(2)}  (${forecast.change_pct >= 0 ? '+' : ''}${forecast.change_pct.toFixed(2)}%)\n`;
    msg += `  Peak / Trough: ₹${forecast.peak.toFixed(2)} / ₹${forecast.trough.toFixed(2)}\n`;
    msg += `  Upside / Down: +${forecast.upside_pct.toFixed(2)}% / ${forecast.downside_pct.toFixed(2)}%\n`;
  }

  msg += `\n<i>Confirm volume &gt;1.3× avg on entry bar before entering${s.confluences.length >= 2 ? ' | ★★ = high conviction' : ''}</i>`;
  return msg;
}

// ── Console print ─────────────────────────────────────────────────────────────
function printConsole(signals, scanDate, regimeBull) {
  console.log('\n' + '═'.repeat(110));
  console.log(`  CONFLUENCE V2 SCAN — ${scanDate}  |  ${signals.length} setup(s)  |  Regime: ${regimeBull ? 'BULL ✓' : 'CAUTION ✗'}`);
  console.log('═'.repeat(110));

  if (!signals.length) {
    console.log('  No setups today.');
    console.log('═'.repeat(110));
    return;
  }

  console.log(
    'Symbol'.padEnd(14) + 'Pattern'.padEnd(12) + 'Close'.padEnd(10) + 'Stop'.padEnd(10) +
    'SL'.padEnd(10) + 'Risk%'.padEnd(8) + 'T1'.padEnd(12) + 'T2'.padEnd(12) +
    'RSI'.padEnd(7) + 'VolDry%'.padEnd(9) + 'Confluence'
  );
  console.log('─'.repeat(110));

  for (const s of signals) {
    const stars = s.confluences.length >= 2 ? '★★' : '★ ';
    console.log(
      (s.symbol + ' ' + stars).padEnd(14) +
      s.pattern.padEnd(12) +
      String(s.close).padEnd(10) +
      String(s.stopEntry).padEnd(10) +
      String(s.sl).padEnd(10) +
      (s.riskPct + '%').padEnd(8) +
      String(s.t1).padEnd(12) +
      String(s.t2).padEnd(12) +
      String(s.rsi).padEnd(7) +
      (s.volDryPct + '%').padEnd(9) +
      s.confluences.join(' + ')
    );
  }

  console.log('═'.repeat(110));
  console.log('  Entry: set buy-stop order at STOP price. Enter ONLY if tomorrow\'s volume > 1.3× 20d avg.');
  console.log('  T1 at 2R → book 50%, move SL to entry (breakeven)');
  console.log('  T2 at 4R → book remaining 50%');
  console.log('  ★★ = 2+ confluence levels (higher conviction)');
  console.log('═'.repeat(110));
}

// ── Main ──────────────────────────────────────────────────────────────────────
export async function runConfluenceV2Scanner() {
  const scanDate  = new Date().toISOString().slice(0, 10);
  const regimeBull = await isRegimeBull();

  console.log(`[ConfluenceV2] Regime: ${regimeBull ? 'BULL' : 'CAUTION'}`);
  console.log(`[ConfluenceV2] Scanning ${ALL_OPTION_STOCKS.length} stocks...`);

  // Download 4 months — enough for monthly CPR (needs prior month's data)
  const allBars = await downloadBatch(ALL_OPTION_STOCKS, '4mo', '1d', 20);
  const signals = [];

  for (const [symbol, bars] of Object.entries(allBars)) {
    const sig = analyseStock(symbol, bars);
    if (sig) signals.push(sig);
  }

  // Sort: dual confluence first, then by RSI (momentum quality)
  signals.sort((a, b) => {
    if (b.confluences.length !== a.confluences.length) return b.confluences.length - a.confluences.length;
    return b.rsi - a.rsi;
  });

  console.log(`[ConfluenceV2] Found ${signals.length} setup(s)`);
  printConsole(signals, scanDate, regimeBull);

  if (!signals.length) {
    await sendTelegram(`<b>Confluence V2 Scan — ${scanDate}</b>\n${regimeBull ? 'Nifty: BULL' : 'Nifty: CAUTION'}\nNo setups found today.`);
    return signals;
  }

  // Send one message per signal as soon as its forecast arrives + save to DB
  await Promise.all(signals.map(async (s) => {
    const forecast = await fetchForecast(s.symbol, 'stock_nse').catch(() => null);
    const msg = formatSignalMessage(s, scanDate, regimeBull, forecast);
    await sendTelegram(msg);
    console.log(`[ConfluenceV2] Sent: ${s.symbol}`);

    const saved = saveSignal({
      scanner:               'confluence_v2',
      symbol:                s.symbol,
      signal_date:           scanDate,
      trade_type:            'LONG',
      entry_type:            'BUY_STOP',
      entry_trigger:         s.stopEntry,
      sl:                    s.sl,
      t1:                    s.t1,    // 2R
      t2:                    s.t2,    // 4R
      risk_pct:              s.riskPct,
      signal_close:          s.close,
      signal_high:           s.stopEntry,
      signal_low:            s.sl,
      forecast_bias:         forecast?.bias              ?? null,
      forecast_target:       forecast?.end_price         ?? null,
      forecast_change_pct:   forecast?.change_pct        ?? null,
      forecast_peak:         forecast?.peak              ?? null,
      forecast_trough:       forecast?.trough            ?? null,
      forecast_upside_pct:   forecast?.upside_pct        ?? null,
      forecast_downside_pct: forecast?.downside_pct      ?? null,
      meta: { pattern: s.pattern, confluences: s.confluences, rsi: s.rsi, volDryPct: s.volDryPct, cprP: s.cprP },
    });
    if (!saved.duplicate) console.log(`[ConfluenceV2] Saved DB id=${saved.id}`);
  }));

  return signals;
}

// ── Run directly if called as script ─────────────────────────────────────────
if (process.argv[1].includes('confluenceV2Scanner')) {
  runConfluenceV2Scanner().catch(console.error);
}
