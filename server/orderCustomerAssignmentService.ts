import { eq, inArray, sql } from "drizzle-orm";
import { customers, orders } from "../drizzle/schema.js";
import { calculateCustomerOrderMetrics } from "./customerOrderMetrics.js";

export async function reassignOrderCustomer(db: any, input: { orderId: string; newCustomerId: number }, actorId: number) {
  if (!Number.isInteger(input.newCustomerId) || input.newCustomerId <= 0) throw new Error("Ungültiger Zielkunde");
  return db.transaction(async (tx: any) => {
    const [order] = await tx.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1).for("update");
    if (!order) throw new Error("Bestellung nicht gefunden");
    const oldCustomerId: number | null = order.customerId;
    const ids = [...new Set([oldCustomerId, input.newCustomerId].filter((id): id is number => id !== null))].sort((a, b) => a - b);
    const locked = await tx.select({ id: customers.id }).from(customers).where(inArray(customers.id, ids)).orderBy(customers.id).for("update");
    if (!locked.some((customer: { id: number }) => customer.id === input.newCustomerId)) throw new Error("Zielkunde nicht gefunden");
    if (oldCustomerId !== input.newCustomerId) {
      await tx.update(orders).set({ customerId: input.newCustomerId, updatedAt: new Date() }).where(eq(orders.id, order.id));
      await tx.execute(sql`INSERT INTO order_customer_assignment_events(order_id, previous_customer_id, customer_id, actor_id)
        VALUES(${order.orderId}, ${oldCustomerId}, ${input.newCustomerId}, ${actorId})`);
    }
    for (const id of ids) {
      const linked = await tx.select({ total: orders.total, status: orders.status, orderDate: orders.orderDate }).from(orders).where(eq(orders.customerId, id));
      const metrics = calculateCustomerOrderMetrics(linked);
      await tx.update(customers).set({ totalOrders: metrics.totalOrders, totalSpent: metrics.totalSpent.toFixed(2), firstOrderDate: metrics.firstOrderDate, lastOrderDate: metrics.lastOrderDate, updatedAt: new Date() }).where(eq(customers.id, id));
    }
    return { success: true, oldCustomerId, newCustomerId: input.newCustomerId };
  });
}
