import type { Ctx, Id } from '../contracts/index.ts';
import { record } from '../log/index.ts';

/** Clear derived current fields using their producing-input support, before message deletion.
 * Human values stay protected. Historical payloads are redacted by the purge coordinator. */
export function forgetWorkflowFields(ctx: Ctx, messageIds: Id[], chatId: Id): Id[] {
  const affected = new Set<Id>();
  const columns: Record<string, string> = {
    workstream: 'workstream',
    nextAction: 'next_action',
    followUpAt: 'follow_up_at',
    blockedReason: 'blocked_reason',
    buyerId: 'buyer_id',
  };
  for (const source of ctx.db.all<{
    card_id: Id;
    field: string;
    source_message_ids: string;
    source_chat_ids: string;
    source_unknown: number;
  }>('SELECT * FROM workflow_field_source WHERE human=0')) {
    const messages = JSON.parse(source.source_message_ids) as Id[],
      chats = JSON.parse(source.source_chat_ids) as Id[];
    if (!source.source_unknown && !messages.some((id) => messageIds.includes(id)) && !chats.includes(chatId)) continue;
    if (source.field === 'stage') {
      const target = ctx.db.get<{ stage_id: Id; lane_id: Id }>(
        "SELECT w.stage_id,s.lane_id FROM workflow_stage w JOIN stage s ON s.id=w.stage_id JOIN workflow_config c ON c.lane_id=s.lane_id WHERE w.key='to_be_started' AND s.removed_at IS NULL",
      );
      // An obsolete row is not ownership of a later human or generic placement.
      // Native placement logs survive payload redaction, and their order also
      // distinguishes human moves at the same timestamp from generated moves.
      if (target)
        ctx.db.run(
          `UPDATE card SET stage_id=? WHERE id=? AND lane_id=?
           AND EXISTS (SELECT 1 FROM workflow_stage w JOIN stage s ON s.id=w.stage_id WHERE s.id=card.stage_id AND s.lane_id=card.lane_id AND s.removed_at IS NULL)
           AND (SELECT actor_kind FROM action_log WHERE subject_kind='card' AND subject_id=card.id AND action IN ('card.create','card.move') ORDER BY id DESC LIMIT 1)='agent'
           AND NOT EXISTS (SELECT 1 FROM workflow_field_source WHERE card_id=card.id AND field='stage' AND human=1)`,
          target.stage_id,
          source.card_id,
          target.lane_id,
        );
    } else if (columns[source.field])
      ctx.db.run(
        `UPDATE workflow_ticket SET ${columns[source.field]}=? WHERE card_id=?`,
        source.field === 'workstream' ? 'others' : null,
        source.card_id,
      );
    ctx.db.run(
      'DELETE FROM workflow_field_source WHERE card_id=? AND field=? AND human=0',
      source.card_id,
      source.field,
    );
    affected.add(source.card_id);
  }
  for (const id of affected)
    record(ctx, {
      action: 'workflow.erased',
      subjectKind: 'card',
      subjectId: id,
      after: { derivedFieldsCleared: true },
      messageIds,
    });
  return [...affected];
}
