import type { RuntimeConfig } from '../src/shared/ports.js';

/** Tests may share one captured login across isolated schemas/files. This never
 * changes upstream rate limits or production authentication. No secret output. */
export async function testVikunjaToken(config: RuntimeConfig['vikunja']): Promise<string> {
  const shared=process.env['QA_TEST_VIKUNJA_TOKEN'];
  if(shared)config.apiToken=shared;
  if(config.apiToken)return config.apiToken;
  const response=await fetch(config.baseUrl+'/api/v2/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:config.username,password:config.password}),signal:AbortSignal.timeout(8000)});
  if(response.status!==200)throw new Error(`Isolated Vikunja test login HTTP ${response.status}`);
  const body=await response.json() as {token?:unknown};if(typeof body.token!=='string'||!body.token)throw new Error('Isolated Vikunja test login returned no token');
  config.apiToken=body.token;return body.token;
}
