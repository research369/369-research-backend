export type StoreKey = "369research" | "peps4pets";

const PEPS4PETS_MARKER = "[QUELLE: PEPS4PETS]";

export function sourceMarkerForStore(storeKey: StoreKey): string | null {
  return storeKey === "peps4pets" ? PEPS4PETS_MARKER : null;
}

export function withStoreSourceMarker(storeKey: StoreKey, notes: Array<string | null | undefined>): string | null {
  return [sourceMarkerForStore(storeKey), ...notes]
    .filter((note): note is string => Boolean(note))
    .join(" | ") || null;
}
