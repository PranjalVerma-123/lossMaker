/**
 * Test script — Weekly CPR scan with threshold 0.3%
 * Run: node src/cron/jobs/testWeeklyCPR.js
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  downloadBatch,
  calcCPR,
  resampleWeekly,
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
const THRESHOLD  = 0.3;

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

async function testWeeklyCPR() {
  const scanDate = new Date().toISOString().slice(0, 10);
  console.log(`[TEST-WeeklyCPR] Running scan... (threshold: ${THRESHOLD}%)`);

  const allBars = await downloadBatch(ALL_OPTION_STOCKS, '4mo', '1d', 20);
  const narrow  = [];

  for (const [symbol, bars] of Object.entries(allBars)) {
    if (!isLiquid(bars)) continue;

    const weeks = resampleWeekly(bars);
    const prev = weeks[weeks.length - 2]; // previous completed week
    if (!prev) continue;

    const cpr = calcCPR(prev.high, prev.low, prev.close);
    if (cpr.widthPct < THRESHOLD) {
      narrow.push({ symbol, ...cpr, sectors: getSectorTags(symbol) });
    }
  }

  narrow.sort((a, b) => a.widthPct - b.widthPct);

  const bySector = groupBySector(narrow);

  const result = {
    scanDate,
    type: 'Weekly-Test',
    threshold: `< ${THRESHOLD}%`,
    totalFound: narrow.length,
    bySector,
    stocks: narrow,
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const filepath = path.join(OUTPUT_DIR, `${scanDate}_weekly_test.json`);
  fs.writeFileSync(filepath, JSON.stringify(result, null, 2), 'utf8');

  console.log(`[TEST-WeeklyCPR] ${narrow.length} stocks found, saved: ${filepath}`);
  console.log(JSON.stringify(result, null, 2));
}

testWeeklyCPR().catch(console.error);
