/**
 * Shared finance utilities (ESM)
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YahooFinance from 'yahoo-finance2';
import { NIFTY_50, NIFTY_100, FNO_STOCKS, ALL_OPTION_STOCKS } from '../../constant/nseStocks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// v3: must instantiate before use
const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical'] });

export const STOCK_LISTS_DIR = path.join(__dirname, '..', '..', '..', 'stock_lists');

// ── Period string → Date ────────────────────────────────────────────────────
export function periodToDate(period) {
  const m = period.match(/^(\d+)(d|mo|y)$/);
  if (!m) throw new Error(`Unknown period: ${period}`);
  const n = parseInt(m[1], 10);
  const d = new Date();
  if (m[2] === 'd')  d.setDate(d.getDate() - n);
  if (m[2] === 'mo') d.setMonth(d.getMonth() - n);
  if (m[2] === 'y')  d.setFullYear(d.getFullYear() - n);
  return d;
}

// ── Single symbol OHLCV download  (uses chart() — historical is deprecated in v3) ──
export async function downloadOHLC(symbol, period = '1y', interval = '1d') {
  const ticker = (symbol.includes('.') || symbol.startsWith('^')) ? symbol : `${symbol}.NS`;
  try {
    const result = await yahooFinance.chart(ticker, {
      period1:  periodToDate(period),
      period2:  new Date(),
      interval,
    });
    const quotes = result?.quotes;
    if (!quotes || quotes.length < 5) return null;
    return quotes
      .map(d => ({
        date:   d.date,
        open:   d.open,
        high:   d.high,
        low:    d.low,
        close:  d.adjclose ?? d.close,
        volume: d.volume ?? 0,
      }))
      .filter(d => d.close != null && d.high != null && d.low != null);
  } catch {
    return null;
  }
}

// ── Batch download with concurrency limit ───────────────────────────────────
export async function downloadBatch(symbols, period = '3mo', interval = '1d', concurrency = 20) {
  const results = {};
  for (let i = 0; i < symbols.length; i += concurrency) {
    await Promise.all(symbols.slice(i, i + concurrency).map(async sym => {
      const bars = await downloadOHLC(sym, period, interval);
      if (bars && bars.length >= 15) results[sym] = bars;
    }));
  }
  return results;
}

// ── EMA  (matches pandas ewm(span, adjust=False)) ───────────────────────────
export function calcEMA(values, span) {
  if (!values.length) return [];
  const alpha = 2 / (span + 1);
  const ema = [values[0]];
  for (let i = 1; i < values.length; i++)
    ema.push(alpha * values[i] + (1 - alpha) * ema[i - 1]);
  return ema;
}

// ── ADX ──────────────────────────────────────────────────────────────────────
export function calcADX(bars, period = 14) {
  if (bars.length < period + 5) return 0;
  const trs = [], dmp = [], dmm = [];
  for (let i = 1; i < bars.length; i++) {
    const { high: h, low: l } = bars[i], pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low  - bars[i].low;
    dmp.push(up > dn && up > 0 ? up : 0);
    dmm.push(dn > up && dn > 0 ? dn : 0);
  }
  const ewmTR = calcEMA(trs, period), ewmDMP = calcEMA(dmp, period), ewmDMM = calcEMA(dmm, period);
  const dx = ewmTR.map((atr, i) => {
    const diP = 100 * ewmDMP[i] / (atr || 1e-10), diM = 100 * ewmDMM[i] / (atr || 1e-10);
    const sum = diP + diM;
    return sum > 0 ? 100 * Math.abs(diP - diM) / sum : 0;
  });
  const adx = calcEMA(dx, period);
  return adx[adx.length - 1];
}

// ── CPR ──────────────────────────────────────────────────────────────────────
export function calcCPR(H, L, C) {
  const P = (H + L + C) / 3, BC = (H + L) / 2, TC = 2 * P - BC;
  const r2 = v => Math.round(v * 100) / 100;
  const r3 = v => Math.round(v * 1000) / 1000;
  return {
    P: r2(P), BC: r2(BC), TC: r2(TC),
    R1: r2(2*P - L),    R2: r2(P + (H - L)),  R3: r2(H + 2*(P - L)),
    S1: r2(2*P - H),    S2: r2(P - (H - L)),  S3: r2(L - 2*(H - P)),
    widthPct: r3(Math.abs(TC - BC) / P * 100),
  };
}

// ── Monthly resample ─────────────────────────────────────────────────────────
export function resampleMonthly(bars) {
  const g = {};
  for (const b of bars) {
    const k = `${b.date.getFullYear()}-${String(b.date.getMonth()+1).padStart(2,'0')}`;
    if (!g[k]) g[k] = { high: -Infinity, low: Infinity, close: 0 };
    g[k].high  = Math.max(g[k].high, b.high);
    g[k].low   = Math.min(g[k].low,  b.low);
    g[k].close = b.close;
  }
  return Object.keys(g).sort().map(k => g[k]);
}

export function getMonthlyCP(bars) {
  const m = resampleMonthly(bars);
  if (m.length < 2) return null;
  const p = m[m.length - 2];
  return calcCPR(p.high, p.low, p.close);
}

// ── Weekly resample (week ending Friday, like pandas W-FRI) ─────────────────
export function resampleWeekly(bars) {
  const g = {};
  for (const b of bars) {
    const d = new Date(b.date), day = d.getDay();
    d.setDate(d.getDate() + (day <= 5 ? 5 - day : 6));
    const k = d.toISOString().slice(0, 10);
    if (!g[k]) g[k] = { high: -Infinity, low: Infinity, close: 0 };
    g[k].high  = Math.max(g[k].high, b.high);
    g[k].low   = Math.min(g[k].low,  b.low);
    g[k].close = b.close;
  }
  return Object.keys(g).sort().map(k => g[k]);
}

export function getWeeklyCPR(bars) {
  const w = resampleWeekly(bars);
  if (w.length < 2) return null;
  const p = w[w.length - 2];
  return calcCPR(p.high, p.low, p.close);
}

// ── Monthly CPR for a specific entry date ────────────────────────────────────
export function getMonthlyCPRForDate(bars, entryDate) {
  const eY = entryDate.getFullYear(), eM = entryDate.getMonth();
  const prevYear  = eM === 0 ? eY - 1 : eY;
  const prevMonth = eM === 0 ? 12 : eM;
  const key = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
  const g = {};
  for (const b of bars) {
    const k = `${b.date.getFullYear()}-${String(b.date.getMonth()+1).padStart(2,'0')}`;
    if (!g[k]) g[k] = { high: -Infinity, low: Infinity, close: 0 };
    g[k].high  = Math.max(g[k].high, b.high);
    g[k].low   = Math.min(g[k].low,  b.low);
    g[k].close = b.close;
  }
  const row = g[key];
  if (!row) return null;
  return calcCPR(row.high, row.low, row.close);
}

// ── Trend (20-MA) ────────────────────────────────────────────────────────────
export function getTrend(bars) {
  if (bars.length < 5) return 'Unknown';
  const lb = Math.min(20, bars.length);
  const ma = bars.slice(-lb).reduce((s, b) => s + b.close, 0) / lb;
  const last = bars[bars.length - 1].close;
  return last > ma ? 'Uptrend' : last < ma ? 'Downtrend' : 'Sideways';
}

// ── CSV helpers ──────────────────────────────────────────────────────────────
export function writeCSV(filepath, rows) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(','), ...rows.map(r => headers.map(h => String(r[h] ?? '')).join(','))];
  fs.writeFileSync(filepath, lines.join('\n') + '\n', 'utf8');
}

export function readCSV(filepath) {
  if (!fs.existsSync(filepath)) return [];
  const lines = fs.readFileSync(filepath, 'utf8').trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    const row  = {};
    headers.forEach((h, i) => { row[h.trim()] = vals[i]?.trim() ?? ''; });
    return row;
  });
}

// ── Terminal colours ─────────────────────────────────────────────────────────
export const C = { reset: '\x1b[0m', bold: '\x1b[1m', green: '\x1b[92m', red: '\x1b[91m', yellow: '\x1b[93m' };

export function progress(msg) { process.stdout.write(`\r${msg.padEnd(70)}`); }
export function clearProgress() { process.stdout.write('\r' + ' '.repeat(70) + '\r'); }
