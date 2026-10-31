/** Explicit two-party group naming convention; this is company metadata only,
 * never evidence of a person's employment, a date, agreement or workflow stage. */
export function companyFromGroupTitle(kind: string, title: string): string | null {
  if (!['group', 'supergroup'].includes(kind)) return null;
  const parts = title.trim().split(/\s*(?:<\s*>|<->|↔)\s*/);
  if (parts.length !== 2) return null;
  const names = parts.map(p => p.trim().replace(/\s+/g, ' '));
  const own = names.map(p => /^antseed$/i.test(p));
  if (own.filter(Boolean).length !== 1) return null;
  const name = names[own[0] ? 1 : 0]!;
  if (!name || name.length > 160 || /[<>\r\n]|https?:\/\/|\s[+&/]\s/.test(name)
    || /^(team|support|community|group|test|testing|unknown)$/i.test(name)) return null;
  return name;
}

export function companyCardTitle(company: { canonicalName: string; aliases: string[] } | null, chat: { kind: string; title: string }): string {
  if (!company) return `${chat.title} — company unknown`;
  const partner = companyFromGroupTitle(chat.kind, chat.title);
  return partner && [company.canonicalName,...company.aliases].some(name=>name.toLowerCase()===partner.toLowerCase())
    ? company.canonicalName : `${company.canonicalName} — ${chat.title}`;
}

const norm = (value: string) => ` ${value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const ours = /\bant\s?seed\b/i;

/** Drops our own side of a chat title ("Javi Antseed <> Loops (India community)" → "Loops (India community)"). */
export function partnerFromChatTitle(raw: string): string {
  const title = raw.trim().replace(/\s+/g, ' ');
  if (!ours.test(title)) return title;
  const parts = title.split(/\s*(?:<\s*>|<->|↔)\s*|\s+[-–—|x×/]\s+|\s*[-–—]\s+|\s+[-–—]\s*/i).map(p => p.trim()).filter(Boolean);
  const kept = parts.filter(p => !ours.test(p));
  const name = (kept.length ? kept : parts.map(p => p.replace(new RegExp(ours, 'gi'), ''))).join(' · ').replace(/\s+/g, ' ').trim();
  return name || title;
}

/**
 * Display name for a prospect with no confirmed company: the one known company it names,
 * else the chat title without our own side. Never used once a human has corrected the identity.
 */
export function prospectDisplayName(raw: string, companies: { canonicalName: string; aliases: string[] }[]): string {
  const name = partnerFromChatTitle(raw), haystack = norm(name);
  const hits = companies.filter(c => [c.canonicalName, ...c.aliases].some(n => norm(n).trim().length >= 3 && haystack.includes(norm(n))));
  return hits.length === 1 ? hits[0]!.canonicalName : name;
}
