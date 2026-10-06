import { getPool } from "../db.js";

const PLACEHOLDER_EMAILS = new Set([
  "keine@angabe.de", "noemail@noemail.de", "no@email.de", "noreply@noreply.de",
  "placeholder@placeholder.de", "test@test.de", "info@info.de", "otc@369research.eu",
]);

function normalizePhone(phone: string): string {
  return (phone || "").replace(/[\s\-\.()]/g, "");
}

/**
 * Legacy repair for customer records that predate the customers table.
 *
 * This operation deliberately never runs during an application restart: it
 * reads the complete historical customer/order base and can write new records.
 * Invoke it only as an explicit, monitored maintenance task when an old data
 * import needs repair. Normal checkout customer assignment is unaffected.
 */
export async function runLegacyCustomerBackfill(): Promise<number> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");

  const customersResult = await pool.query("SELECT id, email, phone FROM customers");
  const existingEmails = new Set<string>();
  const existingPhones = new Set<string>();

  for (const customer of customersResult.rows) {
    if (customer.email) {
      const email = String(customer.email).toLowerCase().trim();
      if (!PLACEHOLDER_EMAILS.has(email)) existingEmails.add(email);
    }
    if (customer.phone) {
      const phone = normalizePhone(String(customer.phone));
      if (phone.length >= 8) existingPhones.add(phone);
    }
  }

  const ordersResult = await pool.query(
    "SELECT * FROM orders WHERE customer_id IS NULL ORDER BY order_date DESC",
  );
  const maxNumberResult = await pool.query(
    "SELECT COALESCE(MAX(CAST(customer_number AS INTEGER)), 1209) AS max_num FROM customers WHERE customer_number ~ '^[0-9]+$'",
  );
  let nextCustomerNumber = Math.max(1210, Number(maxNumberResult.rows[0]?.max_num || 1209) + 1);

  const groups = new Map<string, any[]>();
  for (const order of ordersResult.rows) {
    const email = String(order.email || "").toLowerCase().trim();
    const phone = normalizePhone(String(order.phone || ""));
    const hasUsableEmail = Boolean(email) && !PLACEHOLDER_EMAILS.has(email);
    const hasUsablePhone = phone.length >= 8;

    if (hasUsableEmail && existingEmails.has(email)) continue;
    if (!hasUsableEmail && hasUsablePhone && existingPhones.has(phone)) continue;

    const groupKey = hasUsableEmail ? `e:${email}` : hasUsablePhone ? `p:${phone}` : `o:${order.order_id}`;
    const group = groups.get(groupKey) ?? [];
    group.push(order);
    groups.set(groupKey, group);
  }

  let created = 0;
  for (const group of groups.values()) {
    const firstOrder = group[0];
    const firstName = String(firstOrder.first_name || "");
    const lastName = String(firstOrder.last_name || "");
    const name = `${firstName} ${lastName}`.trim();
    if (!name) continue;

    const email = String(firstOrder.email || "").toLowerCase().trim();
    const hasUsableEmail = Boolean(email) && !PLACEHOLDER_EMAILS.has(email);
    const totalOrders = group.length;
    const totalSpent = group.reduce((sum: number, order: any) => sum + Number(order.total || 0), 0);
    const dates = group.map((order: any) => order.order_date).filter(Boolean).sort();

    try {
      await pool.query(
        `INSERT INTO customers
          (customer_number, name, first_name, last_name, phone, email, company,
           street, house_number, zip, city, country, source,
           total_orders, total_spent, first_order_date, last_order_date, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),NOW())`,
        [
          String(nextCustomerNumber), name, firstName || null, lastName || null,
          firstOrder.phone || null, hasUsableEmail ? firstOrder.email : null, firstOrder.company || null,
          firstOrder.street || null, firstOrder.house_number || null, firstOrder.zip || null,
          firstOrder.city || null, firstOrder.country || null, "backfill",
          totalOrders, totalSpent.toFixed(2),
          dates[0] || null, dates[dates.length - 1] || null,
        ],
      );
      if (hasUsableEmail) existingEmails.add(email);
      const phone = normalizePhone(String(firstOrder.phone || ""));
      if (phone.length >= 8) existingPhones.add(phone);
      nextCustomerNumber += 1;
      created += 1;
    } catch {
      // A concurrent/manual correction may make this historic row a duplicate.
      // The explicit maintenance task remains idempotent and continues safely.
    }
  }

  return created;
}
