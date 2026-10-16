import { readFileSync } from 'node:fs';
import type {
  Db,
  DecideInput,
  Model,
  ModelConfig,
  ModelDecision,
  OpenAIResponsesPort,
  OpLog,
  ScriptLine,
} from '../../contracts/index.ts';
import { AppError, ScriptLineSchema } from '../../contracts/index.ts';
import { openAIModel } from './openai.ts';

export async function createModel(
  cfg: ModelConfig,
  deps: { db: Db; oplog: OpLog; scriptLines?: ScriptLine[]; openai?: OpenAIResponsesPort },
): Promise<Model> {
  if (cfg.provider === null)
    return {
      name: 'disabled',
      endpointHost: null,
      blocked: 'no_model',
      async decide() {
        throw new AppError('invalid', 'Model is disabled');
      },
    };
  if (cfg.provider === 'openai') return openAIModel({ ...cfg }, deps.db, deps.openai);
  if (
    deps.openai !== undefined ||
    (deps.scriptLines !== undefined && cfg.scriptPath !== null) ||
    (deps.scriptLines === undefined && cfg.scriptPath === null)
  )
    throw new AppError('invalid', 'Choose exactly one scripted source');
  const raw =
    deps.scriptLines ??
    readFileSync(cfg.scriptPath as string, 'utf8')
      .split('\n')
      .filter((s) => s.trim())
      .map((s) => JSON.parse(s) as unknown);
  const lines = raw.map((value) => {
    const p = ScriptLineSchema.safeParse(value);
    if (!p.success) throw new AppError('invalid', 'Invalid script line');
    return p.data;
  });
  const seen = new Set<string>();
  for (const line of lines) {
    const key = `${line.messageKey}:${line.version}`;
    if (seen.has(key)) throw new AppError('invalid', 'Duplicate script line');
    seen.add(key);
  }
  function required<T>(value: T | null | undefined): T {
    if (value === undefined || value === null) throw new AppError('invalid', 'Script label not found');
    return value;
  }
  function evidence(input: DecideInput, keys: string[]): number[] {
    return keys.map((key) =>
      required(
        deps.db.get<{ id: number }>('SELECT id FROM message WHERE chat_id=? AND message_key=?', input.chat.id, key)?.id,
      ),
    );
  }
  return {
    name: 'scripted',
    endpointHost: null,
    blocked: null,
    async decide(input, signal): Promise<unknown> {
      signal.throwIfAborted();
      const line = lines.find((l) => l.messageKey === input.message.key && l.version === input.message.version);
      if (line && 'raw' in line) return structuredClone(line.raw);
      const none: ModelDecision = {
        disposition: 'none',
        cardId: null,
        proposalId: null,
        laneId: null,
        title: null,
        summary: null,
        cardCompanyId: null,
        cardCompanyName: null,
        confidence: 1,
        reason: 'unscripted',
        move: null,
        contacts: [],
        mentions: [],
      };
      if (!line) return none;
      const d = line.decision;
      const company = (name: string | null) =>
        name === null ? null : input.companies.find((c) => c.name.toLowerCase() === name.toLowerCase());
      const card = d.card === null ? null : required(input.cards.find((c) => c.createdFromMessageKey === d.card));
      const lane = d.lane === null ? null : required(input.lanes.find((l) => l.name === d.lane));
      const stage =
        d.move === null ? null : required(input.lanes.flatMap((l) => l.stages).find((s) => s.name === d.move?.toStage));
      return {
        ...none,
        disposition: d.disposition,
        cardId: card?.id ?? null,
        proposalId:
          d.proposal === null ? null : required(input.proposals.find((p) => p.openedByMessageKey === d.proposal)).id,
        laneId: lane?.id ?? null,
        title: d.title,
        summary: d.summary,
        cardCompanyId: company(d.cardCompany)?.id ?? null,
        cardCompanyName: company(d.cardCompany) ? null : d.cardCompany,
        confidence: d.confidence,
        reason: d.reason,
        move:
          d.move === null
            ? null
            : {
                toStageId: required(stage).id,
                criterion: d.move.criterion,
                evidenceMessageIds: evidence(input, d.move.evidenceMessageKeys),
                confidence: d.move.confidence,
              },
        contacts: d.contacts.map((c) => ({
          contactId: required(input.participants.find((p) => p.userKey === c.userKey)).contactId,
          companyId: company(c.company)?.id ?? null,
          companyName: company(c.company) ? null : c.company,
          companyConfidence: c.companyConfidence,
          roleCategory: c.roleCategory,
          dealsAbout: c.dealsAbout,
          roleConfidence: c.roleConfidence,
          evidenceMessageIds: evidence(input, c.evidenceMessageKeys),
        })),
        mentions: d.mentions.map((m) => ({
          companyId: company(m.company)?.id ?? null,
          name: m.company,
          confidence: m.confidence,
        })),
      };
    },
  };
}
