/**
 * Narrow CPR Indicator — Cron Job
 *
 * Scans ALL_OPTION_STOCKS for stocks where CPR width < 0.1%
 * Runs:
 *   - Daily   : Mon–Fri  5:30 PM IST (after market close)
 *   - Weekly  : Saturday 5:30 PM IST
 *   - Monthly : Last day of month 5:30 PM IST
 *
 * Output: JSON file saved to output/narrow_cpr/ + Telegram notification
 */

import cron from 'node-cron';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

import {
  downloadBatch,
  calcCPR,
  resampleWeekly,
  resampleMonthly,
} from '../../services/yFinance/index.js';

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
const OUTPUT_DIR = path.join(__dirname, '..', '..', '..', 'output', 'narrow_cpr');
const THRESHOLD  = 0.1 // CPR widthPct < 0.1%
const THRESHOLD_Week = 0.3
const THRESHOLD_Month = 0.1

// ── Sector map ───────────────────────────────────────────────────────────────
const SECTORS = {
  'Banking':       BANK_NIFTY,
  'IT':            NIFTY_IT,
  'Pharma':        NIFTY_PHARMA,
  'Auto':          NIFTY_AUTO,
  'Nifty 50':      NIFTY_50,
  'Nifty Next 50': NIFTY_NEXT_50,
  'Midcap 50':     NIFTY_MIDCAP_50,
};

// ── CPR date helpers ─────────────────────────────────────────────────────────
function nextTradingDay(from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + 1);
  // Skip Saturday (6) and Sunday (0)
  if (d.getDay() === 6) d.setDate(d.getDate() + 2);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function nextWeekRange(from = new Date()) {
  // from = Saturday; next week is Mon–Fri
  const mon = new Date(from);
  mon.setDate(mon.getDate() + 2);
  const fri = new Date(mon);
  fri.setDate(fri.getDate() + 4);
  return `${mon.toISOString().slice(0, 10)} to ${fri.toISOString().slice(0, 10)}`;
}

function currentMonthLabel(from = new Date()) {
  return from.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function getSectorTags(symbol) {
  const tags = [];
  for (const [sector, list] of Object.entries(SECTORS)) {
    if (list.includes(symbol)) tags.push(sector);
  }
  return tags.length ? tags : ['Other'];
}

function groupBySector(narrowStocks) {
  const result = {};
  for (const stock of narrowStocks) {
    for (const sector of stock.sectors) {
      if (!result[sector]) result[sector] = [];
      result[sector].push(stock.symbol);
    }
  }
  return result;
}

function saveJSON(filename, data) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const filepath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
  return filepath;
}


// ── Telegram ─────────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[NarrowCPR] Telegram env vars not set, skipping notification');
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
    console.error('[NarrowCPR] Telegram error:', err.message);
  }
}

function buildTelegramMessage(type, cprFor, narrow, bySector) {
  if (!narrow.length) return null;
  let msg = `<b>Narrow CPR — ${type} | CPR for: ${cprFor}</b>\n`;
  msg += `<b>${narrow.length}</b> stock(s) with CPR width &lt; ${THRESHOLD}%\n\n`;
  for (const [sector, symbols] of Object.entries(bySector)) {
    const stocks = narrow.filter(s => s.sectors.includes(sector));
    msg += `<b>${sector}</b> (${symbols.length})\n`;
    for (const s of stocks) {
      msg += `  ${s.symbol} — P: ${s.P}  BC: ${s.BC}  TC: ${s.TC}  Width: ${s.widthPct}%\n`;
    }
    msg += '\n';
  }
  return msg;
}

// ── Liquidity filter ─────────────────────────────────────────────────────────
const MIN_CLOSE        = 50;          // ₹50 minimum price
const MIN_AVG_TURNOVER = 1e8;         // ₹10 crore = 100,000,000

function isLiquid(bars) {
  const last = bars[bars.length - 1];
  if (!last || last.close < MIN_CLOSE) return false;

  // Avg 20-day traded value = avg(close × volume)
  const window = bars.slice(-20);
  const avgTurnover = window.reduce((sum, b) => sum + b.close * (b.volume ?? 0), 0) / window.length;
  return avgTurnover >= MIN_AVG_TURNOVER;
}

