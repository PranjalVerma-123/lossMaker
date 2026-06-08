// Batch variant: calls fetchForecast per symbol in parallel, returns { symbol → data|null }
export async function fetchForecastBatch(symbols, asset_type) {
  const entries = await Promise.all(
    symbols.map(async sym => [sym, await fetchForecast(sym, asset_type)])
  );
  return Object.fromEntries(entries);
}

export async function fetchForecast(symbol, asset_type) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch('http://localhost:8000/forecast', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, asset_type, pred_len: 22, sample_count: 5 }),
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