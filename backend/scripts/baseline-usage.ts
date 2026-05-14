/**
 * Print a baseline of recent inference cost / token usage so we have a
 * concrete "before" number to compare against once optimisations land.
 *
 * Reads DATABASE_URL from backend/.env (via dotenv/config in the imported
 * config module). Run with:
 *
 *   npx tsx scripts/baseline-usage.ts
 *   npx tsx scripts/baseline-usage.ts --hours 6
 *
 * Aggregates the last N hours of `inference_requests` rows and reports
 * total cost, average cost per completed call, cache-hit ratio, and the
 * top-spending requests so we can see what's actually driving spend.
 */

import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const HOURS = (() => {
  const raw = process.argv.find((arg) => arg.startsWith('--hours='))?.slice('--hours='.length)
    ?? process.argv[process.argv.indexOf('--hours') + 1];
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 1;
})();

const DATABASE_URL = process.env.DATABASE_URL?.trim();
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

async function main(): Promise<void> {
  console.log(`Baseline window: last ${HOURS} hour(s)`);

  // Overall aggregates by model.
  const byModel = await sql`
    SELECT
      model,
      status,
      COUNT(*) AS calls,
      COALESCE(SUM(NULLIF(input_tokens, '')::numeric), 0) AS input_tokens,
      COALESCE(SUM(NULLIF(output_tokens, '')::numeric), 0) AS output_tokens,
      COALESCE(SUM(NULLIF(cached_tokens, '')::numeric), 0) AS cached_tokens,
      COALESCE(SUM(NULLIF(reasoning_tokens, '')::numeric), 0) AS reasoning_tokens,
      COALESCE(SUM(NULLIF(estimated_cost_usd, '')::numeric), 0) AS total_cost_usd
    FROM inference_requests
    WHERE request_started_at >= NOW() - (${HOURS} || ' hours')::interval
    GROUP BY model, status
    ORDER BY total_cost_usd DESC NULLS LAST, calls DESC
  ` as Array<{
    model: string;
    status: string;
    calls: string;
    input_tokens: string;
    output_tokens: string;
    cached_tokens: string;
    reasoning_tokens: string;
    total_cost_usd: string;
  }>;

  if (byModel.length === 0) {
    console.log('(no inference requests in this window)');
  } else {
    console.log('\nBy model + status:');
    console.log(
      pad('model', 38),
      pad('status', 10),
      pad('calls', 6),
      pad('input', 10),
      pad('cached', 10),
      pad('output', 10),
      pad('reasoning', 11),
      pad('cost_usd', 10),
    );
    for (const row of byModel) {
      console.log(
        pad(row.model ?? '(null)', 38),
        pad(row.status, 10),
        pad(row.calls, 6),
        pad(row.input_tokens, 10),
        pad(row.cached_tokens, 10),
        pad(row.output_tokens, 10),
        pad(row.reasoning_tokens, 11),
        pad(`$${Number(row.total_cost_usd).toFixed(4)}`, 10),
      );
    }
  }

  // Rolled-up: completed rows only, with derived per-call averages + cache hit ratio.
  const completed = await sql`
    SELECT
      COUNT(*) AS calls,
      COALESCE(SUM(NULLIF(input_tokens, '')::numeric), 0) AS input_tokens,
      COALESCE(SUM(NULLIF(output_tokens, '')::numeric), 0) AS output_tokens,
      COALESCE(SUM(NULLIF(cached_tokens, '')::numeric), 0) AS cached_tokens,
      COALESCE(SUM(NULLIF(reasoning_tokens, '')::numeric), 0) AS reasoning_tokens,
      COALESCE(SUM(NULLIF(estimated_cost_usd, '')::numeric), 0) AS total_cost_usd
    FROM inference_requests
    WHERE status = 'completed'
      AND request_started_at >= NOW() - (${HOURS} || ' hours')::interval
  ` as Array<{
    calls: string;
    input_tokens: string;
    output_tokens: string;
    cached_tokens: string;
    reasoning_tokens: string;
    total_cost_usd: string;
  }>;

  if (completed[0] && Number(completed[0].calls) > 0) {
    const row = completed[0];
    const calls = Number(row.calls);
    const input = Number(row.input_tokens);
    const cached = Number(row.cached_tokens);
    const totalCost = Number(row.total_cost_usd);
    console.log('\nCompleted rollup:');
    console.log(`  calls          = ${calls}`);
    console.log(`  total cost     = $${totalCost.toFixed(4)}`);
    console.log(`  avg / call     = $${(totalCost / calls).toFixed(4)}`);
    console.log(`  cache-hit %    = ${input > 0 ? ((cached / input) * 100).toFixed(1) + '%' : 'n/a'} (cached/${cached.toLocaleString()} of ${input.toLocaleString()} input)`);
    console.log(`  output / call  = ${Math.round(Number(row.output_tokens) / calls).toLocaleString()} tokens`);
    console.log(`  reasoning total= ${Number(row.reasoning_tokens).toLocaleString()} tokens`);
  }

  // Top-spend requests so we can spot outliers.
  const top = await sql`
    SELECT
      id,
      model,
      status,
      request_started_at,
      input_tokens,
      output_tokens,
      cached_tokens,
      reasoning_tokens,
      estimated_cost_usd,
      provider_request_id
    FROM inference_requests
    WHERE request_started_at >= NOW() - (${HOURS} || ' hours')::interval
      AND estimated_cost_usd IS NOT NULL
    ORDER BY NULLIF(estimated_cost_usd, '')::numeric DESC NULLS LAST
    LIMIT 10
  ` as Array<Record<string, string | null>>;

  if (top.length > 0) {
    console.log('\nTop 10 by cost:');
    console.log(
      pad('started_at', 25),
      pad('status', 10),
      pad('cost', 9),
      pad('input', 8),
      pad('cached', 8),
      pad('output', 8),
      pad('reasoning', 9),
      'model',
    );
    for (const row of top) {
      const cost = Number(row.estimated_cost_usd ?? 0);
      console.log(
        pad(String(row.request_started_at ?? ''), 25),
        pad(row.status ?? '', 10),
        pad(`$${cost.toFixed(4)}`, 9),
        pad(row.input_tokens ?? '0', 8),
        pad(row.cached_tokens ?? '0', 8),
        pad(row.output_tokens ?? '0', 8),
        pad(row.reasoning_tokens ?? '0', 9),
        row.model ?? '',
      );
    }
  }
}

function pad(value: string, width: number): string {
  const s = String(value ?? '');
  return s.length >= width ? s.slice(0, width - 1) + '…' : s + ' '.repeat(width - s.length);
}

main().catch((err) => {
  console.error('baseline-usage failed:', err);
  process.exit(1);
});
