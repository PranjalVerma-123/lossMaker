import cron from 'node-cron';
import { registerNarrowCprJobs }    from './jobs/narrowCprIndicator.js';
import { runScanner }               from './jobs/breakoutScanner.js';
import { runMTFScanner }            from './jobs/mtfScanner.js';
import { runHirenGabaniScanner }    from './jobs/hirenGabaniScanner.js';
import { runConfluenceV2Scanner }   from './jobs/confluenceV2Scanner.js';
import { runSignalTracker }         from './jobs/signalTracker.js';

const TZ = { timezone: 'Asia/Kolkata' };

export function startCronJobs() {
  registerNarrowCprJobs();

  // Signal tracker — 4:05 PM IST (after market close, before scanners)
  cron.schedule('05 16 * * 1-5', () => {
    console.log('[Cron] Running signal tracker...');
    runSignalTracker().catch(console.error);
  }, TZ);

  // Breakout scanner — 4:30 PM IST, Mon–Fri
  cron.schedule('30 16 * * 1-5', () => {
    console.log('[Cron] Running breakout scanner...');
    runScanner().catch(console.error);
  }, TZ);

  // MTF False Breakout scanner — 4:15 PM IST, Mon–Fri (paper trade signals)
  cron.schedule('15 16 * * 1-5', () => {
    console.log('[Cron] Running MTF false breakout scanner...');
    runMTFScanner().catch(console.error);
  }, TZ);

  // Hiren Gabani orderly pullback + inside bar scanner — 4:45 PM IST, Mon–Fri
  cron.schedule('45 16 * * 1-5', () => {
    console.log('[Cron] Running Hiren Gabani scanner...');
    runHirenGabaniScanner().catch(console.error);
  }, TZ);

  // Confluence V2 scanner — 5:15 PM IST, Mon–Fri
  cron.schedule('15 17 * * 1-5', () => {
    console.log('[Cron] Running Confluence V2 scanner...');
    runConfluenceV2Scanner().catch(console.error);
  }, TZ);

  console.log('[Cron] All jobs registered');
}
