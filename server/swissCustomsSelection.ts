import type { SwissCustomsLine } from "./swissCustomsService.js";

export type SwissCustomsDraftItem = {
  orderItemId: number;
  description: string;
  hsCode: string;
  countryOfOrigin: string;
  unitWeightGrams: number;
  unitCustomsValueEur: number;
};

export type SwissCustomsDraftInput = {
  packageWeightGrams?: unknown;
  complianceConfirmed?: unknown;
  items?: SwissCustomsDraftItem[];
  excludedOrderItemIds?: number[];
};

type ExistingOrderItem = { id: number; quantity: number };

function isOrderItemId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Every original position must be either declared or explicitly excluded, once. */
export function validateSwissCustomsSelection(
  existingItems: readonly ExistingOrderItem[],
  items: unknown,
  excludedOrderItemIds: unknown = [],
): { ok: true; lines: SwissCustomsLine[] } | { ok: false; error: string } {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: "Mindestens eine Bestellposition muss mit Zolldaten erfasst werden." };
  }
  if (!Array.isArray(excludedOrderItemIds)) {
    return { ok: false, error: "Ausgeschlossene Bestellpositionen müssen als Liste von Positions-IDs angegeben werden." };
  }
  const existingIds = new Set(existingItems.map((item) => item.id));
  const inputById = new Map<number, SwissCustomsDraftItem>();
  const assignedIds = new Set<number>();
  for (const item of items) {
    if (!item || typeof item !== "object" || !isOrderItemId(item.orderItemId)
      || !existingIds.has(item.orderItemId) || assignedIds.has(item.orderItemId)) {
      return { ok: false, error: "Die Zolldaten passen nicht exakt zu den Bestellpositionen: ungültige, fremde oder doppelte Positions-ID." };
    }
    assignedIds.add(item.orderItemId);
    inputById.set(item.orderItemId, item);
  }
  for (const id of excludedOrderItemIds) {
    if (!isOrderItemId(id) || !existingIds.has(id) || assignedIds.has(id)) {
      return { ok: false, error: "Ausgeschlossene Bestellpositionen enthalten eine ungültige, fremde, doppelte oder bereits ausgewählte Positions-ID." };
    }
    assignedIds.add(id);
  }
  if (assignedIds.size !== existingIds.size) {
    return { ok: false, error: "Alle Bestellpositionen müssen genau einmal mit Zolldaten erfasst oder ausdrücklich ausgeschlossen werden." };
  }
  return {
    ok: true,
    lines: existingItems.filter((item) => inputById.has(item.id)).map((item) => {
      const customs = inputById.get(item.id)!;
      return {
        orderItemId: item.id,
        description: customs.description,
        hsCode: customs.hsCode,
        countryOfOrigin: customs.countryOfOrigin,
        unitWeightGrams: Number(customs.unitWeightGrams),
        quantity: Number(item.quantity),
        unitCustomsValueEur: Number(customs.unitCustomsValueEur),
      };
    }),
  };
}

/** Declaration existence, not a nonempty saved-ID set, distinguishes a saved draft. */
export function restoreSwissCustomsSelection<T extends { id: number }>(
  originalItems: readonly T[],
  hasSavedDeclaration: boolean,
  savedItemIds: ReadonlySet<number>,
): { items: T[]; excludedItems: T[] } {
  if (!hasSavedDeclaration) return { items: [...originalItems], excludedItems: [] };
  return {
    items: originalItems.filter((item) => savedItemIds.has(item.id)),
    excludedItems: originalItems.filter((item) => !savedItemIds.has(item.id)),
  };
}
