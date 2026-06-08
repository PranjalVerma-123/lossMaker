import { downloadBatch, calcEMA } from '../services/yFinance/index.js';

const syms = ['ACE','BLS','CHOICEIN','ELECON','GRAVITA','OLECTRA','TARIL','TBOTEK'];
const data = await downloadBatch(syms, '2y', '1d', 8);

for (const sym of syms) {
  const bars = data[sym];
  if (!bars) { console.log(sym, '- NO DATA'); continue; }
  const closes  = bars.map(b => b.close);
  const ema50   = calcEMA(closes, 50);
  const ema200  = calcEMA(closes, 200);
  const n       = bars.length - 1;
  const close   = bars[n].close;
  const e50     = ema50[n], e200 = ema200[n], e200_20 = ema200[n - 20];
  const hi52    = Math.max(...bars.slice(-252).map(b => b.high));
  const lo52    = Math.min(...bars.slice(-252).map(b => b.low));
  const fromH   = ((hi52 - close) / hi52 * 100).toFixed(1);
  const fromL   = ((close - lo52) / lo52  * 100).toFixed(1);

  const pass = close > e50 && e50 > e200 && e200 > e200_20 && fromH <= 15 && fromL >= 30;
  console.log(
    sym.padEnd(12),
    'bars:', bars.length,
    '| close>', String(close > e50 ? 'ema50 YES' : 'ema50 NO').padEnd(12),
    '| ema50>ema200:', e50 > e200 ? 'YES' : 'NO',
    '| 200rising:', e200 > e200_20 ? 'YES' : 'NO',
    '| from52H:', fromH + '%',
    '| from52L:', fromL + '%',
    '| PASS:', pass ? 'YES' : 'NO'
  );
}
