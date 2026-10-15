import { z } from 'zod';
import type { Ctx, Id, ReviewProposal, SetBy } from '../contracts/index.ts';
import { AppError, IdSchema, ReviewProposalSchema } from '../contracts/index.ts';
import { record } from '../log/index.ts';
import { validate } from './helpers.ts';
import { normalizeCompanyName } from './matching.ts';

function namesCompany(ctx: Ctx, proposal: ReviewProposal, companyId: Id): boolean {
  if (proposal.kind === 'new_card' || proposal.kind === 'name_company') return proposal.companyId === companyId;
  if (proposal.kind !== 'contact_company') return false;
  if ('id' in proposal.company) return proposal.company.id === companyId;
  const norm = normalizeCompanyName(proposal.company.name);
  return Boolean(
    ctx.db.get(
      'SELECT id FROM company WHERE id=? AND name_norm=? UNION ALL SELECT company_id AS id FROM company_alias WHERE company_id=? AND alias_norm=?',
      companyId,
      norm,
      companyId,
      norm,
    ),
  );
}
function survives(ctx: Ctx, id: Id, chatId: Id): boolean {
  if (
    ctx.db.get('SELECT contact_id FROM contact_company WHERE company_id=?', id) ||
    ctx.db.get('SELECT id FROM card WHERE company_id=?', id) ||
    ctx.db.get('SELECT id FROM company_reference WHERE from_company_id=? OR to_company_id=?', id, id) ||
    ctx.db.get('SELECT id FROM evidence WHERE company_id=?', id) ||
    ctx.db.get('SELECT id FROM chat WHERE named_company_id=? AND id<>?', id, chatId)
  )
    return true;
  for (const r of ctx.db.all<{ proposal: string }>("SELECT proposal FROM review_item WHERE status='open'")) {
    const parsed = ReviewProposalSchema.safeParse(JSON.parse(r.proposal) as unknown);
    if (!parsed.success) throw new AppError('invalid', 'Invalid stored review proposal');
    if (namesCompany(ctx, parsed.data, id)) return true;
  }
  return false;
}

/** Purge coordinator first enables deferred FKs and cleans board/agent state;
 * afterward it redacts returned subjects and deletes messages/named-chat refs. */
