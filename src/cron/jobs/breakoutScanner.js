/**
 * Breakout Scanner — Daily Notification System
 *
 * Strategy: "20-Day High Breakout" on Nifty 100 stocks
 *
 * Signal fires when ALL of the following are true:
 *  1. Market : Nifty > 50 EMA AND Nifty close > 20-day-ago close (bull regime)
 *  2. Uptrend: Stock close > 50 EMA > 200 EMA (trending up)
 *  3. Slope  : Stock's 50 EMA today > 50 EMA 10 days ago (accelerating)
 *  4. Breakout: Today's close is ≥1% above highest close of prev 20 days
 *  5. Volume : Today's volume ≥ 1.5x 20-day average (institutional interest)
 *  6. RSI    : RSI(14) between 50–75 (momentum, not overbought)
 *  7. Not extended: close ≤ 50 EMA × 1.20
 *  8. Strong close: close in upper 50% of candle range
 *
 * Execution (for reference when trading):
 *  Entry  : Next day's open
 *  SL     : 5% below entry
 *  Target1: +10% → exit 50%, move SL to breakeven
 *  Target2: +20% OR close below 20 EMA → exit remaining 50%
 *
 * Risk management (apply manually):
 *  - After 2 consecutive losses, skip 3 trading days
 *  - Max 4 open positions at once
 *  - Risk only 25% capital per trade
 *
 * Run: node src/cron/jobs/breakoutScanner.js
 * Or schedule: cron 0 16 * * 1-5 (daily at 4:00 PM IST on weekdays)
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YahooFinance from 'yahoo-finance2';
import axios from 'axios';
import 'dotenv/config';

import { calcEMA } from '../../services/yFinance/index.js';
import { ALL_OPTION_STOCKS } from '../../constant/nseStocks.js';
import { fetchForecast } from '../../api/api.js';
import { saveSignal } from '../../db/signals.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', '..', '..', 'output', 'scanner');

const yf = new YahooFinance({ suppressNotices: ['ripHistorical'] });

// ── Config ────────────────────────────────────────────────────────────────────
const BREAKOUT_DAYS     = 20;    // N-day high breakout
const MIN_BREAKOUT_PCT  = 0.01;  // breakout must be ≥1% above prev high
const VOL_BREAKOUT_MULT = 1.5;   // volume surge ≥ 1.5x avg
const RSI_PERIOD        = 14;
const RSI_MIN           = 50;
const RSI_MAX           = 75;
const EMA_FAST          = 20;
const EMA_MID           = 50;
const EMA_SLOW          = 200;
const EMA50_SLOPE_DAYS  = 10;
const MAX_EXT_PCT       = 1.20;
const VOL_SMA_PERIOD    = 20;
const NIFTY_MOMENTUM_DAYS = 20;
const CONCURRENCY       = 8;

// ── Wilder RSI ─────────────────────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return closes.map(() => 50);
  const rsi = new Array(closes.length).fill(50);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains  += d;
    else       losses += Math.abs(d);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period; i < closes.length; i++) {
    if (i > period) {
      const d = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi[i] = 100 - (100 / (1 + rs));
  }
  return rsi;
}

function calcVolSMA(volumes, period) {
  return volumes.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += volumes[j];
    return sum / period;
  });
}

// ── Fetch & enrich bars ───────────────────────────────────────────────────────
async function fetchEnriched(ticker, isIndex = false) {
  const now   = new Date();
  const start = new Date(now);
  start.setFullYear(start.getFullYear() - 1); // 1 year for breakout lookback

  try {
    const result = await yf.chart(ticker, { period1: start, period2: now, interval: '1d' });
    if (!result?.quotes?.length) return [];

    const bars = result.quotes
      .filter(q => q.close != null && q.open != null && q.high != null && q.low != null && (isIndex || q.volume > 0))
      .map(q => ({
        date:   q.date,
        open:   q.open,
        high:   q.high,
        low:    q.low,
        close:  q.adjclose ?? q.close,
        volume: q.volume,
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const closes  = bars.map(b => b.close);
    const volumes = bars.map(b => b.volume);

    const ema20  = calcEMA(closes, EMA_FAST);
    const ema50  = calcEMA(closes, EMA_MID);
    const ema200 = calcEMA(closes, EMA_SLOW);
    const rsi14  = calcRSI(closes, RSI_PERIOD);
    const vol20  = calcVolSMA(volumes, VOL_SMA_PERIOD);

    return bars.map((b, i) => ({
      ...b,
      ema20:      ema20[i],
      ema50:      ema50[i],
      ema200:     ema200[i],
      ema50_10d:  i >= EMA50_SLOPE_DAYS ? ema50[i - EMA50_SLOPE_DAYS] : null,
      nifty20ago: i >= NIFTY_MOMENTUM_DAYS ? closes[i - NIFTY_MOMENTUM_DAYS] : null,
      rsi14:      rsi14[i],
      vol20:      vol20[i],
    }));
  } catch { return []; }
}

// ── Check if latest bar fires the breakout signal ────────────────────────────
function checkSignal(bars) {
  if (bars.length < BREAKOUT_DAYS + EMA50_SLOPE_DAYS + 5) return null;

  const last = bars[bars.length - 1]; // today (signal bar — we act tomorrow)
  const { ema20, ema50, ema200, ema50_10d, rsi14, vol20 } = last;

  if (!ema20 || !ema50 || !ema200 || !vol20) return null;

  // 1. Uptrend
  if (!(last.close > ema50 && ema50 > ema200)) return null;

  // 2. 50 EMA slope rising
  if (!ema50_10d || ema50 <= ema50_10d) return null;

  // 3. 20-day high breakout (≥1% above previous high)
  const prevHighClose = Math.max(...bars.slice(-1 - BREAKOUT_DAYS, -1).map(b => b.close));
  if (last.close < prevHighClose * (1 + MIN_BREAKOUT_PCT)) return null;

  // 4. Volume surge
  if (last.volume < vol20 * VOL_BREAKOUT_MULT) return null;

  // 5. RSI in momentum zone
  if (rsi14 < RSI_MIN || rsi14 > RSI_MAX) return null;

  // 6. Not overextended
  if (last.close > ema50 * MAX_EXT_PCT) return null;

  // 7. Strong close (upper 50% of range)
  const range = last.high - last.low;
  if (range > 0 && last.close < (last.low + range * 0.5)) return null;

  // Signal fires!
  const breakoutPct = ((last.close - prevHighClose) / prevHighClose * 100).toFixed(2);
  const volMultiple = (last.volume / vol20).toFixed(2);
  const distEma50   = ((last.close - ema50) / ema50 * 100).toFixed(2);
  const dateStr     = new Date(last.date).toISOString().slice(0, 10);

  return {
    date:         dateStr,
    close:        Math.round(last.close * 100) / 100,
    breakoutPct:  +breakoutPct,
    prevHigh:     Math.round(prevHighClose * 100) / 100,
    volMultiple:  +volMultiple,
    rsi:          Math.round(rsi14 * 10) / 10,
    ema20:        Math.round(ema20 * 100) / 100,
    ema50:        Math.round(ema50 * 100) / 100,
    distEma50Pct: +distEma50,
    suggestedSL:  Math.round(last.close * 0.95 * 100) / 100, // approx SL for tomorrow entry
  };
}

// ── Check Nifty market regime ─────────────────────────────────────────────────
async function checkNiftyRegime() {
  const bars = await fetchEnriched('^NSEI', true);
  if (bars.length < 25) return { bullish: false, reason: 'Insufficient data' };

  const last = bars[bars.length - 1];
  if (!last.ema50 || !last.nifty20ago) return { bullish: false, reason: 'No EMA data' };

  const aboveEMA50  = last.close > last.ema50;
  const aboveM20    = last.close > last.nifty20ago;
  const bullish     = aboveEMA50 && aboveM20;

  return {
    bullish,
    close:    Math.round(last.close),
    ema50:    Math.round(last.ema50),
    change20d: ((last.close - last.nifty20ago) / last.nifty20ago * 100).toFixed(2),
    reason:   !bullish
      ? (!aboveEMA50 ? 'Nifty below 50 EMA' : 'Nifty below 20-day-ago close (downtrend)')
      : 'All clear',
  };
}

// ── Telegram notification ─────────────────────────────────────────────────────
async function sendTelegram(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { console.log('[Breakout] Telegram not configured'); console.log(message); return; }
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId, text: message, parse_mode: 'HTML',
    });
  } catch (err) { console.error('[Breakout] Telegram error:', err.message); }
}

function formatSignalMessage(s, today, regime, forecast) {
  let msg = `<b>Breakout — ${s.symbol}</b>  [${today}]\n`;
  msg += `<i>20-Day High Breakout | Nifty ${regime.close} | 20d: ${regime.change20d}%</i>\n\n`;

  msg += `  Close          : ₹${s.close}\n`;
  msg += `  Breakout       : +${s.breakoutPct}% above 20d high  (prev: ₹${s.prevHigh})\n`;
  msg += `  Volume         : ${s.volMultiple}x avg  |  RSI: ${s.rsi}\n`;
  msg += `  50 EMA dist    : +${s.distEma50Pct}%\n`;
  msg += `  Entry          : buy before 3:30 PM today OR tomorrow's open\n`;
  msg += `  SL             : 5% below entry (~₹${s.suggestedSL})\n`;
  msg += `  T1 (+10%)      : scale 50% out, SL to breakeven\n`;
  msg += `  T2 (+20%)      : full exit (or close below 20 EMA)\n`;

  if (forecast) {
    const biasIcon = forecast.bias === 'BULLISH' ? '▲' : forecast.bias === 'BEARISH' ? '▼' : '—';
    msg += `\n  — Forecast (22d) —\n`;
    msg += `  Bias         : ${biasIcon} ${forecast.bias}\n`;
    msg += `  Target price : ₹${forecast.end_price.toFixed(2)}  (${forecast.change_pct >= 0 ? '+' : ''}${forecast.change_pct.toFixed(2)}%)\n`;
    msg += `  Peak / Trough: ₹${forecast.peak.toFixed(2)} / ₹${forecast.trough.toFixed(2)}\n`;
    msg += `  Upside / Down: +${forecast.upside_pct.toFixed(2)}% / ${forecast.downside_pct.toFixed(2)}%\n`;
  }

  msg += `\n<i>Max 4 positions | 25% capital each</i>`;
  return msg;
}

// ── Main scanner ──────────────────────────────────────────────────────────────
async function runScanner() {
  const today   = new Date().toISOString().slice(0, 10);
  const startTs = Date.now();

  console.log(`\n${'═'.repeat(68)}`);
  console.log(`  BREAKOUT SCANNER  —  ${today}`);
  console.log(`  Universe: ALL_OPTION_STOCKS (${ALL_OPTION_STOCKS.length} stocks)`);
  console.log(`  Signal  : Close ≥1% above 20-day high | Volume ≥1.5x | RSI 50-75`);
  console.log(`${'═'.repeat(68)}\n`);

  // 1. Check market regime
  process.stdout.write('  Checking Nifty regime...');
  const regime = await checkNiftyRegime();
  if (!regime.bullish) {
    console.log(`\n  ⚠  MARKET NOT BULLISH — ${regime.reason}`);
    console.log(`  ✘  No signals taken today (protect capital)\n`);
    const result = { scanDate: today, marketBullish: false, marketReason: regime.reason, signals: [] };
    await saveAndNotify(result, today, regime, []);
    return;
  }
  console.log(` Nifty ${regime.close} | 50EMA ${regime.ema50} | 20d change ${regime.change20d}% → BULLISH ✓`);

  // 2. Scan all stocks
  const signals = [];
  console.log('\n  Scanning stocks...\n');

  for (let i = 0; i < ALL_OPTION_STOCKS.length; i += CONCURRENCY) {
    const batch = ALL_OPTION_STOCKS.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (symbol) => {
      try {
        const bars = await fetchEnriched(`${symbol}.NS`);
        const sig  = checkSignal(bars);
        return sig ? { symbol, ...sig } : null;
      } catch { return null; }
    }));
    for (const r of results) if (r) signals.push(r);
    process.stdout.write(`\r  Scanned ${Math.min(i + CONCURRENCY, ALL_OPTION_STOCKS.length)}/${ALL_OPTION_STOCKS.length} stocks... ${signals.length} signal(s) found so far`);
  }

  process.stdout.write('\r' + ' '.repeat(70) + '\r');

  // 3. Sort by breakout strength
  signals.sort((a, b) => b.breakoutPct - a.breakoutPct);

  // 4. Print results
  console.log(`${'═'.repeat(68)}`);
  console.log(`  SCAN COMPLETE — ${signals.length} signal(s) found`);
  console.log(`${'═'.repeat(68)}`);

  if (signals.length === 0) {
    console.log('\n  No breakout signals today.\n');
  } else {
    console.log(`\n  ${'Symbol'.padEnd(12)} ${'Close'.padStart(8)} ${'Breakout%'.padStart(10)} ${'Vol×'.padStart(6)} ${'RSI'.padStart(5)} ${'Dist50EMA%'.padStart(11)} ${'SuggestedSL'.padStart(12)}`);
    console.log(`  ${'─'.repeat(65)}`);
    for (const s of signals) {
      const bStr = `+${s.breakoutPct}%`;
      console.log(
        `  ${s.symbol.padEnd(12)} ${String(s.close).padStart(8)} ${bStr.padStart(10)} ${String(s.volMultiple).padStart(6)}x ${String(s.rsi).padStart(5)} ${('+' + s.distEma50Pct + '%').padStart(11)} ${String(s.suggestedSL).padStart(12)}`
      );
    }

    console.log(`\n  HOW TO TRADE:`);
    console.log(`  • Buy before 3:30 PM today OR at tomorrow's open`);
    console.log(`  • SL: 5% below entry (recalculate from actual fill price)`);
    console.log(`  • Target 1: +10% — exit 50%, move SL to breakeven`);
    console.log(`  • Target 2: +20% OR close below 20 EMA — exit remaining`);
    console.log(`  • Max 4 stocks at once | 25% capital each`);
    console.log(`  • SKIP if 2 consecutive losses — wait 3 trading days`);
  }
  console.log(`\n  Scan time: ${((Date.now() - startTs) / 1000).toFixed(1)}s`);
  console.log(`${'═'.repeat(68)}\n`);

  // 5. Save output + notify
  const result = {
    scanDate: today,
    marketBullish: true,
    nifty: { close: regime.close, ema50: regime.ema50, change20d: regime.change20d },
    signalCount: signals.length,
    signals,
  };
  await saveAndNotify(result, today, regime, signals);
}

async function saveAndNotify(result, today, regime, signals) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outFile = path.join(OUTPUT_DIR, `${today}_breakout_scan.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(`  Saved: ${outFile}\n`);

  if (!regime.bullish) {
    await sendTelegram(`<b>Breakout Scanner — ${today}</b>\nMarket not bullish: ${regime.reason}\nNo signals today.`);
    return;
  }

  if (!signals.length) {
    await sendTelegram(`<b>Breakout Scanner — ${today}</b>\nNifty ${regime.close} | 50EMA ${regime.ema50} | 20d: ${regime.change20d}%\nMarket bullish — no breakout signals today.`);
    return;
  }

  // Send one message per signal as soon as its forecast arrives + save to DB
  await Promise.all(signals.map(async (s) => {
    const forecast = await fetchForecast(s.symbol, 'stock_nse').catch(() => null);

    // Only alert if forecast confirms LONG direction
    if (forecast?.bias !== 'BULLISH') {
      console.log(`[Breakout] Skipped Telegram for ${s.symbol} — forecast: ${forecast?.bias ?? 'unavailable'}`);
    } else {
      const msg = formatSignalMessage(s, today, regime, forecast);
      await sendTelegram(msg);
      console.log(`[Breakout] Sent: ${s.symbol}`);
    }

    const saved = saveSignal({
      scanner:               'breakout',
      symbol:                s.symbol,
      signal_date:           today,
      trade_type:            'LONG',
      entry_type:            'AUTO',
      sl:                    s.suggestedSL,
      t1:                    null,   // calculated from actual entry next day
      t2:                    null,
      risk_pct:              5,
      signal_close:          s.close,
      forecast_bias:         forecast?.bias              ?? null,
      forecast_target:       forecast?.end_price         ?? null,
      forecast_change_pct:   forecast?.change_pct        ?? null,
      forecast_peak:         forecast?.peak              ?? null,
      forecast_trough:       forecast?.trough            ?? null,
      forecast_upside_pct:   forecast?.upside_pct        ?? null,
      forecast_downside_pct: forecast?.downside_pct      ?? null,
      nifty_close:           regime.close,
      meta: { breakoutPct: s.breakoutPct, rsi: s.rsi, volMultiple: s.volMultiple, distEma50Pct: s.distEma50Pct },
    });
    if (!saved.duplicate) console.log(`[Breakout] Saved DB id=${saved.id}`);
  }));
}

// ── Export for cron registration ──────────────────────────────────────────────
export { runScanner };

// Run directly if called as main script
const isMain = process.argv[1]?.endsWith('breakoutScanner.js');
if (isMain) runScanner().catch(console.error);
