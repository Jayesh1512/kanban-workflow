(() => {
  const endpoint = 'https://antseed-creators-pitch.vercel.app/api/stats';
  const storageKey = 'antseed-stats-v1';
  const interval = 60000;
  const keys = ['models', 'providers', 'participants', 'tokensBillions'];
  const targets = [...document.querySelectorAll('[data-stats-key]')];
  if (!targets.length) return;
  let current, lastAttempt = 0, pending = false, printing = false, live = false;

  function valid(data) {
    const time = Date.parse(data?.fetchedAt);
    return data?.version === 1 && Number.isFinite(time) && time <= Date.now() + 60000 &&
      keys.every(key => typeof data.metrics?.[key] === 'number' &&
        Number.isFinite(data.metrics[key]) && data.metrics[key] >= 0) &&
      keys.slice(0, 3).every(key => Number.isSafeInteger(data.metrics[key]));
  }
  function stamp() {
    if (!current) return;
    const age = Date.now() - Date.parse(current.fetchedAt);
    const state = printing ? 'Snapshot' : live && age < 180000 ? 'Live' : 'Saved';
    const date = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
    }).format(new Date(current.fetchedAt));
    document.querySelectorAll('[data-stats-status]').forEach(node => {
      node.textContent = `${state} · ${date} UTC`;
      node.dataset.state = state.toLowerCase();
    });
  }
  function render(data) {
    current = data;
    targets.forEach(node => {
      const key = node.dataset.statsKey;
      const n = data.metrics[key];
      node.textContent = key === 'tokensBillions'
        ? (n >= 1000 ? (n / 1000).toFixed(2) + 'T+' : n.toFixed(2) + 'B+')
        : n.toLocaleString('en-US') + '+';
    });
    stamp();
  }
  try {
    const bundled = JSON.parse(document.getElementById('antseed-stats-snapshot').textContent);
    if (valid(bundled)) current = bundled;
    const cached = JSON.parse(localStorage.getItem(storageKey));
    if (valid(cached) && (!current || Date.parse(cached.fetchedAt) > Date.parse(current.fetchedAt))) current = cached;
  } catch (_) { /* Storage access can be disabled for offline files. */ }
  if (current) render(current);

  async function refresh() {
    if (navigator.onLine === false) { live = false; stamp(); return; }
    if (pending || printing || document.hidden || Date.now() - lastAttempt < interval) return;
    lastAttempt = Date.now();
    pending = true;
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(15000), credentials: 'omit' });
      if (!response.ok) throw new Error('Stats unavailable');
      const data = await response.json();
      if (!valid(data) || Date.now() - Date.parse(data.fetchedAt) > 180000) throw new Error('Stats are stale');
      if (current && Date.parse(data.fetchedAt) < Date.parse(current.fetchedAt)) throw new Error('Older stats');
      live = true;
      render(data);
      try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch (_) {}
    } catch (_) {
      live = false;
      stamp();
    } finally {
      pending = false;
    }
  }
  window.addEventListener('beforeprint', () => { printing = true; stamp(); });
  window.addEventListener('afterprint', () => { printing = false; stamp(); });
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('online', refresh);
  window.addEventListener('offline', () => { live = false; stamp(); });
  window.addEventListener('hashchange', refresh);
  setInterval(() => { stamp(); refresh(); }, interval);
  refresh();
})();
