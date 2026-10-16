import { lifecycleHarness } from './lifecycle-fixture.js';

// Owned test child: production app/workflow lifecycle, controlled SQL only.
const h = await lifecycleHarness({ hold: true, onEvent: (event) => process.send?.({ event }) });
process.on('message', (message) => { if (message === 'release') h.release.resolve(); });
process.once('SIGTERM', () => {
  process.send?.({ event: 'sigterm_received' });
  void h.app.close().then(async () => {
    await h.client.close(); process.send?.({ event: 'app_closed' }); process.disconnect?.();
  }, () => { process.exitCode = 1; process.disconnect?.(); });
});
process.send?.({ event: 'listening', url: h.url });
