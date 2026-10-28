import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Vikunja CRM KPI dashboard layer', () => {
  it('injects a same-origin, read-only KPI surface without creating native tasks', async () => {
    const [dockerfile, nginx, script, start] = await Promise.all([
      readFile(new URL('../../deploy/vikunja/Dockerfile', import.meta.url), 'utf8'),
      readFile(new URL('../../deploy/vikunja/nginx.conf', import.meta.url), 'utf8'),
      readFile(new URL('../../deploy/vikunja/antseed-kpis.js', import.meta.url), 'utf8'),
      readFile(new URL('../../deploy/vikunja/start.sh', import.meta.url), 'utf8'),
    ]);
    expect(dockerfile).toContain('apk add --no-cache nginx');
    expect(start).toContain('VIKUNJA_SERVICE_INTERFACE=127.0.0.1:3457');
    expect(nginx).toContain('proxy_pass $backend/api/outreach/status');
    expect(nginx).toContain('sub_filter');
    expect(script).toContain("fetch('/_antseed/kpis'");
    expect(script).toContain("location.pathname.match(/^\\/projects\\/(\\d+)");
    expect(script).not.toMatch(/method\s*:\s*['\"](?:POST|PUT|PATCH|DELETE)/);
    expect(script).not.toContain('/api/v2/tasks');
    for (const metric of ['companiesInTalks', 'activeConversations', 'activeOpportunities', 'followUpsDue', 'pendingApprovals', 'dealsWon']) expect(script).toContain(metric);
  });
});
