export type StoreKey = "369research" | "peps4pets" | "ladypeps";

const PEPS4PETS_MARKER = "[QUELLE: PEPS4PETS]";
const LADYPEPS_MARKER = "[QUELLE: LADYPEPS]";

export function sourceMarkerForStore(storeKey: StoreKey): string | null {
  if (storeKey === "peps4pets") return PEPS4PETS_MARKER;
  if (storeKey === "ladypeps") return LADYPEPS_MARKER;
  return null;
}

export function withStoreSourceMarker(storeKey: StoreKey, notes: Array<string | null | undefined>): string | null {
  return [sourceMarkerForStore(storeKey), ...notes]
    .filter((note): note is string => Boolean(note))
    .join(" | ") || null;
}
