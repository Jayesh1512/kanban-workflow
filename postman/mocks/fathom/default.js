// Local-only contract fixture. No credentials or real recordings are used.
// Contract: https://developers.fathom.ai/api-reference/meetings/list-meetings
const http = require('http');
const fixture = require('../../../tests/meetings/fixtures/fathom-meeting.json');
http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('content-type', 'application/json');
  if (request.method !== 'GET' || url.pathname !== '/external/v1/meetings') {
    response.writeHead(501); response.end(JSON.stringify({ error: 'Endpoint outside this contract simulation' })); return;
  }
  if (request.headers['x-api-key'] !== 'synthetic-fathom-key') {
    response.writeHead(401); response.end(JSON.stringify({ error: 'Synthetic API key required' })); return;
  }
  for (const key of ['include_transcript', 'include_summary', 'include_action_items', 'include_crm_matches']) {
    if (url.searchParams.get(key) !== 'true') {
      response.writeHead(400); response.end(JSON.stringify({ error: 'Missing requested content flag: ' + key })); return;
    }
  }
  if (!url.searchParams.has('created_after') || !url.searchParams.has('created_before') || url.searchParams.has('limit')) {
    response.writeHead(400); response.end(JSON.stringify({ error: 'Expected documented creation bounds and no invented page-size parameter' })); return;
  }
  response.end(JSON.stringify({ items: [fixture], next_cursor: '', limit: 1 }));
}).listen(process.env.PORT || 19482);
