import { roundMoney } from "./kwkCheckoutPricing.js";

/**
 * A manual WaWi discount is accounting metadata, never a customer-facing
 * promotion code. This prevents labels such as "25%" or "Kostenloser Versand"
 * from being resolved against the promo-code catalogue.
 */
export function normalizeDiscountCodeForOrderSource(
  orderSource: string | null | undefined,
  discountCode: string | null | undefined,
): string | null {
  if (orderSource === "wawi_manual") return null;
  const normalized = discountCode?.trim();
  return normalized ? normalized : null;
}

/**
 * Serverseitige Endberechnung für einen authentifizierten manuellen WaWi-Verkauf.
 *
 * Der Dauerrabatt wird ausschließlich aus der zentralen Serverkonfiguration
 * übernommen. Ein vom Dialog mitgesendeter Dauerrabattbetrag ist nur eine
 * Anzeigeinformation und wird nie als Preisquelle akzeptiert. Bewusst gesetzte
 * manuelle Rabattanteile bleiben erhalten, werden aber am verfügbaren Warenwert
 * gedeckelt. Versand bleibt dabei vollständig außerhalb des Dauerrabatts.
 */
export function calculateAuthoritativeWawiManualOrder(input: {
  subtotal: number;
  shipping: number;
  submittedDiscount: number;
  submittedAutomaticGlobalDiscount: number;
  authoritativeAutomaticGlobalDiscount: number;
}): {
  manualDiscount: number;
  automaticGlobalDiscount: number;
  totalDiscount: number;
  total: number;
} {
  const subtotal = roundMoney(Math.max(0, input.subtotal));
  const shipping = roundMoney(Math.max(0, input.shipping));
  const submittedDiscount = roundMoney(Math.max(0, input.submittedDiscount));
  const submittedAutomaticGlobalDiscount = roundMoney(Math.max(0, input.submittedAutomaticGlobalDiscount));
  const automaticGlobalDiscount = roundMoney(Math.min(
    subtotal,
    Math.max(0, input.authoritativeAutomaticGlobalDiscount),
  ));

  // Ein im Dialog bereits angezeigter Dauerrabatt wird herausgerechnet. So
  // bleiben Positionsrabatte, manuelle Gesamtrabatte und Gutschriften erhalten.
  const requestedManualDiscount = roundMoney(Math.max(0, submittedDiscount - submittedAutomaticGlobalDiscount));
  const manualDiscount = roundMoney(Math.min(
    Math.max(0, subtotal - automaticGlobalDiscount),
    requestedManualDiscount,
  ));
  const totalDiscount = roundMoney(automaticGlobalDiscount + manualDiscount);

  return {
    manualDiscount,
    automaticGlobalDiscount,
    totalDiscount,
    total: roundMoney(subtotal - totalDiscount + shipping),
  };
}
