/**
 * Test script — Daily CPR scan with threshold 0.1%
 * Run: node src/cron/jobs/testDailyCPR.js
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  downloadBatch,
  calcCPR,
} from '../../services/yFinance/index.js';

import { saveSignal } from '../../db/signals.js';

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
const THRESHOLD  = 0.1;

const SECTORS = {
  'Banking':       BANK_NIFTY,
  'IT':            NIFTY_IT,
  'Pharma':        NIFTY_PHARMA,
  'Auto':          NIFTY_AUTO,
  'Nifty 50':      NIFTY_50,
  'Nifty Next 50': NIFTY_NEXT_50,
  'Midcap 50':     NIFTY_MIDCAP_50,
};

const MIN_CLOSE        = 50;
const MIN_AVG_TURNOVER = 1e8;

function nextTradingDay(from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + 1);
  if (d.getDay() === 6) d.setDate(d.getDate() + 2);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

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

function isLiquid(bars) {
  const last = bars[bars.length - 1];
  if (!last || last.close < MIN_CLOSE) return false;
  const window = bars.slice(-20);
  const avgTurnover = window.reduce((sum, b) => sum + b.close * (b.volume ?? 0), 0) / window.length;
  return avgTurnover >= MIN_AVG_TURNOVER;
}

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
        console.warn(`[TEST-DailyCPR] Forecast skipped for ${symbol}: HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      if (data) return data;
    } catch (err) {
      // Network/connection error — worth retrying after 1 minute
      console.warn(`[TEST-DailyCPR] Forecast network error for ${symbol} (attempt ${attempt}): ${err.message}`);
      if (attempt < 2) {
        console.log(`[TEST-DailyCPR] Retrying ${symbol} in 1 minute...`);
        await sleep(FORECAST_RETRY_DELAY);
      }
    }
  }
  console.warn(`[TEST-DailyCPR] Forecast failed for ${symbol} after 2 attempts`);
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

async function testDailyCPR() {
  const scanDate = new Date().toISOString().slice(0, 10);
  console.log(`[TEST-DailyCPR] Running scan... (threshold: ${THRESHOLD}%)`);

  const allBars = await downloadBatch(ALL_OPTION_STOCKS, '2mo', '1d', 20);
  const narrow  = [];

  for (const [symbol, bars] of Object.entries(allBars)) {
    if (!isLiquid(bars)) continue;

    const prev = bars[bars.length - 2]; // previous completed day
    if (!prev) continue;

    const cpr = calcCPR(prev.high, prev.low, prev.close);
    if (cpr.widthPct < THRESHOLD) {
      narrow.push({
        symbol,
        dayClose:  bars[bars.length - 1].close,
        prevHigh:  prev.high,
        prevLow:   prev.low,
        prevClose: prev.close,
        ...cpr,
        sectors: getSectorTags(symbol),
      });
    }
  }

  // Fetch forecasts for all narrow CPR stocks
  const forecastMap = await fetchForecasts(narrow.map(s => s.symbol));
  for (const stock of narrow) {
    const f = forecastMap[stock.symbol];
    stock.forecast = f
      ? { bias: f.bias, change_pct: f.change_pct, end_price: f.end_price }
      : null;
  }

  narrow.sort((a, b) => a.widthPct - b.widthPct);

  // ── Save signals to DB ────────────────────────────────────────────────────
  const signalDate = nextTradingDay();
  let saved = 0, dupes = 0;

  for (const stock of narrow) {
    const bias      = stock.forecast?.bias ?? null;
    const tradeType = bias === 'BEARISH' ? 'SHORT' : 'LONG';

    const sl = tradeType === 'LONG'  ? stock.BC : stock.TC;
    const t1 = tradeType === 'LONG'  ? stock.R1 : stock.S1;
    const t2 = tradeType === 'LONG'  ? stock.R2 : stock.S2;

    const res = saveSignal({
      scanner:              'NARROW_CPR_DAILY',
      symbol:               stock.symbol,
      signal_date:          signalDate,
      trade_type:           tradeType,
      entry_type:           'AUTO',
      entry_trigger:        stock.P,
      sl,
      t1,
      t2,
      signal_close:         stock.prevClose,
      signal_high:          stock.prevHigh,
      signal_low:           stock.prevLow,
      forecast_bias:        bias,
      forecast_target:      stock.forecast?.end_price      ?? null,
      forecast_change_pct:  stock.forecast?.change_pct     ?? null,
      forecast_peak:        stock.forecast?.peak           ?? null,
      forecast_trough:      stock.forecast?.trough         ?? null,
      forecast_upside_pct:  stock.forecast?.upside_pct     ?? null,
      forecast_downside_pct:stock.forecast?.downside_pct   ?? null,
      meta: {
        P: stock.P, BC: stock.BC, TC: stock.TC,
        widthPct: stock.widthPct,
        sectors:  stock.sectors,
      },
    });

    if (res.duplicate) dupes++; else saved++;
  }

  console.log(`[TEST-DailyCPR] Signals saved: ${saved}, duplicates skipped: ${dupes}`);

  const bySector = groupBySector(narrow);

  const result = {
    scanDate,
    type: 'Daily-Test',
    threshold: `< ${THRESHOLD}%`,
    totalFound: narrow.length,
    bySector,
    stocks: narrow,
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const filepath = path.join(OUTPUT_DIR, `${scanDate}_daily_test.json`);
  fs.writeFileSync(filepath, JSON.stringify(result, null, 2), 'utf8');

  console.log(`[TEST-DailyCPR] ${narrow.length} stocks found, saved: ${filepath}`);
  console.log(JSON.stringify(result, null, 2));
}

testDailyCPR().catch(console.error);
