// Native forms and links remain usable without JavaScript. Live polling is W3.
document.querySelectorAll('[data-lane-form]').forEach((form) => {
  const rows = form.querySelector('[data-stage-rows]');
  let nextIndex = rows.children.length;
  const updateRows = () => {
    rows.querySelectorAll('.stage-editor').forEach((row, index) => {
      const name = row.querySelector('input[name^="stageName"]');
      name.closest('label').firstChild.textContent = `Stage ${index + 1} name`;
      row.querySelector('textarea[name^="stageCriteria"]').required = index > 0;
      row.querySelector('[data-remove-stage]').disabled = rows.children.length <= 2;
    });
  };
  updateRows();
  form.querySelector('[data-add-stage]').addEventListener('click', () => {
    const index = nextIndex++;
    const row = document.createElement('div');
    row.className = 'stage-editor';
    const id = document.createElement('input');
    id.type = 'hidden';
    id.name = `stageId${index}`;
    id.value = '';
    const nameLabel = document.createElement('label');
    nameLabel.textContent = `Stage ${rows.children.length + 1} name`;
    const name = document.createElement('input');
    name.name = `stageName${index}`;
    name.required = true;
    nameLabel.append(name);
    const criteriaLabel = document.createElement('label');
    criteriaLabel.textContent = 'Entry criteria';
    const criteria = document.createElement('textarea');
    criteria.name = `stageCriteria${index}`;
    criteria.rows = 2;
    criteria.required = true;
    criteriaLabel.append(criteria);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'quiet';
    remove.textContent = 'Remove stage';
    remove.setAttribute('data-remove-stage', '');
    remove.setAttribute('aria-describedby', form.querySelector('[id^="stage-minimum-"]').id);
    row.append(id, nameLabel, criteriaLabel, remove);
    rows.append(row);
    updateRows();
    name.focus();
  });
  rows.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-stage]');
    if (!button || button.disabled) return;
    button.closest('.stage-editor').remove();
    updateRows();
    form.querySelector('[data-add-stage]').focus();
  });
});

// Native disclosure stays usable without JavaScript; direct action links open it.
function revealTarget() {
  const target = document.getElementById(location.hash.slice(1));
  if (!target) return;
  for (let parent = target; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
}
window.addEventListener('hashchange', revealTarget);
revealTarget();
document.querySelectorAll('[data-open-details]').forEach((link) => {
  link.addEventListener('click', () => {
    const target = document.getElementById(link.hash.slice(1));
    if (target instanceof HTMLDetailsElement) {
      target.open = true;
      target.querySelector('input:not([type="hidden"]), select, textarea')?.focus();
    }
  });
});
const workspaceMenu = document.querySelector('.workspace-menu');
workspaceMenu?.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  workspaceMenu.open = false;
  workspaceMenu.querySelector('summary').focus();
});

// Only local titles and inclusion state are filtered; forms still submit natively.
document.querySelectorAll('[data-chat-selection]').forEach((selection) => {
  const tools = selection.querySelector('[data-chat-tools]');
  const search = selection.querySelector('[data-chat-search]');
  const results = selection.querySelector('[data-chat-results]');
  const noMatches = selection.querySelector('[data-chat-no-matches]');
  const reset = selection.querySelector('[data-chat-reset]');
  const filters = Array.from(selection.querySelectorAll('[data-chat-filter]'));
  const rows = Array.from(selection.querySelectorAll('[data-chat-row]'));
  if (!tools || !search || !results || !noMatches || !reset || !filters.length || !rows.length) return;
  let activeFilter = 'all';
  const normalize = (value) => value.normalize('NFKC').toLowerCase();
  const titles = rows.map((row) => normalize(row.querySelector('[data-chat-title]').textContent));
  const update = () => {
    const query = normalize(search.value.trim());
    let visible = 0;
    rows.forEach((row, index) => {
      const included = row.dataset.chatIncluded === 'true';
      const matchesFilter = activeFilter === 'all' || included === (activeFilter === 'included');
      row.hidden = !matchesFilter || !titles[index].includes(query);
      if (!row.hidden) visible++;
    });
    for (const button of filters) {
      button.setAttribute('aria-pressed', String(button.dataset.chatFilter === activeFilter));
    }
    results.textContent = `Showing ${visible} of ${rows.length} chats`;
    noMatches.hidden = visible !== 0;
  };
  search.addEventListener('input', update);
  filters.forEach((button) => {
    button.addEventListener('click', () => {
      activeFilter = button.dataset.chatFilter;
      update();
    });
  });
  reset.addEventListener('click', () => {
    search.value = '';
    activeFilter = 'all';
    update();
    search.focus();
  });
  update();
  tools.hidden = false;
});
