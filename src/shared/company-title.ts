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
