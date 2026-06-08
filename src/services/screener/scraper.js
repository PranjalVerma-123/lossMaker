/**
 * Screener.in per-company scraper
 * Scrapes fundamentals from https://www.screener.in/company/{SYMBOL}/
 * Caches results for 7 days to avoid re-scraping
 */

import axios    from 'axios';
import * as cheerio from 'cheerio';
import fs       from 'fs';
import path     from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR   = path.join(__dirname, '..', '..', '..', 'cache', 'screener');
const CACHE_TTL   = 7 * 24 * 3600 * 1000; // 7 days

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection':      'keep-alive',
};

// ── Cache helpers ─────────────────────────────────────────────────────────────
export function getCached(symbol) {
  const file = path.join(CACHE_DIR, `${symbol}.json`);
  if (!fs.existsSync(file)) return null;
  if (Date.now() - fs.statSync(file).mtimeMs > CACHE_TTL) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function setCache(symbol, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, `${symbol}.json`), JSON.stringify(data), 'utf8');
}

// ── Number parser ─────────────────────────────────────────────────────────────
function parseNum(str) {
  if (!str) return null;
  // Take first token (handles "1,621 / 1,288" — picks 1621)
  const first = String(str)
    .replace(/₹/g, '')
    .replace(/%/g, '')
    .replace(/\bCr\.?\b/gi, '')
    .replace(/,/g, '')
    .trim()
    .split(/\s+/)[0];
  const n = parseFloat(first);
  return isNaN(n) ? null : n;
}

// ── Table parser ──────────────────────────────────────────────────────────────
// Returns { headers: [...years], rows: { 'Row Label': [v1, v2, ...] } }
function parseTable($, sectionSel) {
  const headers = [];
  const rows    = {};

  $(`${sectionSel} table thead tr th`).each((_, th) => {
    headers.push($(th).text().trim());
  });

  $(`${sectionSel} table tbody tr`).each((_, tr) => {
    const cells = [];
    $(tr).find('td').each((_, td) => cells.push($(td).text().trim()));
    if (cells.length < 2) return;
    const label = cells[0].replace(/[+\-]/g, '').trim();
    rows[label] = cells.slice(1).map(parseNum);
  });

  return { headers: headers.slice(1), rows };
}

// ── Main scrape ───────────────────────────────────────────────────────────────
export async function scrapeCompany(symbol) {
  const cached = getCached(symbol);
  if (cached) return cached;

  // Try consolidated first, then standalone
  for (const variant of ['consolidated', 'standalone', '']) {
    const url = variant
      ? `https://www.screener.in/company/${symbol}/${variant}/`
      : `https://www.screener.in/company/${symbol}/`;
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: 20_000, maxRedirects: 5 });
      if (res.status !== 200) continue;

      const $ = cheerio.load(res.data);

      // Detect login wall
      if ($('form[action*="login"]').length || $('input[name="password"]').length) return null;

      // ── Overview ratios ────────────────────────────────────────────────────
      const overview = {};
      $('#top-ratios li').each((_, li) => {
        const name = $(li).find('.name').text().trim().toLowerCase().replace(/\s+/g, '_');
        const val  = parseNum($(li).find('.number').text());
        if (name && val != null) overview[name] = val;
      });

      // ── Tables ─────────────────────────────────────────────────────────────
      const pl     = parseTable($, '#profit-loss');
      const bs     = parseTable($, '#balance-sheet');
      const ratios = parseTable($, '#ratios');
      const sh     = parseTable($, '#shareholding');

      const data = { symbol, overview, pl, bs, ratios, sh, scrapedAt: Date.now() };
      setCache(symbol, data);
      return data;
    } catch {
      // try next variant
    }
  }
  return null;
}

// ── Extract structured fundamentals from raw scraped data ─────────────────────
export function extractFundamentals(raw) {
  if (!raw) return null;
  const { symbol, overview, pl, bs, sh } = raw;

  // Helper: 3-yr CAGR from an annual row (skip TTM = last element)
  function cagr3yr(row) {
    if (!row?.length) return null;
    const vals = row.slice(0, -1).filter(v => v !== null && v > 0); // exclude TTM
    if (vals.length < 4) return null;
    const end   = vals[vals.length - 1];
    const start = vals[vals.length - 4];
    if (!start || start <= 0 || end <= 0) return null;
    return +( ((end / start) ** (1 / 3) - 1) * 100 ).toFixed(2);
  }

  // Helper: latest non-null value (skip TTM)
  function latest(row) {
    if (!row?.length) return null;
    const annual = row.slice(0, -1).filter(v => v !== null);
    return annual.length ? annual[annual.length - 1] : null;
  }

  // Sales
  const salesRow = pl.rows['Sales'] ?? pl.rows['Revenue from operations'] ?? pl.rows['Revenue'];
  const salesGrowth3yr = cagr3yr(salesRow);
  const latestSales    = latest(salesRow);

  // EPS
  const epsRow      = pl.rows['EPS in Rs'];
  const epsGrowth3yr = cagr3yr(epsRow);
  const latestEps   = latest(epsRow);

  // Net profit
  const npRow           = pl.rows['Net Profit'] ?? pl.rows['Profit after tax'];
  const npGrowth3yr     = cagr3yr(npRow);

  // ROCE — try overview first, then ratios table
  const roce = overview['roce'] ?? overview['return_on_capital_employed'] ??
               (raw.ratios?.rows?.['ROCE %'] ? latest(raw.ratios.rows['ROCE %']) : null);

  // ROE
  const roe = overview['roe'] ?? overview['return_on_equity'];

  // Market cap
  const marketCap = overview['market_cap'] ?? overview['market cap'];

  // Debt/Equity
  const borrowRow  = bs.rows['Borrowings'];
  const reserveRow = bs.rows['Reserves'];
  const capRow     = bs.rows['Share Capital'] ?? bs.rows['Equity Capital'];
  let debtEquity   = null;
  if (borrowRow && reserveRow && capRow) {
    const debt   = latest(borrowRow) ?? 0;
    const equity = (latest(reserveRow) ?? 0) + (latest(capRow) ?? 0);
    debtEquity   = equity > 0 ? +(debt / equity).toFixed(2) : null;
  }

  // Promoter holding — latest quarter
  const promoterRow = sh.rows['Promoters'] ?? sh.rows['Promoter & Promoter Group'];
  const promoterPct = promoterRow ? promoterRow[promoterRow.length - 1] : null;

  // Quarterly EPS growth YoY (latest Q vs same Q prior year)
  // screener stores quarterly data separately — skip for now, use annual EPS growth

  return {
    symbol,
    marketCap,
    roce,
    roe,
    salesGrowth3yr,
    epsGrowth3yr,
    npGrowth3yr,
    debtEquity,
    promoterPct,
    latestSales,
    latestEps,
  };
}
