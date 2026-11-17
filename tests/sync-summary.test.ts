import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import test from 'node:test';
const source = fs.readFileSync(new URL('../app/api/cron/marelvi-sync/route.ts', import.meta.url), 'utf8');
const javascript = ts.transpile(source.replace(/^import .*;\n/gm, '').replace(/export /g, ''), {target: ts.ScriptTarget.ES2022});

async function scenario(result: any, failure?: string | null, authorization = 'Bearer synthetic-only') {
  const logs: any[] = [];
  let invoked = 0;
  const context = vm.createContext({
    Buffer, Error,
    process: {env: {CRON_SECRET: 'synthetic-only'}},
    timingSafeEqual: (a: Buffer, b: Buffer) => a.equals(b),
    NextResponse: {json: (body: any, options: any) => ({body, ...options})},
    runMarelviSync: async () => { invoked++; if (failure) throw new Error(failure); return result; },
    console: {info: (...values: any[]) => logs.push(values), error: (...values: any[]) => logs.push(values)},
  });
  vm.runInContext(javascript, context);
  const response = await context.handle({headers: {get: () => authorization}});
  return {response, logs, invoked};
}

test('logs only safe sync summary without changing handler behavior', async () => {
  const result = {status: 'completed', dryRun: false, feedCount: 2000, batchCount: 10, processedCount: 1000, matchedCount: 25, unmatchedCount: 4, ambiguousCount: 1, priceCandidates: 2, stockCandidates: 3, priceUpdated: 2, stockUpdated: 3, stockSkipped: 0, unmatchedLocationSkuCount: 4, identityMismatchCount: 0, cycleComplete: false, runId: 'DO_NOT_LOG', unmatchedSkus: ['DO_NOT_LOG'], zeroPriceSkus: ['DO_NOT_LOG'], extra: 'https://private.invalid/DO_NOT_LOG'};
  const completed = await scenario(result);
  assert.equal(completed.invoked, 1);
  assert.equal(completed.response.status, 200);
  assert.equal(completed.response.body, result, 'Existing response must remain unchanged');
  const serialized = JSON.stringify(completed.logs);
  assert.ok(!serialized.includes('DO_NOT_LOG'));
  assert.ok(!serialized.includes('synthetic-only'));
  assert.equal(completed.logs[0][1].processedCount, 1000);
  assert.equal(completed.logs[0][1].cycleComplete, false);
  assert.equal(Object.keys(completed.logs[0][1]).length, 18);
  assert.equal(completed.logs[0][1].skippedLock, false);
  assert.ok(completed.logs[0][1].durationMs >= 0);
  const busy = await scenario({status: 'busy', dryRun: true});
  assert.equal(busy.response.status, 409);
  assert.equal(busy.logs[0][1].skippedLock, true);
  const failed = await scenario(null, 'MARELVI_FEED_TIMEOUT');
  assert.equal(failed.response.status, 500);
  assert.equal(failed.logs[0][1].errorCode, 'MARELVI_FEED_TIMEOUT');
  const privateError = await scenario(null, 'https://private.invalid/DO_NOT_LOG');
  assert.equal(privateError.logs[0][1].errorCode, 'SYNC_FAILED');
  assert.ok(!JSON.stringify(privateError.logs).includes('DO_NOT_LOG'));
  const unauthorized = await scenario(result, null, 'Bearer wrong');
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.invoked, 0);
  assert.equal(unauthorized.logs.length, 0);
  console.log('PASS: summary allowlist excludes identities and secrets; response/status unchanged; failure code sanitized; unauthorized request does not sync. All operations simulated.');
});

