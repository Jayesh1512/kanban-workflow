function decode(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function boardCards(html: string): { cardId: number; laneName: string; stageName: string; title: string }[] {
  const result: { cardId: number; laneName: string; stageName: string; title: string }[] = [];
  let laneName = '';
  let stageName = '';
  for (const match of html.matchAll(/<section\b[^>]*>|<div\b[^>]*>|<article\b[^>]*>[\s\S]*?<\/article>/g)) {
    const tag = match[0];
    const lane = /data-lane-name="([^"]*)"/.exec(tag);
    const stage = /data-stage-name="([^"]*)"/.exec(tag);
    if (lane) laneName = decode(lane[1] ?? '');
    if (stage) stageName = decode(stage[1] ?? '');
    if (tag.startsWith('<article')) {
      const id = /data-card-id="(\d+)"/.exec(tag);
      const title = /<h3\b[^>]*class="card-title"[^>]*>([\s\S]*?)<\/h3>/.exec(tag);
      if (!id || !title) throw new Error('Invalid board card markup');
      result.push({ cardId: Number(id[1]), laneName, stageName, title: decode(title[1] ?? '') });
    }
  }
  return result;
}
export function attr(html: string, selectorId: string, name: string): string | null {
  for (const match of html.matchAll(/<[^>]+>/g)) {
    const attributes = new Map(Array.from(match[0].matchAll(/([\w-]+)="([^"]*)"/g), (m) => [m[1], m[2]]));
    if (attributes.get('id') === selectorId) {
      const value = attributes.get(name.startsWith('data-') ? name : `data-${name}`);
      return value === undefined ? null : decode(value);
    }
  }
  return null;
}
