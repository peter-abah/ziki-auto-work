export function rotatedKinds(entries: ReadonlyArray<{ kind: string }>, lastKind: string | null): string[] {
  const kinds: string[] = [];
  for (const entry of entries) {
    if (!kinds.includes(entry.kind)) kinds.push(entry.kind);
  }
  if (!kinds.length) return [];
  const lastIndex = lastKind ? kinds.indexOf(lastKind) : -1;
  const start = lastIndex >= 0 ? (lastIndex + 1) % kinds.length : 0;
  return [...kinds.slice(start), ...kinds.slice(0, start)];
}
