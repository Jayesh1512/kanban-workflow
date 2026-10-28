(() => {
  'use strict';
  const id = 'antseed-kpis';
  let status = null;
  let pathname = '';
  let resize = null;

  function metric(card) {
    const article = document.createElement('article');
    article.className = 'antseed-kpis__card';
    article.dataset.metric = card[0];
    const value = document.createElement('strong');
    value.className = 'antseed-kpis__value';
    value.textContent = String(Number(status?.kpis?.[card[0]] || 0));
    const label = document.createElement('span');
    label.className = 'antseed-kpis__label';
    label.textContent = card[1];
    const detail = document.createElement('span');
    detail.className = 'antseed-kpis__detail';
    detail.textContent = typeof card[2] === 'function' ? card[2]() : card[2];
    article.append(value, label, detail);
    return article;
  }

  function remove() {
    resize?.disconnect();
    resize = null;
    document.getElementById(id)?.remove();
    document.body?.classList.remove('antseed-kpis-active');
    document.body?.style.removeProperty('--antseed-kpis-height');
  }

  function isOutreachProject() {
    const match = location.pathname.match(/^\/projects\/(\d+)(?:\/|$)/);
    return Boolean(match && status?.project_id && match[1] === String(status.project_id));
  }

  function render() {
    if (!document.body || !isOutreachProject()) { remove(); return; }
    remove();
    const root = document.createElement('section');
    root.id = id;
    root.setAttribute('aria-label', 'AntSeed CRM pipeline KPIs');
    root.setAttribute('aria-live', 'polite');
    const head = document.createElement('div');
    head.className = 'antseed-kpis__head';
    const title = document.createElement('strong');
    title.textContent = 'AntSeed CRM overview';
    const source = document.createElement('span');
    source.textContent = 'Live · Telegram-approved sources only';
    head.append(title, source);
    const grid = document.createElement('div');
    grid.className = 'antseed-kpis__grid';
    const kpis = status.kpis || {};
    const cards = [
      ['companiesInTalks', 'Companies in talks', () => `${Number(kpis.contactProspects || 0)} company-unknown prospects`],
      ['activeConversations', 'Approved conversations', () => `${Number(kpis.awaitingPlacement || 0)} awaiting placement`],
      ['activeOpportunities', 'Active opportunities', 'Qualification or negotiation'],
      ['followUpsDue', 'Follow-ups due', 'Due today or overdue'],
      ['pendingApprovals', 'Pending approvals', 'CRM stage decisions'],
      ['dealsWon', 'Deals won', 'Accepted outcomes'],
    ];
    for (const card of cards) grid.append(metric(card));
    root.append(head, grid);
    document.body.prepend(root);
    document.body.classList.add('antseed-kpis-active');
    const size = () => document.body.style.setProperty('--antseed-kpis-height', `${root.getBoundingClientRect().height}px`);
    size();
    resize = new ResizeObserver(size);
    resize.observe(root);
  }

  async function refresh() {
    try {
      const response = await fetch('/_antseed/kpis', { cache: 'no-store', headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('KPI status unavailable');
      status = await response.json();
      render();
    } catch {
      if (!status) remove();
    }
  }

  function route() {
    if (pathname === location.pathname) return;
    pathname = location.pathname;
    render();
  }

  const observer = new MutationObserver(route);
  const start = () => {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    pathname = location.pathname;
    void refresh();
    setInterval(() => { route(); void refresh(); }, 30_000);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
