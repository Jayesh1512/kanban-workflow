import { chromium } from 'playwright-core';
import { writeFileSync, mkdirSync } from 'node:fs';
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const out = '/Users/jys/.t3/projects/kanban/.impeccable/review/native-workspace/';
const base = 'http://localhost:19490';
const browser = await chromium.launch({ executablePath: exe });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, result: ok ? 'pass' : 'FAIL', detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail); };
async function session(email, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport }), page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const r = await ctx.request.post(base + '/auth/login', { data: { email, password: 'synthetic-password' } });
  if (!r.ok()) throw Error('login failed ' + email);
  return { ctx, page, errors };
}
const status = (ctx, path) => ctx.request.get(base + path).then(r => r.status());
const text = page => page.evaluate(() => document.body.innerText);

// ---- admin intake
{
  const { ctx, page, errors } = await session('ravi@antseed.com');
  await page.goto(base + '/approvals'); await page.waitForFunction(() => document.querySelectorAll('#queue-tabs button').length === 4);
  await page.click('#queue-tabs button:has-text("Chat intake")');
  await page.click('#queue .task >> nth=0 >> summary');
  await page.screenshot({ path: out + 'desktop-approvals-intake.png' });
  await page.click('.task[open] button:has-text("Reject")'); await page.waitForSelector('.done');
  check('admin can reject a chat intake request', (await page.$eval('.done', e => e.textContent)).startsWith('Rejected'));
  check('no page errors (admin)', errors.length === 0, errors.join('; '));
  await ctx.close();
}
// ---- member, viewer
for (const email of ['member@example.com', 'viewer@example.com']) {
  const { ctx, page, errors } = await session(email);
  check(email + ': /approvals page is forbidden (403)', await status(ctx, '/approvals') === 403);
  await page.goto(base + '/dashboard');
  check(email + ': no Approvals link in the nav', await page.$eval('#approvals-link', e => e.hidden));
  const codes = []; for (const p of ['placements', 'proposals', 'work', 'intake']) codes.push(await status(ctx, '/api/board/approvals/' + p));
  check(email + ': every approvals API is 403', codes.every(c => c === 403), codes.join(','));
  await page.waitForFunction(() => document.querySelector('.column .task'));
  const rel = await (await ctx.request.get(base + '/api/outreach/relationships?limit=100')).json();
  check(email + ': public CRM returns accepted records only', rel.items.every(r => r.acceptedStage));
  const sum = await page.$eval('#summary', e => e.innerText);
  check(email + ': dashboard hides pending approvals count', !/Pending approvals/.test(sum), sum.replace(/\n/g, ' '));
  check('no page errors (' + email + ')', errors.length === 0, errors.join('; '));
  await ctx.close();
}
// ---- mobile + keyboard
{
  const { ctx, page } = await session('manager@example.com', { width: 390, height: 844 });
  await page.goto(base + '/approvals'); await page.waitForFunction(() => !document.querySelector('#queue .skeleton'));
  await page.click('#queue .task >> nth=0 >> summary');
  check('mobile approvals: no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: out + 'mobile-approvals.png' });
  await page.goto(base + '/dashboard'); await page.waitForFunction(() => document.querySelector('.column .task'));
  check('mobile dashboard: no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await ctx.close();
  const k = await session('manager@example.com'); await k.page.goto(base + '/approvals'); await k.page.waitForFunction(() => !document.querySelector('#queue .skeleton'));
  await k.page.focus('#queue-tabs button >> nth=0'); await k.page.keyboard.press('Tab'); await k.page.keyboard.press('Enter');
  check('keyboard: tab buttons switch queues with Tab+Enter and keep focus', await k.page.$eval('#queue-tabs button[aria-pressed=true]', e => e.textContent.startsWith('CRM changes') && document.activeElement === e));
  await k.ctx.close();
}
writeFileSync(out + 'approvals-qa-gates.json', JSON.stringify({ environment: 'Synthetic preview at http://localhost:19490 driven by headless Chrome for Testing (Playwright core, outside the repo)', results }, null, 2));
await browser.close();
console.log(results.filter(r => r.result !== 'pass').length ? 'SOME FAILED' : 'ALL PASSED');
