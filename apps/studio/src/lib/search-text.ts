/** Case and accent insensitive form of a string, for client-side filters. */
export function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

export function matchesQuery(query: string, ...fields: ReadonlyArray<string>): boolean {
  const needle = foldText(query);
  return needle === '' || fields.some((field) => foldText(field).includes(needle));
}
