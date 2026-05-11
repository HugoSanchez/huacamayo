import 'dotenv/config';
import { desc } from 'drizzle-orm';
import { getDb } from '../src/db/client.ts';
import { inferenceRequests } from '../src/db/schema.ts';

const db = getDb(process.env.DATABASE_URL!);
const rows = await db.select().from(inferenceRequests).orderBy(desc(inferenceRequests.requestStartedAt)).limit(5);
for (const row of rows) {
  console.log(`[${row.status.padEnd(9)}] ${row.id} model=${row.model} in=${row.inputTokens ?? '-'} out=${row.outputTokens ?? '-'} cost=${row.estimatedCostUsd ?? '-'} provReq=${row.providerRequestId ?? '-'}`);
}
