export const CUSTOMER_ORDER_STATUSES = new Set([
  "offen",
  "bezahlt",
  "gepackt",
  "versendet",
  "zugestellt",
]);

export interface CustomerOrderMetricInput {
  total: string | number | null | undefined;
  status: string | null | undefined;
  orderDate: Date | null | undefined;
}

export interface CustomerOrderMetrics {
  totalOrders: number;
  totalSpent: number;
  firstOrderDate: Date | null;
  lastOrderDate: Date | null;
}

/**
 * Der CRM-Umsatz ist ausschließlich die Summe der tatsächlich dem Kundendatensatz
 * zugeordneten, nicht stornierten Aufträge. E-Mail- oder Telefonnummern können
 * zwischen Datensätzen geteilt werden und dürfen deshalb niemals nachträglich
 * denselben Auftrag mehreren Kunden zuschreiben.
 */
export function calculateCustomerOrderMetrics(
  orders: CustomerOrderMetricInput[],
): CustomerOrderMetrics {
  const included = orders.filter((order) =>
    CUSTOMER_ORDER_STATUSES.has(String(order.status || "").trim().toLowerCase()),
  );
  const dates = included
    .map((order) => order.orderDate)
    .filter((date): date is Date => date instanceof Date && !Number.isNaN(date.getTime()));

  return {
    totalOrders: included.length,
    totalSpent: included.reduce((sum, order) => sum + Number(order.total || 0), 0),
    firstOrderDate: dates.length > 0 ? new Date(Math.min(...dates.map((date) => date.getTime()))) : null,
    lastOrderDate: dates.length > 0 ? new Date(Math.max(...dates.map((date) => date.getTime()))) : null,
  };
}
