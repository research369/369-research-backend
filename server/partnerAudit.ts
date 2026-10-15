import { randomUUID } from "node:crypto";
import { getDb, getPool, withReadOnlyDatabase } from "./db.js";
import { articles, partners } from "../drizzle/schema.js";
import {
  getPartnerProgram,
  listPartnerCodeTerms,
} from "./partnerProgramService.js";
import { getPublicShopVariants } from "./articleRouter.js";
import { simulateCheckout } from "./operationsSimulation.js";
import { partnerRouter } from "./partnerRouter.js";
import { PAID_ORDER_STATUSES } from "./partnerCreditService.js";
import type { Request, Response } from "express";
export type AuditFinding = {
  key: string;
  severity: "error" | "review";
  kind: string;
  partnerId: number | null;
  partnerName?: string;
  partnerNumber?: string;
  code?: string;
  orderId?: string;
  message: string;
  expected?: number;
  booked?: number;
};
const cents = (n: number) => Math.round((n + Number.EPSILON) * 100);
export function auditCommissionRow(
  row: any,
  now = Date.now(),
): {
  kind: string;
  severity?: "error" | "review";
  expected?: number;
  booked?: number;
} {
  const entries = row.entries ?? [];
  const own = !!row.partner_number;
  const target = entries.filter(
    (e: any) => e.partnerId === row.resolved_partner_id,
  );
  const amount = target.reduce((s: number, e: any) => s + Number(e.amount), 0);
  const base = { expected: Number(row.expected_amount), booked: amount };
  if (!row.resolved_partner_id)
    return { kind: "unattributed_order", severity: "review", ...base };
  if (
    row.partner_source_id &&
    row.code_partner_id &&
    row.partner_source_id !== row.code_partner_id
  )
    return { kind: "attribution_conflict", severity: "error", ...base };
  if (entries.some((e: any) => e.partnerId !== row.resolved_partner_id))
    return { kind: "wrong_recipient", severity: "error", ...base };
  if (target.length > 1)
    return { kind: "duplicate", severity: "error", ...base };
  const paid = !!row.paid_at && PAID_ORDER_STATUSES.has(row.status);
  if (!paid)
    return target.length
      ? { kind: "unexpected_booking", severity: "error", ...base }
      : { kind: "not_paid", ...base };
  if (!row.policy)
    return { kind: "legacy_unknown", severity: "review", ...base };
  const excluded =
    row.policy === "none" ||
    (!own &&
      row.policy === "first_paid_code_order" &&
      Number(row.paid_rank) > 1);
  const expected = excluded ? 0 : Number(row.expected_amount);
  if (!Number.isFinite(expected))
    return { kind: "invalid_snapshot", severity: "review", ...base };
  if (
    !excluded &&
    row.override_amount === null &&
    row.commission_base !== null &&
    row.commission_percent !== null &&
    cents(
      (Number(row.commission_base) * Number(row.commission_percent)) / 100,
    ) !== cents(expected)
  )
    return { kind: "snapshot_mismatch", severity: "error", ...base };
  if (target.length)
    return cents(amount) === cents(expected)
      ? { kind: "booked", ...base }
      : {
          kind: "amount_mismatch",
          severity: "error",
          expected,
          booked: amount,
        };
  if (expected <= 0) return { kind: "not_due", expected, booked: 0 };
  if (Number(row.reversed_count) > 0)
    return { kind: "reversed_paid", severity: "review", ...base };
  if (now - new Date(row.paid_at).getTime() < 120000)
    return { kind: "pending", ...base };
  return { kind: "missing", severity: "error", ...base };
}
const messages: Record<string, string> = {
  wrong_recipient: "Provision wurde einem anderen Partner zugeordnet.",
  duplicate: "Mehrere normale Provisionsbuchungen für dieselbe Bestellung.",
  unexpected_booking: "Provisionsbuchung ohne bestätigten Zahlungsstatus.",
  legacy_unknown:
    "Historische Provisionsregel fehlt; Anspruch nicht automatisch beurteilbar.",
  attribution_conflict:
    "Gespeicherter Partner und Code-Eigentümer widersprechen sich.",
  snapshot_mismatch:
    "Gespeicherter Provisionsbetrag passt nicht zu gespeicherter Basis und Satz.",
  amount_mismatch:
    "Gebuchte Provision weicht vom Anspruch nach gespeicherter Regel ab.",
  missing: "Fällige Provision fehlt seit mehr als zwei Minuten nach Zahlung.",
  reversed_paid:
    "Provision einer weiterhin bezahlten Bestellung wurde storniert; bitte prüfen.",
  unattributed_order:
    "Partnerbestellung lässt sich keinem Partner eindeutig zuordnen.",
  invalid_snapshot:
    "Gespeicherte Provisionswerte sind unvollständig oder ungültig.",
};
export async function runPartnerAudit(req: Request, res: Response) {
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + 90000;
  const data = await withReadOnlyDatabase(async () => {
    const db = await getDb();
    const pool = await getPool();
    if (!db || !pool) throw Error("unavailable");
    const all = await db.select().from(partners);
    const targets = [];
    for (const p of all)
      targets.push({
        ...p,
        program: await getPartnerProgram(p.id),
        codes: await listPartnerCodeTerms(p.id),
      });
    const inventory = await db.select().from(articles);
    let cart: any = null;
    for (const a of inventory.filter(
      (a) => a.isActive === 1 && a.shopVisible === 1 && a.shopProductId,
    )) {
      const v = getPublicShopVariants(a, inventory).find(
        (v) => !v.hidden && v.stock > 0 && v.price > 0,
      );
      if (v) {
        cart = {
          articleId: v.articleId,
          sku: v.sku,
          shopProductId: a.shopProductId,
          variantKey: v.dosage,
          quantity: 1,
        };
        break;
      }
    }
    const history = await pool.query(`WITH paid AS (
   SELECT id,row_number() OVER(PARTITION BY upper(regexp_replace(coalesce(partner_code,''),'[[:space:]]+','','g')),lower(trim(email)) ORDER BY paid_at,id) AS paid_rank
   FROM orders WHERE paid_at IS NOT NULL AND status::text IN ('bezahlt','gepackt','versendet','zugestellt','abgeholt')
  ), ledger AS (SELECT order_id,jsonb_agg(jsonb_build_object('partnerId',partner_id,'amount',amount,'id',id)) FILTER(WHERE status::text='normal') AS entries,count(*) FILTER(WHERE status::text='storniert') AS reversed_count FROM partner_transactions WHERE type::text='provision' GROUP BY order_id)
  SELECT o.id,o.order_id,o.email,o.status,o.paid_at,o.partner_code,o.partner_number,o.partner_source_id,pc.partner_id AS code_partner_id,
   coalesce(o.partner_source_id,pc.partner_id,ownp.id,legacy.partner_id) AS resolved_partner_id,
   o.partner_commission_policy_snapshot AS policy,o.partner_commission_base_snapshot AS commission_base,o.partner_commission_percent_snapshot AS commission_percent,
   ov.amount AS override_amount,coalesce(ov.amount,o.partner_commission,0) AS expected_amount,coalesce(l.entries,'[]'::jsonb) AS entries,l.reversed_count,paid.paid_rank
  FROM orders o LEFT JOIN partner_codes pc ON pc.id=o.partner_code_id_snapshot
  LEFT JOIN partners ownp ON ownp.partner_number=o.partner_number AND coalesce(o.partner_number,'')<>''
  LEFT JOIN partner_codes legacy ON legacy.code_normalized=upper(regexp_replace(coalesce(o.partner_code,''),'[[:space:]]+','','g'))
  LEFT JOIN partner_order_credit_overrides ov ON ov.order_id=o.order_id AND ov.is_active=1
  LEFT JOIN ledger l ON l.order_id=o.order_id LEFT JOIN paid ON paid.id=o.id
  WHERE o.partner_source_id IS NOT NULL OR o.partner_code_id_snapshot IS NOT NULL OR coalesce(o.partner_code,'')<>'' OR coalesce(o.partner_number,'')<>''
  ORDER BY o.id LIMIT 100001`);
    const orphans = await pool.query(
      `SELECT t.id,t.partner_id,t.order_id,t.amount FROM partner_transactions t LEFT JOIN orders o ON o.order_id=t.order_id WHERE t.type::text='provision' AND t.status::text='normal' AND o.id IS NULL ORDER BY t.id LIMIT 1001`,
    );
    return { targets, cart, history: history.rows, orphans: orphans.rows };
  });
  const findings: AuditFinding[] = [];
  const cases: any[] = [];
  const counts = {
    partners: data.targets.length,
    activePartners: 0,
    codes: 0,
    checkedCodes: 0,
    excludedCodes: 0,
    checkoutCases: 0,
    orders: 0,
    bookedOrders: 0,
    pendingOrders: 0,
    notDueOrders: 0,
  };
  let complete = data.history.length <= 100000 && data.orphans.length <= 1000;
  const byId = new Map(data.targets.map((p) => [p.id, p]));
  const add = (
    kind: string,
    partnerId: number | null,
    message: string,
    extra: Partial<AuditFinding> = {},
    severity: "error" | "review" = "error",
  ) => {
    const p = partnerId ? byId.get(partnerId) : undefined;
    const { key: discriminator, ...details } = extra;
    findings.push({
      key: [
        kind,
        partnerId,
        extra.orderId ?? "",
        extra.code ?? "",
        discriminator ?? "",
      ].join(":"),
      kind,
      partnerId,
      partnerName: p?.name,
      partnerNumber: p?.partnerNumber,
      message,
      severity,
      ...details,
    });
  };
  for (const row of data.history.slice(0, 100000)) {
    counts.orders++;
    const result = auditCommissionRow(
      byId.has(row.resolved_partner_id)
        ? row
        : { ...row, resolved_partner_id: null },
    );
    if (result.severity)
      add(
        result.kind,
        row.resolved_partner_id,
        messages[result.kind],
        {
          orderId: row.order_id,
          code: row.partner_code,
          expected: result.expected,
          booked: result.booked,
        },
        result.severity,
      );
    else if (result.kind === "booked") counts.bookedOrders++;
    else if (result.kind === "pending") counts.pendingOrders++;
    else counts.notDueOrders++;
  }
  for (const row of data.orphans.slice(0, 1000))
    add(
      "orphan_booking",
      row.partner_id,
      "Provisionsbuchung ohne zugehörige Bestellung; Alt- oder Sonderfall prüfen.",
      {
        orderId: row.order_id ?? "Buchung " + row.id,
        booked: Number(row.amount),
        key: String(row.id),
      },
      "review",
    );
  for (const p of data.targets) {
    counts.codes += p.codes.length;
    if (p.isActive !== 1 || !p.program?.active) {
      counts.excludedCodes += p.codes.length;
      if (p.isActive === 1)
        add(
          "program_unavailable",
          p.id,
          "Aktiver Partner hat kein aktives, lesbares Programm.",
        );
      continue;
    }
    counts.activePartners++;
    if (!p.codes.some((c) => c.isActive))
      add(
        "no_active_code",
        p.id,
        "Aktiver Partner hat keinen aktiven öffentlichen Code.",
      );
    for (const code of p.codes) {
      if (!code.isActive) {
        counts.excludedCodes++;
        continue;
      }
      if (Date.now() > deadline) {
        complete = false;
        break;
      }
      if (!data.cart) {
        add(
          "checkout_unavailable",
          p.id,
          "Kein eindeutiger lieferbarer Vorschauartikel verfügbar.",
          { code: code.code },
        );
        continue;
      }
      const probes: Array<{
        label: string;
        email: string;
        discountEligible: boolean;
        commissionEligible: boolean;
      }> = [];
      const fresh = "ops-audit-" + randomUUID() + "@example.invalid";
      probes.push({
        label: "Anderer Neukunde",
        email: fresh,
        discountEligible: p.program.customerDiscountPolicy !== "own_email_only",
        commissionEligible: p.program.commissionPolicy !== "none",
      });
      if (p.program.customerDiscountPolicy === "own_email_only") {
        if (p.email) {
          const previouslyPaid = data.history.some(
            (o) =>
              o.paid_at &&
              PAID_ORDER_STATUSES.has(o.status) &&
              o.partner_code?.replace(/\s/g, "").toUpperCase() ===
                code.code.replace(/\s/g, "").toUpperCase() &&
              o.email?.trim().toLowerCase() === p.email!.trim().toLowerCase(),
          );
          probes.push({
            label: "Eigene E-Mail",
            email: p.email,
            discountEligible: !previouslyPaid,
            commissionEligible:
              p.program.commissionPolicy === "each_paid_code_order" ||
              (p.program.commissionPolicy === "first_paid_code_order" &&
                !previouslyPaid),
          });
        } else
          add(
            "owner_email_missing",
            p.id,
            "Eigennutzerregel benötigt eine hinterlegte Partner-E-Mail.",
            { code: code.code },
          );
      } else {
        const paid = data.history.find(
          (o) =>
            o.paid_at &&
            PAID_ORDER_STATUSES.has(o.status) &&
            o.partner_code?.replace(/\s/g, "").toUpperCase() ===
              code.code.replace(/\s/g, "").toUpperCase() &&
            o.email,
        );
        if (paid)
          probes.push({
            label: "Kunde mit bezahlter Codenutzung",
            email: paid.email,
            discountEligible:
              p.program.customerDiscountPolicy === "each_valid_code_use",
            commissionEligible:
              p.program.commissionPolicy === "each_paid_code_order",
          });
      }
      let passed = true;
      for (const probe of probes) {
        if (Date.now() > deadline) {
          complete = false;
          passed = false;
          break;
        }
        try {
          const preview = await simulateCheckout(
            {
              items: [data.cart],
              country: "Deutschland",
              partnerCode: code.code,
              contact: { email: probe.email, phone: "" },
            },
            req,
            res,
          );
          const validation = await withReadOnlyDatabase(() =>
            partnerRouter
              .createCaller({ req, res, user: null })
              .validateCode({ code: code.code, customerEmail: probe.email }),
          );
          const r = preview.partnerCustomerCheck;
          counts.checkoutCases++;
          if (
            !validation.valid ||
            !r ||
            r.codeId !== code.id ||
            r.partnerId !== p.id ||
            r.customerDiscountPercent !== code.customerDiscountPercent ||
            r.commissionPercent !== code.commissionPercent ||
            r.customerDiscountEligible !== probe.discountEligible ||
            validation.discountEligible !== probe.discountEligible ||
            validation.discountPercent !==
              (probe.discountEligible ? code.customerDiscountPercent : 0) ||
            r.eligible !== probe.commissionEligible ||
            !preview.available
          )
            throw Error(
              "Regel, Preisberechnung und öffentliche Codeprüfung stimmen nicht überein.",
            );
          cases.push({
            partnerId: p.id,
            code: code.code,
            case: probe.label,
            status: "passed",
            customerDiscountPercent: code.customerDiscountPercent,
            commissionPercent: code.commissionPercent,
            appliedDiscount: r.appliedCustomerDiscount,
            conditionalCommission: r.expectedAmount,
          });
        } catch (e) {
          const functional =
            e instanceof Error &&
            /Regel, Preisberechnung|PARTNER_CODE_UNGUELTIG/.test(e.message);
          if (!functional) complete = false;
          passed = false;
          add(
            functional ? "checkout_failed" : "checkout_unavailable",
            p.id,
            functional
              ? "Checkout-Prüfung für „" +
                  probe.label +
                  "“ fehlgeschlagen; Code und individuelle Regel prüfen."
              : "Prüffall „" +
                  probe.label +
                  "“ nicht ausführbar; Datenquelle oder Kundenvoraussetzungen prüfen.",
            { code: code.code, key: code.id + ":" + probe.label },
            functional ? "error" : "review",
          );
          cases.push({
            partnerId: p.id,
            code: code.code,
            case: probe.label,
            status: functional ? "failed" : "unavailable",
          });
        }
      }
      if (passed) counts.checkedCodes++;
    }
  }
  if (!complete)
    add(
      "incomplete",
      null,
      "Prüfung ist unvollständig; Quelle, Zeit- oder Mengengrenze prüfen.",
    );
  if (findings.length > 1000) {
    findings.length = 1000;
    complete = false;
  }
  return {
    version: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    complete,
    counts,
    findings,
    cases,
    cart: data.cart,
    sideEffects: false,
    limits: [
      "Keine Testbestellung oder Buchung. Checkout mit einem lieferbaren Vorschauartikel; keine Prüfung jeder Warenkorbvariante.",
      "Neukunde sowie vorhandene bezahlte Codenutzung; Eigennutzer mit eigener und fremder E-Mail. Keine Kunden-E-Mails im Prüfbericht.",
      "Gesamte zugeordnete Bestellhistorie, normale Provisionseinträge und gespeicherte Regeln; fehlende Altdaten bleiben offen.",
      "Neue Zahlung: bis zwei Minuten Wartezeit auf Buchung; danach fehlende Provision als Fehler. Keine automatische Reparatur.",
    ],
  };
}