export function forgetMessages(
  ctx: Ctx,
  i: { messageIds: Id[]; chatId: Id },
): { removedContactIds: Id[]; resetContactIds: Id[]; removedCompanyIds: Id[] } {
  validate(z.strictObject({ messageIds: z.array(IdSchema), chatId: IdSchema }), i);
  return ctx.db.tx(() => {
    const chat = ctx.db.get<{ named_company_id: Id | null; created_at: string }>(
      'SELECT named_company_id,created_at FROM chat WHERE id=?',
      i.chatId,
    );
    if (!chat) throw new AppError('not_found', 'Chat not found');
    const ids = JSON.stringify(i.messageIds);
    if (ctx.db.get('SELECT id FROM message WHERE id IN (SELECT value FROM json_each(?)) AND chat_id<>?', ids, i.chatId))
      throw new AppError('invalid', 'Purge messages belong to another chat');
    const contacts = ctx.db.all<{ id: Id; role_set_by: SetBy }>(
      'SELECT DISTINCT c.id,c.role_set_by FROM contact c JOIN identity pi ON pi.contact_id=c.id JOIN chat_participant cp ON cp.identity_id=pi.id WHERE cp.chat_id=? ORDER BY c.id',
      i.chatId,
    );
    const candidates = new Set<Id>();
    if (chat.named_company_id !== null) candidates.add(chat.named_company_id);
    for (const r of ctx.db.all<{ company_id: Id }>(
      `SELECT company_id FROM evidence WHERE message_id IN (SELECT value FROM json_each(?)) AND company_id IS NOT NULL
       UNION SELECT from_company_id FROM company_reference WHERE message_id IN (SELECT value FROM json_each(?)) AND from_company_id IS NOT NULL
       UNION SELECT to_company_id FROM company_reference WHERE message_id IN (SELECT value FROM json_each(?))`,
      ids,
      ids,
      ids,
    ))
      candidates.add(r.company_id);
    const removedContactIds: Id[] = [],
      resetContactIds: Id[] = [],
      removedCompanyIds: Id[] = [];
    ctx.db.run('DELETE FROM chat_participant WHERE chat_id=?', i.chatId);
    for (const contact of contacts) {
      const linked = ctx.db.all<{ company_id: Id; set_by: SetBy }>(
        'SELECT company_id,set_by FROM contact_company WHERE contact_id=?',
        contact.id,
      );
      if (
        !ctx.db.get(
          'SELECT cp.chat_id FROM chat_participant cp JOIN identity pi ON pi.id=cp.identity_id WHERE pi.contact_id=?',
          contact.id,
        )
      ) {
        for (const link of linked) candidates.add(link.company_id);
        ctx.db.run('DELETE FROM identity WHERE contact_id=?', contact.id);
        ctx.db.run('DELETE FROM contact_company WHERE contact_id=?', contact.id);
        ctx.db.run('DELETE FROM contact WHERE id=?', contact.id);
        removedContactIds.push(contact.id);
        record(ctx, {
          action: 'contact.retire',
          subjectKind: 'contact',
          subjectId: contact.id,
          messageIds: i.messageIds,
        });
        continue;
      }
      let reset = false;
      const roleEvidence = ctx.db.all<{ message_id: Id }>(
        "SELECT message_id FROM evidence WHERE contact_id=? AND kind='contact_role'",
        contact.id,
      );
      if (
        contact.role_set_by === 'agent' &&
        roleEvidence.length > 0 &&
        roleEvidence.every((e) => i.messageIds.includes(e.message_id))
      ) {
        ctx.db.run("UPDATE contact SET role_category='unknown',deals_about='' WHERE id=?", contact.id);
        record(ctx, {
          action: 'contact.set_role',
          subjectKind: 'contact',
          subjectId: contact.id,
          after: { category: 'unknown', dealsAbout: '' },
          messageIds: i.messageIds,
        });
        reset = true;
      }
      for (const link of linked) {
        const evidence = ctx.db.all<{ message_id: Id }>(
          "SELECT message_id FROM evidence WHERE kind='contact_company' AND contact_id=? AND company_id=?",
          contact.id,
          link.company_id,
        );
        if (
          link.set_by === 'agent' &&
          evidence.length > 0 &&
          evidence.every((e) => i.messageIds.includes(e.message_id))
        ) {
          candidates.add(link.company_id);
          ctx.db.run('DELETE FROM contact_company WHERE contact_id=? AND company_id=?', contact.id, link.company_id);
          record(ctx, {
            action: 'contact.remove_company',
            subjectKind: 'contact',
            subjectId: contact.id,
            after: { companyId: link.company_id },
            messageIds: i.messageIds,
          });
          reset = true;
        }
      }
      if (reset) resetContactIds.push(contact.id);
    }
    ctx.db.run('DELETE FROM evidence WHERE message_id IN (SELECT value FROM json_each(?))', ids);
    // Doomed references must not keep their own company alive until ingest's
    // later message cascade. Remaining references (even removal memory) survive.
    ctx.db.run('DELETE FROM company_reference WHERE message_id IN (SELECT value FROM json_each(?))', ids);
    for (const id of [...candidates].sort((a, b) => a - b)) {
      const c = ctx.db.get<{ created_by_kind: string; created_at: string }>(
        'SELECT created_by_kind,created_at FROM company WHERE id=?',
        id,
      );
      if (
        !c ||
        !(c.created_by_kind === 'agent' || (id === chat.named_company_id && c.created_at >= chat.created_at)) ||
        survives(ctx, id, i.chatId)
      )
        continue;
      ctx.db.run('DELETE FROM company_alias WHERE company_id=?', id);
      ctx.db.run('DELETE FROM company_not_same WHERE company_id=?', id);
      ctx.db.run('DELETE FROM company WHERE id=?', id);
      removedCompanyIds.push(id);
      record(ctx, {
        action: 'company.update',
        subjectKind: 'company',
        subjectId: id,
        after: { removed: true },
        messageIds: i.messageIds,
      });
    }
    return { removedContactIds, resetContactIds, removedCompanyIds };
  });
}

/** Purge-only cleanup of dependent/unknown current generated role copies, also
 * outside the selected chat. Company retention remains the normal Graph rule. */
export function resetGeneratedRoles(ctx: Ctx, contactIds: Id[], messageIds: Id[]): Id[] {
  return ctx.db.tx(() => {
    const reset: Id[] = [];
    for (const id of contactIds) {
      if (!ctx.db.get("SELECT id FROM contact WHERE id=? AND role_set_by='agent'", id)) continue;
      ctx.db.run("UPDATE contact SET role_category='unknown',deals_about='' WHERE id=?", id);
      ctx.db.run("DELETE FROM evidence WHERE contact_id=? AND kind='contact_role'", id);
      record(ctx, {
        action: 'contact.set_role',
        subjectKind: 'contact',
        subjectId: id,
        after: { category: 'unknown', dealsAbout: '' },
        messageIds,
      });
      reset.push(id);
    }
    return reset;
  });
}
