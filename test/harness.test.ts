import assert from 'node:assert/strict';
import test from 'node:test';
import { testApp } from './harness.ts';
import { attr, boardCards } from './html.ts';

test('F0 harness rejects ambiguous injected sources before product construction', async () => {
  await assert.rejects(testApp({ lines: [], recordingPath: 'synthetic' }), /one fixture source/);
  await assert.rejects(testApp({ script: [], scriptPath: 'synthetic' }), /one model source/);
  await assert.rejects(testApp({ movementReplay: [], movementReplayPath: 'synthetic' }), /one movement source/);
});

test('F0 HTML helpers read frozen board markup and escaped labels', () => {
  const markup =
    '<main id="board" data-version="7"><section class="lane" data-lane-name="Sales &amp; support"><div class="stage" data-stage-name="New"><article data-card-id="3"><h3 class="card-title">&lt;Synthetic&gt;</h3></article></div></section></main>';
  assert.deepEqual(boardCards(markup), [
    { cardId: 3, laneName: 'Sales & support', stageName: 'New', title: '<Synthetic>' },
  ]);
  assert.equal(attr(markup, 'board', 'version'), '7');
});
