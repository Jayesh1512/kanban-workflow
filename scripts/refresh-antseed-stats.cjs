const fs = require('node:fs');
const path = require('node:path');
const { readStats } = require('./lib/antseed-stats.cjs');
const root = path.resolve(__dirname, '..');

async function refresh() {
  const snapshot = await readStats();
  const json = JSON.stringify(snapshot).replaceAll('<', '\\u003c');
  const client = fs.readFileSync(path.join(__dirname, 'lib/antseed-live-stats.js'), 'utf8');
  const date = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
  }).format(new Date(snapshot.fetchedAt));
  const selected = process.argv[2];
  const folders = ['antseed-creators-pitch', 'antseed-neobanks-short', 'antseed-neobank-deck'];
  if (selected && !folders.includes(selected)) throw new Error('Unknown deck');
  for (const folder of folders.filter(folder => !selected || folder === selected)) {
    const file = path.join(root, 'artifacts', folder, 'index.html');
    let html = fs.readFileSync(file, 'utf8');
    html = html.replace(/(<[\w:]+\b[^>]*data-stats-key="([^"]+)"[^>]*>)[^<]*(<\/[^>]+>)/g, (_, open, key, close) => {
      const n = snapshot.metrics[key];
      if (n === undefined) throw new Error(`Unknown metric ${key}`);
      const text = key === 'tokensBillions'
        ? (n >= 1000 ? (n / 1000).toFixed(2) + 'T+' : n.toFixed(2) + 'B+')
        : n.toLocaleString('en-US') + '+';
      return open + text + close;
    });
    html = html.replace(/(<[\w:]+\b[^>]*data-stats-status[^>]*>)[^<]*(<\/[^>]+>)/g,
      (_, open, close) => open + `Snapshot · ${date} UTC` + close);
    html = html.replace(/<script id="antseed-stats-snapshot" type="application\/json">[\s\S]*?<\/script>/g, '');
    html = html.replace(/<script id="antseed-live-stats">[\s\S]*?<\/script>/g, '');
    html = html.replace('</body>', `<script id="antseed-stats-snapshot" type="application/json">${json}</script><script id="antseed-live-stats">${client}</script></body>`);
    fs.writeFileSync(file, html);
    fs.writeFileSync(path.join(root, 'artifacts', folder, 'stats-refresh.json'), JSON.stringify(snapshot, null, 2) + '\n');
  }
  console.log(JSON.stringify({ fetchedAt: snapshot.fetchedAt, metrics: snapshot.metrics }));
}
refresh().catch(error => { console.error(error.message); process.exitCode = 1; });
