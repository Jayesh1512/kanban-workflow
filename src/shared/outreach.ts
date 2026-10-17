import type { Message, OutreachContext } from './domain.js';

/** Sender identity, not prose or forwarding headers, determines conversation direction. */
export function outreachContext(messages: Message[], selfId?: string): OutreachContext {
  const own = messages.filter(m => !m.deletedAt && !m.forward.isForwarded && m.senderId && m.sender.kind === 'user' && m.text.trim()).sort((a,b) => Date.parse(a.sentAt) - Date.parse(b.sentAt) || a.id - b.id);
  const outgoing = selfId ? own.filter(m => m.senderId === selfId) : [];
  const incoming = selfId ? own.filter(m => m.senderId !== selfId) : [];
  const lastOutgoing = outgoing.at(-1), lastIncoming = incoming.at(-1);
  return { accountSelfId: selfId ?? null, coverage: 'captured_messages', initiatedBy: !selfId || !own.length ? 'unknown' : own[0]!.senderId === selfId ? 'antseed' : 'other', lastOutgoingAt: lastOutgoing?.sentAt ?? null, lastIncomingAt: lastIncoming?.sentAt ?? null,
    waitingForReply: !!lastOutgoing && (!lastIncoming || Date.parse(lastOutgoing.sentAt) > Date.parse(lastIncoming.sentAt) || (Date.parse(lastOutgoing.sentAt) === Date.parse(lastIncoming.sentAt) && lastOutgoing.id > lastIncoming.id)) };
}
