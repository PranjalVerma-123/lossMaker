/**
 * Multibagger Scanner — Fundamentals + Stage 2 Technical Entry
 *
 * Flow:
 *   1. Download all NSE equity symbols
 *   2. Scrape screener.in fundamentals (cached 7 days)
 *   3. Apply CANSLIM / multibagger fundamental filters
 *   4. Download yfinance price data for shortlisted stocks
 *   5. Apply Stage 2 + near-52wk-high technical filter
 *   6. Output ranked shortlist to file + Telegram
 *
 * Run: node src/scanner/multibaggerScanner.js
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

import { downloadBatch, calcEMA } from '../services/yFinance/index.js';
import { scrapeCompany, extractFundamentals, getCached } from '../services/screener/scraper.js';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR   = path.join(__dirname, '..', '..', 'output', 'multibagger');

// ── Fundamental filters ───────────────────────────────────────────────────────
const F = {
  MIN_SALES_GROWTH_3YR : 20,    // % CAGR
  MIN_EPS_GROWTH_3YR   : 25,    // % CAGR
  MIN_ROCE             : 15,    // %
  MAX_DEBT_EQUITY      : 1.0,
  MIN_PROMOTER_PCT     : 40,    // %
  MIN_MARKET_CAP       : 200,   // ₹ Cr
  MAX_MARKET_CAP       : 15_000,// ₹ Cr  (small + midcap sweet spot)
};

// ── Technical filters ─────────────────────────────────────────────────────────
const T = {
  // Tier 1 (buy zone): strict Stage 2
  TIER1_MAX_FROM_52H   : 15,    // % — within 15% of 52-week high
  TIER1_MIN_FROM_52L   : 30,    // % — ≥30% above 52-week low
  // Tier 2 (watchlist): recovering — just needs to be above 200 EMA
  TIER2_MAX_FROM_52H   : 40,    // % — within 40% of 52-week high
};

// ── Telegram ──────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID, text, parse_mode: 'HTML',
    });
  } catch (e) {
    console.error('[Telegram] Failed:', e.message);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer':    'https://www.nseindia.com/',
  'Accept':     'text/html,application/xhtml+xml,*/*;q=0.8',
};

// ── Fetch Nifty 500 symbols from NSE ─────────────────────────────────────────
async function fetchNifty500() {
  const cacheFile = path.join(__dirname, '..', '..', 'cache', 'nifty500.json');
  const TTL = 7 * 24 * 3600 * 1000;

  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    if (Date.now() - stat.mtimeMs < TTL) {
      const syms = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      console.log(`[NSE] Nifty 500 loaded from cache: ${syms.length} symbols`);
      return syms;
    }
  }

  try {
    const res = await axios.get(
      'https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv',
      { headers: NSE_HEADERS, timeout: 30_000 }
    );
    // CSV format: Company Name,Industry,Symbol,Series,ISIN Code
    const lines   = res.data.trim().split('\n');
    const symbols = lines
      .slice(1)
      .map(l => l.split(',')[2]?.trim().replace(/"/g, ''))
      .filter(s => s && /^[A-Z0-9&.-]+$/.test(s));

    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(symbols), 'utf8');
    console.log(`[NSE] Nifty 500 fetched: ${symbols.length} symbols`);
    return symbols;
  } catch (e) {
    console.warn('[NSE] Nifty 500 fetch failed:', e.message, '— using fallback');
    const { ALL_OPTION_STOCKS, NIFTY_NEXT_50, NIFTY_MIDCAP_50 } = await import('../constant/nseStocks.js');
    return [...new Set([...ALL_OPTION_STOCKS, ...NIFTY_NEXT_50, ...NIFTY_MIDCAP_50])];
  }
}

