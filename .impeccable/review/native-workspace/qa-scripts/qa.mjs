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

// ---- manager
{
  const { ctx, page, errors } = await session('manager@example.com');
  await page.goto(base + '/approvals'); await page.waitForSelector('#queue-tabs button');
  await page.waitForFunction(() => !document.querySelector('#queue .skeleton'));
  const tabs = await page.$$eval('#queue-tabs button', b => b.map(x => x.textContent));
  check('manager sees Initial placement, CRM changes, Work; not Chat intake', tabs.length === 3 && !tabs.some(t => t.startsWith('Chat intake')), tabs.join(' | '));
  check('manager nav shows Approvals, not Access', await page.$eval('#approvals-link', e => !e.hidden) && await page.$eval('#access-link', e => e.hidden));
  check('manager: intake API forbidden', await status(ctx, '/api/board/approvals/intake') === 403);
  await page.screenshot({ path: out + 'desktop-approvals-placement.png' });
  // AI suggestion inline on a placement card
  const aiName = await page.$eval('#queue .task:has(.badge.warn:text("AI suggestion pending")) h3', e => e.textContent);
  await page.click(`#queue summary:has(h3:text-is("${aiName}"))`);
  await page.waitForSelector('.task[open] .proposal-note');
  check('placement card shows AI suggestion as pending, not applied', (await page.$eval('.task[open] .proposal-note', e => e.innerText)).includes('Pending approval · not applied'));
  await page.screenshot({ path: out + 'desktop-approvals-suggestion.png' });
  await page.click('.task[open] button:has-text("Approve")'); await page.waitForSelector(`.done:has-text("${aiName}")`, { timeout: 8000 }).catch(async () => { console.log('DEBUG', aiName, await page.$eval('#queue', e => e.innerText.slice(0, 500)), await page.$eval('#notice', e => e.textContent)); throw Error('approve failed'); });
  // CRM changes: evidence before approve
  await page.click('#queue-tabs button:has-text("CRM changes")');
  await page.click('#queue .task >> nth=0 >> summary');
  await page.waitForSelector('.task[open] .source, .task[open] :text("source context")');
  check('CRM change card offers source context before the decision buttons', await page.$eval('.task[open]', e => { const ctx = e.querySelector('.source,h4.group'), btn = e.querySelector('.decide button'); return !!ctx && !!(ctx.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING); }));
  await page.screenshot({ path: out + 'desktop-approvals-changes.png' });
  await page.click('.task[open] button:has-text("Approve")'); await page.waitForSelector('.done');
  // 409 path: decide elsewhere, then use stale card
  await page.click('#queue-tabs button:has-text("CRM changes")');
  const stale = await page.$('#queue .task summary');
  if (stale) {
    await stale.click();
    const id = await page.evaluate(() => tabItems('changes')[0].id);
    await ctx.request.post(base + `/api/board/approvals/proposals/${id}/decision`, { headers: { origin: base }, data: { action: 'reject', reason: 'Decided elsewhere', idempotencyKey: 'x-' + Date.now() } });
    await page.click('.task[open] button:has-text("Approve")');
    await page.waitForFunction(() => document.getElementById('notice').dataset.error === 'true', null, { timeout: 8000 }).catch(async () => { console.log('DEBUG409', await page.$eval('#queue', e => e.innerText.slice(0, 400)), '|', await page.$eval('#notice', e => e.textContent)); });
    check('stale decision shows an explicit conflict message and refreshes the list', (await page.$eval('#notice', e => e.textContent)).includes('refreshed'), await page.$eval('#notice', e => e.textContent));
  }
  // Work
  await page.click('#queue-tabs button:has-text("Work")');
  await page.click('#queue .task >> nth=0 >> summary');
  await page.click('.task[open] button:has-text("Approve")'); await page.waitForSelector('.done');
  check('Work approval says queued, not moved', (await page.$eval('.done', e => e.textContent)).includes('Queued'));
  await page.click('#queue-tabs button:has-text("Initial placement")');
  // placement card with evidence
  const unplacedNames = (await (await ctx.request.get(base + '/api/board/approvals/placements')).json()).items.map(r => r.displayName);
  const target = await page.$eval('#queue .task:not(:has(.badge.warn:text("AI suggestion pending"))) h3', e => e.textContent);
  await page.click(`#queue summary:has(h3:text-is("${target}"))`);
  await page.waitForSelector('.task[open] .source');
  check('initial-placement card loads source context', await page.$$eval('.task[open] .source', e => e.length) > 0);
  await page.selectOption('select[aria-label="Initial stage"]', 'qualification');
  await page.click('button:has-text("Place on CRM board")');
  await page.waitForSelector('.done:has-text("placed in")');
  check('manual placement lands on accepted board in the chosen stage', (await text(page)).includes(target + ' placed in Qualification'));
  const publicRel = await (await ctx.request.get(base + '/api/outreach/relationships?limit=100')).json();
  check('placed relationship is public in Qualification', publicRel.items.some(r => r.displayName === target && r.acceptedStage === 'qualification'));
  // CRM + dashboard: no unplaced
  for (const [path, label] of [['/outreach', 'CRM'], ['/dashboard', 'dashboard']]) {
    await page.goto(base + path); await page.waitForFunction(() => document.querySelector('.column .task, .column .relationship'));
    const t = await text(page);
    check(label + ': no placement/context review sections', !/Awaiting CRM placement|placement review|Context & placement/i.test(t));
    const still = (await (await ctx.request.get(base + '/api/board/approvals/placements')).json()).items.map(r => r.displayName);
    check(label + ': no unplaced relationship shown', still.length > 0 && still.every(n => !t.includes(n)), still.join(', '));
  }
  // history label for web approvals
  await page.goto(base + '/outreach'); await page.waitForSelector('.relationship');
  await page.$eval(`.relationship:has(h3:text-is("${aiName}")) summary`, e => e.click());
  await page.waitForSelector('.relationship[open] .proposal', { timeout: 8000 }).catch(async () => { console.log('DEBUGHIST', aiName, await page.$eval('.relationship[open]', e => e.innerText.slice(0, 700))); throw Error('history missing'); });
  const hist = await page.$eval('.relationship[open] .sales-controls', e => e.innerText);
  check('web-approved proposal reads "Approved in Approvals", not Telegram/Saved immediately', hist.includes('Approved in Approvals') && !hist.includes('Saved immediately'), hist.replace(/\n+/g, ' | ').slice(0, 300));
    const limits = await page.$$eval('.relationship[open] .body > p.muted', e => e.map(x => x.textContent));
  check('native CRM detail limits copy is not Telegram-only (B2)', limits.length > 0 && !limits.some(l => /Telegram control message/i.test(l)), limits.join(' || '));
  check('no page errors (manager)', errors.length === 0, errors.join('; '));
  await ctx.close();
}
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
  await page.goto(base + '/approvals'); await page.waitForURL('**/dashboard');
  check(email + ': /approvals redirects to dashboard, no Approvals link', await page.$eval('#approvals-link', e => e.hidden));
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
writeFileSync(out + 'approvals-qa.json', JSON.stringify({ environment: 'Synthetic preview at http://localhost:19490 driven by headless Chrome for Testing (Playwright core, outside the repo)', results }, null, 2));
await browser.close();
console.log(results.filter(r => r.result !== 'pass').length ? 'SOME FAILED' : 'ALL PASSED');
