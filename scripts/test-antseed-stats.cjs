const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readStats } = require('./lib/antseed-stats.cjs');

function source({ participants = '29,710', tokens = '954.88B', providers = 280, html } = {}) {
  return async url => ({
    ok: true,
    json: async () => url.includes('/models?')
      ? { data: { total: 968 }, meta: { as_of_ts: 1795004105 } }
      : { data: { lifetime: { sellers: providers, buyers: 1749, tokens_in: 621e9 } }, meta: { as_of_ts: 1795004105 } },
    text: async () => html ?? `<button aria-label="About Total active users">i</button></span></div><div class="v">${participants}</div>
      <button aria-label="About Tokens consumed">i</button></span></div><div class="v">${tokens}</div>`
  });
}

test('keep the homepage participant and paid/free token definitions', async () => {
  const result = await readStats(source());
  assert.deepEqual(result.metrics, { models: 968, providers: 280, participants: 29710, tokensBillions: 954.88 });
  assert.equal(result.license, 'CC BY 4.0');
  assert(Number.isFinite(Date.parse(result.fetchedAt)));
});

test('handle token totals above one trillion', async () => {
  const result = await readStats(source({ tokens: '1.25T' }));
  assert.equal(result.metrics.tokensBillions, 1250);
});

test('reject missing page fields and null API counts', async () => {
  await assert.rejects(readStats(source({ html: '<html>New layout</html>' })), /Missing homepage KPI/);
  await assert.rejects(readStats(source({ providers: null })), /Invalid providers/);
});

test('reject a failed upstream instead of publishing a partial update', async () => {
  await assert.rejects(readStats(async () => ({ ok: false, status: 429 })), /429/);
  await assert.rejects(readStats(async () => { throw new Error('Request timed out'); }), /timed out/);
});
