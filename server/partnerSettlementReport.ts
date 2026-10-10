import { isFinanciallyPaidStatus } from "./paidFinancialStatus.js";

export type PartnerSettlementOrderInput = {
  orderId: string;
  customerName: string;
  orderDate: Date | string;
  subtotal: number;
  discount: number;
  total: number;
  status: string;
  paidAt: Date | string | null;
  appliedPartnerCode: string | null;
  partnerCodeIdSnapshot: number | null;
  partnerDiscount: number;
  partnerCommission: number;
  partnerCommissionPercentSnapshot: number | null;
  partnerCustomerDiscountPercentSnapshot: number | null;
  partnerCommissionBaseSnapshot: number | null;
  items: Array<{ name: string; quantity: number; price: number }>;
};

export type PartnerSettlementTransactionInput = {
  id: number;
  partnerId: number;
  type: "provision" | "einloesung" | "korrektur" | "auszahlung";
  amount: number;
  balanceAfter: number;
  orderId: string | null;
  customerName: string | null;
  description: string | null;
  status: "normal" | "storniert" | "nicht_gewertet" | "ausgeblendet";
  adminNote: string | null;
  createdAt: Date | string;
};

export type PartnerSettlementPeriod = {
  key: string;
  label: string;
  orderCount: number;
  paidOrderCount: number;
  orderValue: number;
  paidOrderValue: number;
  commissionBooked: number;
  creditRedeemed: number;
  payouts: number;
  adjustments: number;
  netMovement: number;
};

const BERLIN_TIME_ZONE = "Europe/Berlin";

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function money(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? roundMoney(parsed) : 0;
}

function asDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Ungültiges Datum in der Partnerabrechnung");
  }
  return date;
}

function berlinCalendarDate(value: Date | string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BERLIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(asDate(value));
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

function isoWeek(value: Date | string): { year: number; week: number } {
  const { year, month, day } = berlinCalendarDate(value);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday + 3);
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstWeekday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstWeekday + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / 604_800_000);
  return { year: isoYear, week };
}

function periodFor(value: Date | string, grain: "week" | "month"): Pick<PartnerSettlementPeriod, "key" | "label"> {
  if (grain === "week") {
    const { year, week } = isoWeek(value);
    return { key: `${year}-W${String(week).padStart(2, "0")}`, label: `KW ${String(week).padStart(2, "0")} · ${year}` };
  }

  const { year, month } = berlinCalendarDate(value);
  return {
    key: `${year}-${String(month).padStart(2, "0")}`,
    label: new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric", timeZone: BERLIN_TIME_ZONE }).format(asDate(value)),
  };
}

function createPeriod(key: string, label: string): PartnerSettlementPeriod {
  return {
    key,
    label,
    orderCount: 0,
    paidOrderCount: 0,
    orderValue: 0,
    paidOrderValue: 0,
    commissionBooked: 0,
    creditRedeemed: 0,
    payouts: 0,
    adjustments: 0,
    netMovement: 0,
  };
}

function serialisePeriods(periods: Map<string, PartnerSettlementPeriod>): PartnerSettlementPeriod[] {
  return [...periods.values()]
    .map((period) => ({
      ...period,
      orderValue: roundMoney(period.orderValue),
      paidOrderValue: roundMoney(period.paidOrderValue),
      commissionBooked: roundMoney(period.commissionBooked),
      creditRedeemed: roundMoney(period.creditRedeemed),
      payouts: roundMoney(period.payouts),
      adjustments: roundMoney(period.adjustments),
      netMovement: roundMoney(period.netMovement),
    }))
    .sort((a, b) => b.key.localeCompare(a.key));
}

function buildPeriods(
  orders: PartnerSettlementOrderInput[],
  transactions: PartnerSettlementTransactionInput[],
  grain: "week" | "month",
): PartnerSettlementPeriod[] {
  const periods = new Map<string, PartnerSettlementPeriod>();
  const ensure = (value: Date | string) => {
    const { key, label } = periodFor(value, grain);
    const current = periods.get(key) || createPeriod(key, label);
    periods.set(key, current);
    return current;
  };

  for (const order of orders) {
    const period = ensure(order.orderDate);
    period.orderCount += 1;
    period.orderValue += money(order.total);
    if (isFinanciallyPaidStatus(order.status) && order.paidAt) {
      period.paidOrderCount += 1;
      period.paidOrderValue += money(order.total);
    }
  }

  for (const transaction of transactions) {
    if (transaction.status !== "normal") continue;
    const period = ensure(transaction.createdAt);
    const amount = money(transaction.amount);
    period.netMovement += amount;
    if (transaction.type === "provision") period.commissionBooked += amount;
    if (transaction.type === "einloesung") period.creditRedeemed += Math.abs(amount);
    if (transaction.type === "auszahlung") period.payouts += Math.abs(amount);
    if (transaction.type === "korrektur") period.adjustments += amount;
  }

  return serialisePeriods(periods);
}

