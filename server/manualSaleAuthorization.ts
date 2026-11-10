import { TRPCError } from "@trpc/server";
/** Mirrors existing fulfilment/sales access: no new role or product-manager right. */
export function assertManualSaleRole(orderSource: string | undefined, user: { role: string } | null | undefined): void {
  if (orderSource !== "wawi_manual") return;
  if (!user) throw new TRPCError({ code: "UNAUTHORIZED", message: "WAWI_ANMELDUNG_ERFORDERLICH: Bitte erneut anmelden." });
  if (!["admin", "packing"].includes(user.role)) throw new TRPCError({ code: "FORBIDDEN", message: "Keine Berechtigung für manuelle Verkäufe" });
}