// ── Fetch all NSE equity symbols ──────────────────────────────────────────────
async function fetchNSESymbols() {
  const cacheFile = path.join(__dirname, '..', '..', 'cache', 'nse_equity_list.json');
  const TTL = 7 * 24 * 3600 * 1000;

  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    if (Date.now() - stat.mtimeMs < TTL) {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
  }

  try {
    const res = await axios.get(
      'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv',
      { headers: NSE_HEADERS, timeout: 30_000 }
    );
    const lines   = res.data.trim().split('\n');
    const symbols = lines
      .slice(1)
      .map(l => l.split(',')[0]?.trim().replace(/"/g, ''))
      .filter(s => s && /^[A-Z0-9&-]+$/.test(s));

    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(symbols), 'utf8');
    console.log(`[NSE] Fetched ${symbols.length} equity symbols`);
    return symbols;
  } catch (e) {
    console.warn('[NSE] Could not fetch equity list:', e.message);
    const { ALL_OPTION_STOCKS, NIFTY_NEXT_50 } = await import('../constant/nseStocks.js');
    return [...new Set([...ALL_OPTION_STOCKS, ...NIFTY_NEXT_50])];
  }
}

// ── Fundamental filter ────────────────────────────────────────────────────────
function passesFundamentals(f) {
  if (!f) return false;
  if (f.marketCap == null || f.marketCap < F.MIN_MARKET_CAP || f.marketCap > F.MAX_MARKET_CAP) return false;
  if (f.salesGrowth3yr == null || f.salesGrowth3yr < F.MIN_SALES_GROWTH_3YR) return false;
  if (f.epsGrowth3yr   == null || f.epsGrowth3yr   < F.MIN_EPS_GROWTH_3YR)   return false;
  if (f.roce           == null || f.roce           < F.MIN_ROCE)              return false;
  if (f.debtEquity     != null && f.debtEquity     > F.MAX_DEBT_EQUITY)       return false;
  if (f.promoterPct    != null && f.promoterPct    < F.MIN_PROMOTER_PCT)      return false;
  return true;
}

// ── Technical analysis — returns tier (1=buy, 2=watchlist, null=skip) ─────────
function checkTechnicals(symbol, bars) {
  if (!bars || bars.length < 220) return null;

  const closes  = bars.map(b => b.close);
  const ema50   = calcEMA(closes, 50);
  const ema200  = calcEMA(closes, 200);

  const last    = bars.length - 1;
  const close   = bars[last].close;
  const e50     = ema50[last];
  const e200    = ema200[last];
  const e200_20 = ema200[last - 20];

  if (!e50 || !e200 || !e200_20) return null;

  // Must be at least above 200 EMA (long-term positive)
  if (close <= e200) return null;

  // 52-week high/low
  const window  = bars.slice(Math.max(0, last - 252));
  const high52  = Math.max(...window.map(b => b.high));
  const low52   = Math.min(...window.map(b => b.low));
  const fromHigh = (high52 - close) / high52 * 100;
  const fromLow  = (close - low52)  / low52  * 100;

  // Volume trend
  const vol20 = bars.slice(last - 20, last).reduce((s, b) => s + (b.volume ?? 0), 0) / 20;
  const vol60 = bars.slice(last - 60, last).reduce((s, b) => s + (b.volume ?? 0), 0) / 60;
  const volExpanding = vol20 > vol60;

  // 6-month relative strength
  const bar6m  = bars[Math.max(0, last - 126)];
  const rs6m   = bar6m ? +((close - bar6m.close) / bar6m.close * 100).toFixed(2) : null;

  const base = {
    close:       +close.toFixed(2),
    ema50:       +e50.toFixed(2),
    ema200:      +e200.toFixed(2),
    fromHigh52:  +fromHigh.toFixed(2),
    fromLow52:   +fromLow.toFixed(2),
    volExpanding,
    rs6mPct:     rs6m,
    ema200Rising: e200 > e200_20,
  };

  // Tier 1 — full Stage 2: close > 50 EMA > 200 EMA, 200 rising, near 52wk high
  const isStage2 = close > e50 && e50 > e200 && e200 > e200_20;
  if (isStage2 && fromHigh <= T.TIER1_MAX_FROM_52H && fromLow >= T.TIER1_MIN_FROM_52L) {
    return { ...base, tier: 1, tierLabel: 'BUY ZONE' };
  }

  // Tier 2 — above 200 EMA, within 40% of 52wk high (recovering / base building)
  if (fromHigh <= T.TIER2_MAX_FROM_52H) {
    return { ...base, tier: 2, tierLabel: 'WATCHLIST' };
  }

  return null;
}

// ── Scoring — rank candidates ─────────────────────────────────────────────────
function score(f, t) {
  let s = 0;
  if (f.salesGrowth3yr > 30) s += 2; else if (f.salesGrowth3yr > 20) s += 1;
  if (f.epsGrowth3yr   > 40) s += 3; else if (f.epsGrowth3yr > 25) s += 1;
  if (f.roce           > 25) s += 2; else if (f.roce > 15) s += 1;
  if (f.debtEquity != null && f.debtEquity < 0.3) s += 2;
  if (f.promoterPct != null && f.promoterPct > 60) s += 1;
  if (t.fromHigh52 < 5)  s += 3;  // very close to ATH
  if (t.fromHigh52 < 10) s += 1;
  if (t.rs6mPct != null && t.rs6mPct > 30) s += 2;
  if (t.volExpanding) s += 1;
  return s;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const scanDate = new Date().toISOString().slice(0, 10);
  const mode     = process.argv[2] ?? 'nifty500';  // 'nifty500' | 'all'
  console.log(`[Multibagger] Scan started: ${scanDate}  mode=${mode}`);

  // 1. Get symbols
  const symbols = mode === 'all' ? await fetchNSESymbols() : await fetchNifty500();
  console.log(`[Multibagger] Universe: ${symbols.length} stocks`);

  // 2. Scrape fundamentals
  const fundamentallySound = [];
  let scraped = 0, skipped = 0, failed = 0;

  for (const sym of symbols) {
    process.stdout.write(`\r[Multibagger] Scraping ${++scraped}/${symbols.length}: ${sym.padEnd(15)} | Passed: ${fundamentallySound.length}`);

    const wasCached = getCached(sym) !== null;
    const raw  = await scrapeCompany(sym);
    const fund = extractFundamentals(raw);

    if (!fund) { failed++; }
    else if (passesFundamentals(fund)) { fundamentallySound.push(fund); }
    else { skipped++; }

    if (!wasCached) await sleep(1200); // delay only when actually scraping live
  }

  console.log(`\n[Multibagger] Scraping done. Passed: ${fundamentallySound.length} | Failed: ${failed} | Filtered: ${skipped}`);

  if (!fundamentallySound.length) {
    console.log('[Multibagger] No stocks passed fundamental filters.');
    return;
  }

  // 3. Download price data for fundamental candidates
  const fundSymbols = fundamentallySound.map(f => f.symbol);
  console.log(`[Multibagger] Downloading price data for ${fundSymbols.length} stocks...`);
  const priceData = await downloadBatch(fundSymbols, '2y', '1d', 15);

  // 4. Apply technical filters
  const candidates = [];
  for (const f of fundamentallySound) {
    const bars = priceData[f.symbol];
    const tech = checkTechnicals(f.symbol, bars);
    if (!tech) continue;
    candidates.push({ ...f, ...tech, score: score(f, tech) });
  }

  // 5. Sort by score desc
  candidates.sort((a, b) => b.score - a.score);

  console.log(`[Multibagger] Final candidates: ${candidates.length}`);

  // ── Print results ────────────────────────────────────────────────────────
  const header = () => console.log(
    'Symbol'.padEnd(14) +
    'MCap(Cr)'.padEnd(10) +
    'SalesGr%'.padEnd(10) +
    'EPSGr%'.padEnd(9) +
    'ROCE%'.padEnd(8) +
    'D/E'.padEnd(6) +
    'Promo%'.padEnd(9) +
    'From52H%'.padEnd(10) +
    'RS6m%'.padEnd(9) +
    'Score'
  );
  const printRow = c => console.log(
    c.symbol.padEnd(14) +
    String(c.marketCap ?? '-').padEnd(10) +
    String(c.salesGrowth3yr ?? '-').padEnd(10) +
    String(c.epsGrowth3yr ?? '-').padEnd(9) +
    String(c.roce ?? '-').padEnd(8) +
    String(c.debtEquity ?? '-').padEnd(6) +
    String(c.promoterPct ?? '-').padEnd(9) +
    ('-' + (c.fromHigh52 ?? '-') + '%').padEnd(10) +
    ((c.rs6mPct != null ? (c.rs6mPct >= 0 ? '+' : '') + c.rs6mPct : '-') + '%').padEnd(9) +
    c.score
  );

  const tier1 = candidates.filter(c => c.tier === 1);
  const tier2 = candidates.filter(c => c.tier === 2);

  console.log('\n' + '═'.repeat(104));
  console.log(`  TIER 1 — BUY ZONE (Stage 2 + near 52wk high) — ${tier1.length} stocks`);
  console.log('═'.repeat(104));
  if (tier1.length) { header(); console.log('─'.repeat(104)); tier1.forEach(printRow); }
  else console.log('  None — market not in full Stage 2 for these candidates');

  console.log('\n' + '─'.repeat(104));
  console.log(`  TIER 2 — WATCHLIST (strong fundamentals, above 200 EMA, base-building) — ${tier2.length} stocks`);
  console.log('─'.repeat(104));
  if (tier2.length) { header(); console.log('─'.repeat(104)); tier2.forEach(printRow); }
  else console.log('  None');

  console.log('═'.repeat(104));

  // ── Save to file ──────────────────────────────────────────────────────────
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outFile = path.join(OUTPUT_DIR, `${scanDate}_multibagger.json`);
  fs.writeFileSync(outFile, JSON.stringify({ scanDate, total: candidates.length, candidates }, null, 2), 'utf8');
  console.log(`[Multibagger] Saved: ${outFile}`);

  // ── Telegram ──────────────────────────────────────────────────────────────
  if (candidates.length && BOT_TOKEN && CHAT_ID) {
    const top = candidates.slice(0, 15);
    let msg = `<b>Multibagger Shortlist — ${scanDate}</b>\n`;
    msg += `Fundamental + Stage 2 filter | ${candidates.length} candidates\n\n`;
    for (const c of top) {
      msg += `<b>${c.symbol}</b>  MCap: ₹${c.marketCap}Cr | EPS gr: ${c.epsGrowth3yr}% | ROCE: ${c.roce}%\n`;
      msg += `  From 52wH: -${c.fromHigh52}% | RS6m: +${c.rs6mPct}% | Score: ${c.score}\n\n`;
    }
    await sendTelegram(msg);
    console.log('[Telegram] Alert sent.');
  }
}

main().catch(console.error);
