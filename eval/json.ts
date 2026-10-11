// Keep generated JSON readable and consistent with the frozen 120-column
// formatter without invoking a shell or depending on a formatting executable.
export function prettyJson(value: unknown): string {
  const source = JSON.stringify(value, null, 2);
  const scalarArray = /\[\n((?:[ \t]+(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null),?\n)+)([ \t]*)\]/g;
  return `${source.replace(scalarArray, (match: string, _items: string, _indent: string, offset: number) => {
    const values = JSON.parse(match) as unknown[];
    const compact = `[${values.map((item) => JSON.stringify(item)).join(', ')}]`;
    const prefixLength = offset - source.lastIndexOf('\n', offset) - 1;
    const commaLength = source[offset + match.length] === ',' ? 1 : 0;
    return prefixLength + compact.length + commaLength <= 120 ? compact : match;
  })}\n`;
}
