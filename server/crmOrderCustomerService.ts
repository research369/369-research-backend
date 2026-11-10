import { eq, or, sql } from "drizzle-orm";
import { customers, orders } from "../drizzle/schema.js";
import { resolveCheckoutCustomerDataChange } from "./customerDataChangeService.js";

export type CrmOrderContext = {
  customerId: number | null;
  email: string;
  name: string;
  canonicalOrderId: string;
  matchState: "linked" | "unique_match" | "unlinked_review";
};

/** All context/automatic archive reads are side-effect free. SQL wildcards are never identity keys. */
export async function readCrmOrderContext(db: any, orderReference: string): Promise<CrmOrderContext> {
  const found = await db.select().from(orders).where(or(
    eq(orders.orderId, orderReference), eq(orders.externalOrderReference, orderReference),
  )).limit(2);
  if (found.length !== 1) throw new Error(found.length ? "Bestellreferenz nicht eindeutig" : "Bestellung nicht gefunden");
  const order = found[0];
  if (order.customerId) {
    const [customer] = await db.select().from(customers).where(eq(customers.id, order.customerId)).limit(1);
    if (customer) return { customerId: customer.id, email: order.email, name: customer.name, canonicalOrderId: order.orderId, matchState: "linked" };
    // A stale explicit link must be reviewed, never rematched to somebody else.
    return { customerId: null, email: order.email, name: `${order.firstName} ${order.lastName}`.trim(), canonicalOrderId: order.orderId, matchState: "unlinked_review" };
  }
  const resolution = resolveCheckoutCustomerDataChange(await db.select().from(customers), order);
  return {
    customerId: resolution.kind === "matched" ? resolution.customer.id : null,
    email: order.email,
    name: `${order.firstName} ${order.lastName}`.trim(),
    canonicalOrderId: order.orderId,
    matchState: resolution.kind === "matched" ? "unique_match" : "unlinked_review",
  };
}

/** Explicit admin-only router mutation calls this transaction; no implicit creation/merge. */
export async function linkCrmExistingOrder(db: any, orderReference: string): Promise<CrmOrderContext> {
  return db.transaction(async (tx: any) => {
    const found = await tx.select().from(orders).where(or(
      eq(orders.orderId, orderReference), eq(orders.externalOrderReference, orderReference),
    )).limit(2).for("update");
    if (found.length !== 1) throw new Error(found.length ? "Bestellreferenz nicht eindeutig" : "Bestellung nicht gefunden");
    // Serialize against customer create/update/delete, including a new duplicate
    // inserted between selection and linking. No name-based or random ILIKE match.
    await tx.execute(sql`LOCK TABLE customers IN SHARE MODE`);
    const context = await readCrmOrderContext(tx, found[0].orderId);
    if (!context.customerId) throw new Error("Kundenverknüpfung erfordert manuelle Prüfung");
    if (found[0].customerId !== context.customerId) {
      await tx.update(orders).set({ customerId: context.customerId, updatedAt: new Date() }).where(eq(orders.id, found[0].id));
    }
    return { ...context, matchState: "linked" };
  });
}
