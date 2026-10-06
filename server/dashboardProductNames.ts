export function normalizeDashboardProductNames(rows: ReadonlyArray<{ name?: unknown }>): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const row of rows) {
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name || seen.has(name)) continue;

    seen.add(name);
    names.push(name);
  }

  return names;
}
