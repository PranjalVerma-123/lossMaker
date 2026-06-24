/**
 * Monthly CPR Zone Scanner
 *
 * Finds stocks where:
 *  1. Monthly CPR is narrow  (widthPct < THRESHOLD)
 *  2. Current price is inside or touching the CPR zone (BC ↔ TC ± ZONE_BUFFER)
 *
 * CPR zone = between BC and TC of the previous completed month.
 * When price re-enters a narrow monthly CPR zone it acts as a strong
 * support/resistance confluence — high probability reversal or breakout area.
 *
 * Universe : ALL_OPTION_STOCKS (~327 FnO stocks, proxy for Nifty 500)
 * Run      : node src/cron/jobs/monthlyCprZoneScanner.js
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import 'dotenv/config';

import {
  downloadBatch,
  calcCPR,
  resampleMonthly,
} from '../../services/yFinance/index.js';

import { fetchForecast } from '../../api/api.js';

import {
  ALL_OPTION_STOCKS,
  BANK_NIFTY,
  NIFTY_IT,
  NIFTY_PHARMA,
  NIFTY_AUTO,
  NIFTY_50,
  NIFTY_NEXT_50,
  NIFTY_MIDCAP_50,
} from '../../constant/nseStocks.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', '..', '..', 'output', 'monthly_cpr_zone');

// ── Config ────────────────────────────────────────────────────────────────────
const CPR_THRESHOLD = 0.5;   // monthly CPR widthPct must be < 0.5%
const ZONE_BUFFER   = 0.3;   // price must be within ±0.3% of the CPR zone edges

const MIN_CLOSE        = 50;
const MIN_AVG_TURNOVER = 1e8;

// ── Sector map ────────────────────────────────────────────────────────────────
const SECTORS = {
  'Banking':       BANK_NIFTY,
  'IT':            NIFTY_IT,
  'Pharma':        NIFTY_PHARMA,
  'Auto':          NIFTY_AUTO,
  'Nifty 50':      NIFTY_50,
  'Nifty Next 50': NIFTY_NEXT_50,
  'Midcap 50':     NIFTY_MIDCAP_50,
};

function getSectorTags(symbol) {
  const tags = [];
  for (const [sector, list] of Object.entries(SECTORS)) {
    if (list.includes(symbol)) tags.push(sector);
  }
  return tags.length ? tags : ['Other'];
}

function isLiquid(bars) {
  const last = bars[bars.length - 1];
  if (!last || last.close < MIN_CLOSE) return false;
  const window = bars.slice(-20);
  const avgTurnover = window.reduce((sum, b) => sum + b.close * (b.volume ?? 0), 0) / window.length;
  return avgTurnover >= MIN_AVG_TURNOVER;
}

// ── CPR zone check ────────────────────────────────────────────────────────────
// Returns how the price sits relative to the CPR zone:
//   'inside'  — price is strictly between BC and TC
//   'touching'— price is within ZONE_BUFFER% of zone edges (just outside)
//   null      — price is too far away
function getCprZoneStatus(price, BC, TC) {
  const zoneLow  = Math.min(BC, TC);
  const zoneHigh = Math.max(BC, TC);

  if (price >= zoneLow && price <= zoneHigh) return 'inside';

  const bufferLow  = zoneLow  * (1 - ZONE_BUFFER / 100);
  const bufferHigh = zoneHigh * (1 + ZONE_BUFFER / 100);

  if (price >= bufferLow && price <= bufferHigh) return 'touching';

  return null;
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[MonthlyCPRZone] Telegram env vars not set, skipping');
    return;
  }
  try {
    for (let i = 0; i < message.length; i += 4000) {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id:    chatId,
        text:       message.slice(i, i + 4000),
        parse_mode: 'HTML',
      });
    }
  } catch (err) {
    console.error('[MonthlyCPRZone] Telegram error:', err.message);
  }
}

function buildTelegramMessage(results, scanDate) {
  // Only include forecast-confirmed stocks
  const confirmed = results.filter(r => r.forecast && r.forecastMatch);
  if (!confirmed.length) return null;

  const longs  = confirmed.filter(r => r.direction === 'LONG');
  const shorts = confirmed.filter(r => r.direction === 'SHORT');

  let msg = `<b>Monthly CPR Zone Scanner — ${scanDate}</b>\n`;
  msg += `CPR width &lt; ${CPR_THRESHOLD}% | Forecast-confirmed only\n\n`;

  if (longs.length) {
    msg += `<b>▲ LONG (price at support, Forecast: BULLISH) — ${longs.length}</b>\n`;
    for (const r of longs) {
      const tag = r.zoneStatus === 'inside' ? '🎯 inside' : '📍 touching';
      msg += `  <b>${r.symbol}</b>  ₹${r.currentPrice}  [${tag}]\n`;
      msg += `    P:${r.P}  BC:${r.BC}  TC:${r.TC}  Width:${r.widthPct}%\n`;
      msg += `    Forecast → Target: ₹${r.forecast.end_price}  (${r.forecast.change_pct >= 0 ? '+' : ''}${r.forecast.change_pct}%)\n`;
      msg += `    Sectors: ${r.sectors.join(', ')}\n`;
    }
    msg += '\n';
  }

  if (shorts.length) {
    msg += `<b>▼ SHORT (price at resistance, Forecast: BEARISH) — ${shorts.length}</b>\n`;
    for (const r of shorts) {
      const tag = r.zoneStatus === 'inside' ? '🎯 inside' : '📍 touching';
      msg += `  <b>${r.symbol}</b>  ₹${r.currentPrice}  [${tag}]\n`;
      msg += `    P:${r.P}  BC:${r.BC}  TC:${r.TC}  Width:${r.widthPct}%\n`;
      msg += `    Forecast → Target: ₹${r.forecast.end_price}  (${r.forecast.change_pct >= 0 ? '+' : ''}${r.forecast.change_pct}%)\n`;
      msg += `    Sectors: ${r.sectors.join(', ')}\n`;
    }
  }

  return msg;
}

// ── Main scanner ──────────────────────────────────────────────────────────────
export async function runMonthlyCprZoneScanner() {
  const scanDate = new Date().toISOString().slice(0, 10);
  console.log(`[MonthlyCPRZone] Scanning ${ALL_OPTION_STOCKS.length} stocks... (CPR < ${CPR_THRESHOLD}%, zone buffer ±${ZONE_BUFFER}%)`);

  const allBars = await downloadBatch(ALL_OPTION_STOCKS, '6mo', '1d', 20);
  const results = [];

  for (const [symbol, bars] of Object.entries(allBars)) {
    if (!isLiquid(bars)) continue;

    const months = resampleMonthly(bars);
    const prev   = months[months.length - 2]; // previous completed month
    if (!prev) continue;

    const cpr = calcCPR(prev.high, prev.low, prev.close);
    if (cpr.widthPct >= CPR_THRESHOLD) continue; // not narrow enough

    const currentPrice = bars[bars.length - 1].close;
    const zoneStatus   = getCprZoneStatus(currentPrice, cpr.BC, cpr.TC);
    if (!zoneStatus) continue; // price not near CPR zone

    // Direction: price at or below P = potential support bounce (LONG)
    //            price above P = potential resistance rejection (SHORT)
    const direction = currentPrice <= cpr.P ? 'LONG' : 'SHORT';

    results.push({
      symbol,
      currentPrice: Math.round(currentPrice * 100) / 100,
      zoneStatus,
      direction,
      ...cpr,
      sectors: getSectorTags(symbol),
    });
  }

  // Sort: inside first, then by widthPct ascending
  results.sort((a, b) => {
    if (a.zoneStatus !== b.zoneStatus) return a.zoneStatus === 'inside' ? -1 : 1;
    return a.widthPct - b.widthPct;
  });

  // Fetch forecasts and tag each result
  console.log(`[MonthlyCPRZone] Fetching forecasts for ${results.length} stock(s)...`);
  for (const r of results) {
    const f = await fetchForecast(r.symbol, 'stock_nse').catch(() => null);
    r.forecast     = f ? { bias: f.bias, end_price: Math.round(f.end_price * 100) / 100, change_pct: Math.round(f.change_pct * 100) / 100 } : null;
    r.forecastMatch = f ? (r.direction === 'LONG' ? f.bias === 'BULLISH' : f.bias === 'BEARISH') : false;
  }

  const confirmed = results.filter(r => r.forecastMatch);
  console.log(`[MonthlyCPRZone] ${results.length} stock(s) in zone | ${confirmed.length} forecast-confirmed (${confirmed.filter(r => r.direction === 'LONG').length} LONG, ${confirmed.filter(r => r.direction === 'SHORT').length} SHORT)`);

  // Save JSON
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outFile = path.join(OUTPUT_DIR, `${scanDate}_monthly_cpr_zone.json`);
  fs.writeFileSync(outFile, JSON.stringify({ scanDate, cprThreshold: CPR_THRESHOLD, zoneBuffer: ZONE_BUFFER, totalFound: results.length, results }, null, 2), 'utf8');
  console.log(`[MonthlyCPRZone] Saved: ${outFile}`);

  // Telegram
  const msg = buildTelegramMessage(results, scanDate);
  if (msg) await sendTelegram(msg);
  else console.log('[MonthlyCPRZone] No stocks found, skipping Telegram');

  return results;
}

// Run directly
const isMain = process.argv[1]?.endsWith('monthlyCprZoneScanner.js');
if (isMain) {
  runMonthlyCprZoneScanner()
    .then(results => console.log(JSON.stringify(results, null, 2)))
    .catch(console.error);
}
