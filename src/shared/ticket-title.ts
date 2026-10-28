const oneLine = (value: string) => value.replace(/\s+/gu, ' ').trim();

const shorten = (value: string, limit: number, fallback: string) => {
  const clean = oneLine(value) || fallback;
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1).trimEnd()}…`;
};

export interface TicketTitleParts {
  identity: string;
  description: string;
  nextAction: string;
  eta: string;
}

/**
 * One canonical Vikunja title for work-board and CRM cards.
 * Values remain plain text; the richer evidence and precision stay in the body.
 */
export function ticketTitle(parts: TicketTitleParts): string {
  const identity = shorten(parts.identity, 100, 'Unnamed prospect');
  const description = shorten(parts.description, 120, 'Relationship context not recorded');
  const nextAction = shorten(parts.nextAction, 140, 'Confirm next step');
  const eta = shorten(parts.eta, 60, 'Not set');
  return `${identity}: ${description} · Next: ${nextAction} · ETA: ${eta}`;
}
