import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDataset } from './dataset.ts';
import { prettyJson } from './json.ts';
import type { ReplayDataset } from './types.ts';

export const GENERATED_FILES = [
  'recording.jsonl',
  'setup.json',
  'script.jsonl',
  'movement.jsonl',
  'labels.json',
] as const;
export function serializeDataset(data: ReplayDataset): Record<(typeof GENERATED_FILES)[number], string> {
  const jsonl = (lines: unknown[]) => `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  const json = prettyJson;
  return {
    'recording.jsonl': jsonl(data.recording),
    'setup.json': json(data.setup),
    'script.jsonl': jsonl(data.script),
    'movement.jsonl': jsonl(data.movement),
    'labels.json': json(data.labels),
  };
}
export function generate(directory = fileURLToPath(new URL('./e1r/', import.meta.url))): ReplayDataset {
  const data = buildDataset();
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(serializeDataset(data)))
    writeFileSync(resolve(directory, name), content);
  return data;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const data = generate();
  process.stdout.write(
    `${JSON.stringify({ files: GENERATED_FILES, messages: Object.keys(data.labels.messages).length, cards: Object.keys(data.labels.cards).length, contacts: Object.keys(data.labels.contacts).length, transitions: Object.values(data.labels.cards).reduce((count, card) => count + card.transitions.length, 0), knownMentions: data.labels.mentions.filter((m) => m.known).length, unknownMentions: data.labels.mentions.filter((m) => !m.known).length, injections: data.labels.injections.length })}\n`,
  );
}