// ── Forecast API ──────────────────────────────────────────────────────────────
const FORECAST_RETRY_DELAY = 60_000;     // 1 minute before retry on network error

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchForecast(symbol) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch('http://localhost:8000/forecast', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, asset_type: 'stock_nse', pred_len: 22, sample_count: 5 }),
      });
      // HTTP errors (4xx/5xx) = server rejected the request, no point retrying
      if (!res.ok) {
        console.warn(`[NarrowCPR] Forecast skipped for ${symbol}: HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      if (data) return data;
    } catch (err) {
      // Network/connection error — worth retrying after 1 minute
      console.warn(`[NarrowCPR] Forecast network error for ${symbol} (attempt ${attempt}): ${err.message}`);
      if (attempt < 2) {
        console.log(`[NarrowCPR] Retrying ${symbol} in 1 minute...`);
        await sleep(FORECAST_RETRY_DELAY);
      }
    }
  }
  console.warn(`[NarrowCPR] Forecast failed for ${symbol} after 2 attempts`);
  return null;
}

async function fetchForecasts(symbols) {
  if (!symbols.length) return {};
  const results = {};
  for (const symbol of symbols) {
    results[symbol] = await fetchForecast(symbol);
    await sleep(500); // small gap so Kronos isn't hit concurrently
  }
  return results;
}

// ── Scanner core ─────────────────────────────────────────────────────────────
async function scan(type, extractCPR, period, cprFor) {
  console.log(`[NarrowCPR] Running ${type} scan... (CPR for: ${cprFor})`);

  const allBars = await downloadBatch(ALL_OPTION_STOCKS, period, '1d', 20);
  const narrow  = [];

  for (const [symbol, bars] of Object.entries(allBars)) {
    if (!isLiquid(bars)) continue;       // skip penny / illiquid stocks

    const cprInput = extractCPR(bars);
    if (!cprInput) continue;

    const cpr = calcCPR(cprInput.high, cprInput.low, cprInput.close);
    if (cpr.widthPct < (type === 'Weekly' ? THRESHOLD_Week : type === 'Monthly' ? THRESHOLD_Month : THRESHOLD)) {
      narrow.push({ symbol, dayClose: bars[bars.length - 1].close, ...cpr, sectors: getSectorTags(symbol) });
    }
  }

  // Sort by widthPct ascending (tightest CPR first)
  narrow.sort((a, b) => a.widthPct - b.widthPct);

  // Fetch forecasts for all narrow CPR stocks
  const forecastMap = await fetchForecasts(narrow.map(s => s.symbol));
  for (const stock of narrow) {
    const f = forecastMap[stock.symbol];
    stock.forecast = f
      ? { bias: f.bias, change_pct: f.change_pct, end_price: f.end_price }
      : null;
  }

  const bySector  = groupBySector(narrow);
  const scanDate  = new Date().toISOString().slice(0, 10);

  const result = {
    scanDate,
    cprFor,
    type,
    threshold: `< ${THRESHOLD}%`,
    totalFound: narrow.length,
    bySector,
    stocks: narrow,
  };

  const filename = `${scanDate}_${type.toLowerCase()}.json`;
  const filepath = saveJSON(filename, result);
  console.log(`[NarrowCPR] ${type} — ${narrow.length} stocks found, CPR for: ${cprFor}, saved: ${filepath}`);

  const msg = buildTelegramMessage(type, cprFor, narrow, bySector);
  if (msg) {
    await sendTelegram(msg);
  } else {
    console.log(`[NarrowCPR] ${type} — no narrow CPR stocks found, skipping notification`);
  }
}

// ── Job runners ───────────────────────────────────────────────────────────────
function runDailyCPR() {
  return scan('Daily', bars => {
    const prev = bars[bars.length - 1]; 
    return prev ? { high: prev.high, low: prev.low, close: prev.close } : null;
  }, '2mo', nextTradingDay());
}

function runWeeklyCPR() {
  // Runs on Saturday → weeks[last] = this week (ending Fri), weeks[last-1] = previous completed week
  return scan('Weekly', bars => {
    const weeks = resampleWeekly(bars);
    const prev = weeks[weeks.length - 2]; // previous completed week H/L/C
    return prev || null;
  }, '4mo', `Week of ${nextWeekRange()}`);
}

function runMonthlyCPR() {
  // Runs on 1st of month → months[last] = today (incomplete), months[last-1] = previous full month
  return scan('Monthly', bars => {
    const months = resampleMonthly(bars);
    const prev = months[months.length - 2]; // previous completed month H/L/C
    return prev || null;
  }, '4mo', currentMonthLabel());
}

// ── Register cron schedules ───────────────────────────────────────────────────
export function registerNarrowCprJobs() {
  const TZ = { timezone: 'Asia/Kolkata' };

  // Daily: Mon–Fri at 5:30 PM IST
  cron.schedule('11 01 * * 1-5', runDailyCPR, TZ);

  // Weekly: Saturday at 5:30 PM IST
  cron.schedule('00 17 * * 5', runWeeklyCPR, TZ);

  // Monthly: last day of month at 5:30 PM IST
  // Fires on 28–31 and checks if tomorrow is the 1st
  cron.schedule('00 17 28,29,30,31, * *', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (tomorrow.getDate() === 2) runMonthlyCPR();
  }, TZ);

  console.log('[NarrowCPR] Jobs registered (Daily Mon-Fri | Weekly Sat | Monthly last day) @ 5:30 PM IST');
}
