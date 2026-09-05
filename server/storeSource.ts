export type StoreKey = "369research" | "peps4pets" | "checkout-v2";

const PEPS4PETS_MARKER = "[QUELLE: PEPS4PETS]";
const CHECKOUT_V2_MARKER = "[QUELLE: CHECKOUT V2]";

export function sourceMarkerForStore(storeKey: StoreKey): string | null {
  if (storeKey === "peps4pets") return PEPS4PETS_MARKER;
  if (storeKey === "checkout-v2") return CHECKOUT_V2_MARKER;
  return null;
}

export function withStoreSourceMarker(storeKey: StoreKey, notes: Array<string | null | undefined>): string | null {
  return [sourceMarkerForStore(storeKey), ...notes]
    .filter((note): note is string => Boolean(note))
    .join(" | ") || null;
}
