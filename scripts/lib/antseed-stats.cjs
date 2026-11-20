const BASE = 'https://antseedstats.com';

function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}

// The public API omits the homepage's reserve/free participant total and
// lifetime free tokens. Read those two published KPIs without changing their
// definitions. Fail closed if the page structure changes.
function homepageValue(html, label) {
  const marker = `aria-label="About ${label}"`;
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`Missing homepage KPI: ${label}`);
  const match = html.slice(start, start + 600).match(/<div class="v"[^>]*>([\d,.]+[BMT]?)<\/div>/);
  if (!match) throw new Error(`Invalid homepage KPI: ${label}`);
  return match[1];
}

async function readStats(fetcher = fetch) {
  async function request(path, json = true) {
    const response = await fetcher(BASE + path, {
      signal: AbortSignal.timeout(12000),
      headers: { Accept: json ? 'application/json' : 'text/html' }
    });
    if (!response.ok) throw new Error(`AntSeedStats returned ${response.status}`);
    return json ? response.json() : response.text();
  }
  const [models, summary, home] = await Promise.all([
    request('/api/v1/models?limit=1&view=all'),
    request('/api/v1/network/summary'),
    request('/', false)
  ]);
  const participants = count(Number(homepageValue(home, 'Total active users').replaceAll(',', '')), 'participants');
  const tokens = homepageValue(home, 'Tokens consumed');
  const match = tokens.match(/^([\d,.]+)([BMT])$/);
  if (!match) throw new Error('Invalid token unit');
  const tokensBillions = Number(match[1].replaceAll(',', '')) * ({ M: 0.001, B: 1, T: 1000 }[match[2]]);
  if (!Number.isFinite(tokensBillions) || tokensBillions <= 0) throw new Error('Invalid tokens');
  return {
    version: 1,
    fetchedAt: new Date().toISOString(),
    metrics: {
      models: count(models.data?.total, 'models'),
      providers: count(summary.data?.lifetime?.sellers, 'providers'),
      participants,
      tokensBillions
    },
    source: BASE + '/',
    license: 'CC BY 4.0',
    meta: {
      models: models.meta,
      providers: summary.meta,
      homepageUpdated: home.match(/class="updated-stamp">Updated ([\d:]+)/)?.[1] || null,
      definitions: {
        models: 'Canonical models, all sellers; API /models data.total.',
        providers: 'Lifetime sellers with settled trades; API /network/summary data.lifetime.sellers.',
        participants: 'Homepage total: reserve/free buyers, settling sellers and DIEM stakers. Roles can overlap.',
        tokensBillions: 'Homepage lifetime paid and free tokens, in billions, at its published precision.'
      }
    }
  };
}

module.exports = { readStats, homepageValue };
