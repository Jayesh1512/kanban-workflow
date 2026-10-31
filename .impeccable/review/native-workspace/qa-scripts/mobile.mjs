import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const out = '/Users/jys/.t3/projects/kanban/.impeccable/review/native-workspace/', base = 'http://localhost:19490';
const b = await chromium.launch({ executablePath: exe }), res = [];
for (const [email, name, expected] of [['manager@example.com', 'manager', 3], ['ravi@antseed.com', 'admin', 4]]) {
  const ctx = await b.newContext({ viewport: { width: 375, height: 812 } }), page = await ctx.newPage();
  await ctx.request.post(base + '/auth/login', { data: { email, password: 'x' } });
  await page.goto(base + '/approvals'); await page.waitForFunction(() => !document.querySelector('#queue .skeleton'));
  const m = await page.evaluate(() => { const box = document.getElementById('queue-tabs'), bs = [...box.querySelectorAll('button')]; return { count: bs.length, containerScrolls: box.scrollWidth > box.clientWidth, pageOverflow: document.documentElement.scrollWidth > innerWidth, buttons: bs.map(x => ({ label: x.textContent, textClipped: x.scrollWidth > x.clientWidth + 1, width: Math.round(x.getBoundingClientRect().width), wraps: x.getBoundingClientRect().height > 50 })) }; });
  const ok = m.count === expected && m.buttons.every(x => !x.textClipped && !x.wraps) && !m.pageOverflow;
  console.log(name, ok ? 'PASS' : 'FAIL', JSON.stringify(m));
  res.push({ name: `375px ${name}: all ${expected} queue tabs legible in a scrolling row, no page overflow`, result: ok ? 'pass' : 'FAIL', detail: m });
  // reach last tab by keyboard/scroll
  await page.focus('#queue-tabs button >> nth=0'); for (let i = 1; i < expected; i++) await page.keyboard.press('Tab'); await page.waitForTimeout(600); 
  const reach = await page.evaluate(() => { const box = document.getElementById('queue-tabs'), last = box.lastElementChild, br = box.getBoundingClientRect(), lr = last.getBoundingClientRect(); return lr.right <= br.right + 1 && lr.left >= br.left - 1; });
  res.push({ name: `375px ${name}: last tab scrolls into view when focused`, result: reach ? 'pass' : 'FAIL' }); console.log(name, 'last tab visible when focused', reach);
  await page.evaluate(() => document.getElementById('queue-tabs').scrollTo(0, 0));
  await page.screenshot({ path: out + `mobile-approvals-375-${name}.png` });
  await ctx.close();
}
writeFileSync(out + 'approvals-mobile-tabs.json', JSON.stringify(res, null, 2));
await b.close();