export function buildPartnerSettlementReport(input: {
  currentBalance: number;
  orders: PartnerSettlementOrderInput[];
  transactions: PartnerSettlementTransactionInput[];
}) {
  const normalTransactions = input.transactions.filter((transaction) => transaction.status === "normal");
  const normalProvisionByOrder = new Map<string, number>();
  for (const transaction of normalTransactions) {
    if (transaction.type !== "provision" || !transaction.orderId) continue;
    normalProvisionByOrder.set(
      transaction.orderId,
      roundMoney((normalProvisionByOrder.get(transaction.orderId) || 0) + money(transaction.amount)),
    );
  }

  const detailedOrders = input.orders.map((order) => {
    const paid = isFinanciallyPaidStatus(order.status) && Boolean(order.paidAt);
    const commissionExpected = money(order.partnerCommission);
    const commissionBooked = money(normalProvisionByOrder.get(order.orderId));
    const commissionBookingStatus = !paid
      ? "zahlungsbestaetigung_ausstehend"
      : commissionBooked > 0
        ? "gebucht"
        : commissionExpected > 0
          ? "zu_pruefen"
          : "keine_provision";

    return {
      ...order,
      paid,
      commissionExpected,
      commissionBooked,
      commissionBookingStatus,
    };
  });

  const paidOrders = detailedOrders.filter((order) => order.paid);
  const totalCommissionEarned = normalTransactions
    .filter((transaction) => transaction.type === "provision")
    .reduce((sum, transaction) => sum + money(transaction.amount), 0);
  const totalRedeemed = normalTransactions
    .filter((transaction) => transaction.type === "einloesung")
    .reduce((sum, transaction) => sum + Math.abs(money(transaction.amount)), 0);
  const totalPaidOut = normalTransactions
    .filter((transaction) => transaction.type === "auszahlung")
    .reduce((sum, transaction) => sum + Math.abs(money(transaction.amount)), 0);
  const totalAdjustments = normalTransactions
    .filter((transaction) => transaction.type === "korrektur")
    .reduce((sum, transaction) => sum + money(transaction.amount), 0);
  const paidUnbookedOrders = detailedOrders.filter((order) => order.commissionBookingStatus === "zu_pruefen");

  return {
    summary: {
      totalOrders: detailedOrders.length,
      paidOrders: paidOrders.length,
      openOrders: detailedOrders.length - paidOrders.length,
      totalOrderValue: roundMoney(detailedOrders.reduce((sum, order) => sum + money(order.total), 0)),
      paidOrderValue: roundMoney(paidOrders.reduce((sum, order) => sum + money(order.total), 0)),
      totalPartnerDiscount: roundMoney(detailedOrders.reduce((sum, order) => sum + money(order.partnerDiscount), 0)),
      totalCommissionEarned: roundMoney(totalCommissionEarned),
      totalRedeemed: roundMoney(totalRedeemed),
      totalPaidOut: roundMoney(totalPaidOut),
      totalAdjustments: roundMoney(totalAdjustments),
      currentBalance: roundMoney(input.currentBalance),
      pendingCommission: roundMoney(
        detailedOrders
          .filter((order) => !order.paid)
          .reduce((sum, order) => sum + order.commissionExpected, 0),
      ),
      paidUnbookedCommission: roundMoney(paidUnbookedOrders.reduce((sum, order) => sum + order.commissionExpected, 0)),
      paidUnbookedOrderCount: paidUnbookedOrders.length,
      excludedTransactionCount: input.transactions.length - normalTransactions.length,
    },
    orders: detailedOrders,
    transactions: input.transactions,
    periods: {
      weekly: buildPeriods(input.orders, input.transactions, "week"),
      monthly: buildPeriods(input.orders, input.transactions, "month"),
    },
  };
}
