import { desc, eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { customers, duplicateCheckRuns, duplicateFindings, orderItems, orders, shopSettings } from "../drizzle/schema.js";

const PAID_STATUSES = new Set(["bezahlt", "gepackt", "versendet", "zugestellt"]);
const PLACEHOLDER_EMAILS = new Set(["keine@angabe.de", "noemail@noemail.de", "no@email.de", "noreply@noreply.de", "placeholder@placeholder.de", "test@test.de", "info@info.de"]);

const clean = (value?: string | null) => (value || "").trim().toLowerCase();
const phone = (value?: string | null) => clean(value).replace(/[^0-9+]/g, "");
const compact = (value?: string | null) => clean(value).replace(/[^a-z0-9äöüß]/g, "");
const emailUsable = (value?: string | null) => { const valueClean = clean(value); return !!valueClean && !PLACEHOLDER_EMAILS.has(valueClean); };

type Finding = {
  entityType: "customer" | "order";
  primaryRecordId: string;
  candidateRecordId: string;
  confidence: number;
  reasons: string[];
};

type CustomerCheckTrigger = "customer_created" | "customer_changed" | "order_customer_created" | "order_customer_changed";

function customerReasons(primary: typeof customers.$inferSelect, candidate: typeof customers.$inferSelect): { confidence: number; reasons: string[] } | null {
  if (primary.id === candidate.id) return null;
  const reasons: string[] = [];
  let confidence = 0;
  if (emailUsable(primary.email) && clean(primary.email) === clean(candidate.email)) {
    reasons.push("identische E-Mail-Adresse");
    confidence = 100;
  }
  if (phone(primary.phone).length >= 7 && phone(primary.phone) === phone(candidate.phone)) {
    reasons.push("identische Telefonnummer");
    confidence = Math.max(confidence, 96);
  }
  const sameDeliveryIdentity = compact(primary.name) && compact(primary.name) === compact(candidate.name)
    && compact(primary.street) && compact(primary.street) === compact(candidate.street)
    && compact(primary.houseNumber) === compact(candidate.houseNumber)
    && compact(primary.zip) && compact(primary.zip) === compact(candidate.zip);
  if (sameDeliveryIdentity) {
    reasons.push("gleicher Name und gleiche Lieferadresse");
    confidence = Math.max(confidence, 82);
  }
  return reasons.length ? { confidence, reasons } : null;
}

async function hasOpenFinding(primaryRecordId: string, candidateRecordId: string, entityType: "customer" | "order"): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select().from(duplicateFindings).where(eq(duplicateFindings.status, "open"));
  return rows.some((row) => row.entityType === entityType
    && ((row.primaryRecordId === primaryRecordId && row.candidateRecordId === candidateRecordId)
      || (row.primaryRecordId === candidateRecordId && row.candidateRecordId === primaryRecordId)));
}

async function writeRun(trigger: string, createdBy: string, findings: Finding[]): Promise<{ runId: number; totalFindings: number }> {
  const db = await getDb();
  if (!db) throw new Error("Datenbank nicht verfügbar");
  const startedAt = new Date();
  const [run] = await db.insert(duplicateCheckRuns).values({ trigger, status: "running", createdBy, startedAt }).returning();
  for (const finding of findings) {
    await db.insert(duplicateFindings).values({
      runId: run.id,
      entityType: finding.entityType,
      primaryRecordId: finding.primaryRecordId,
      candidateRecordId: finding.candidateRecordId,
      confidence: finding.confidence,
      reasons: JSON.stringify(finding.reasons),
    });
  }
  const customerFindings = findings.filter((finding) => finding.entityType === "customer").length;
  await db.update(duplicateCheckRuns).set({
    status: "completed",
    customerFindings,
    orderFindings: findings.length - customerFindings,
    completedAt: new Date(),
    summary: JSON.stringify({ scope: "changed_record_only", findings: findings.length }),
  }).where(eq(duplicateCheckRuns.id, run.id));
  return { runId: run.id, totalFindings: findings.length };
}

/**
 * Event-driven duplicate check: only the new or identity-relevant changed customer
 * is compared with the existing customer base. It never modifies customer/order data.
 */
export async function queueCustomerDuplicateReview(customerId: number, trigger: CustomerCheckTrigger, createdBy = "system") {
  const db = await getDb();
  if (!db) throw new Error("Datenbank nicht verfügbar");
  const [primary] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
  if (!primary) return { runId: null, totalFindings: 0 };

  const candidates = await db.select().from(customers);
  const findings: Finding[] = [];
  for (const candidate of candidates) {
    const match = customerReasons(primary, candidate);
    if (!match) continue;
    const primaryRecordId = String(primary.id);
    const candidateRecordId = String(candidate.id);
    if (await hasOpenFinding(primaryRecordId, candidateRecordId, "customer")) continue;
    findings.push({ entityType: "customer", primaryRecordId, candidateRecordId, ...match });
  }
  return writeRun(trigger, createdBy, findings);
}

/**
 * Retains previous global-scan results as history while clearing them from the active,
 * action-oriented queue after the switch to event-driven checks.
 */
export async function archiveLegacyDuplicateQueue(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const settings = Object.fromEntries((await db.select().from(shopSettings)).map((row) => [row.key, row.value]));
  if (settings.customer_integrity_event_queue_v2 === "true") return 0;
  const legacyRuns = await db.select().from(duplicateCheckRuns);
  const legacyRunIds = new Set(legacyRuns.filter((run) => run.trigger === "scheduled" || run.trigger === "manual").map((run) => run.id));
  const openFindings = await db.select().from(duplicateFindings).where(eq(duplicateFindings.status, "open"));
  let archived = 0;
  for (const finding of openFindings) {
    if (!legacyRunIds.has(finding.runId)) continue;
    await db.update(duplicateFindings).set({
      status: "archived",
      resolutionNote: "Altprüffall aus der früheren Gesamtsuche; zur Wahrung der Übersicht nicht mehr in der aktiven Warteschlange.",
    }).where(eq(duplicateFindings.id, finding.id));
    archived++;
  }
  await db.insert(shopSettings).values({ key: "customer_integrity_event_queue_v2", value: "true" })
    .onConflictDoUpdate({ target: shopSettings.key, set: { value: "true", updatedAt: new Date() } });
  return archived;
}

/**
 * Legacy full scan remains available only as a protected diagnostic operation.
 * It is intentionally not scheduled and not exposed in the daily WaWi workflow.
 */
export async function runDuplicateCheck(trigger: "manual", createdBy = "admin") {
  const db = await getDb();
  if (!db) throw new Error("Datenbank nicht verfügbar");
  const allCustomers = await db.select().from(customers);
  const allOrders = await db.select().from(orders).orderBy(desc(orders.orderDate));
  const allItems = await db.select().from(orderItems);
  const findings: Finding[] = [];
  const known = new Set<string>();
  const add = (finding: Finding) => {
    const [first, second] = [finding.primaryRecordId, finding.candidateRecordId].sort();
    const key = `${finding.entityType}:${first}:${second}`;
    if (!known.has(key)) { known.add(key); findings.push({ ...finding, primaryRecordId: first, candidateRecordId: second }); }
  };
  for (let index = 0; index < allCustomers.length; index++) {
    for (let candidateIndex = index + 1; candidateIndex < allCustomers.length; candidateIndex++) {
      const match = customerReasons(allCustomers[index], allCustomers[candidateIndex]);
      if (match) add({ entityType: "customer", primaryRecordId: String(allCustomers[index].id), candidateRecordId: String(allCustomers[candidateIndex].id), ...match });
    }
  }
  const fingerprint = (orderId: string) => allItems.filter((item) => item.orderId === orderId).map((item) => `${compact(item.name)}:${compact(item.dosage)}:${item.quantity}`).sort().join("|");
  for (let index = 0; index < allOrders.length; index++) {
    for (let candidateIndex = index + 1; candidateIndex < allOrders.length; candidateIndex++) {
      const first = allOrders[index]; const second = allOrders[candidateIndex];
      const sameOrder = emailUsable(first.email) && clean(first.email) === clean(second.email)
        && first.total === second.total && fingerprint(first.orderId) === fingerprint(second.orderId)
        && PAID_STATUSES.has(first.status) && PAID_STATUSES.has(second.status)
        && Math.abs(first.orderDate.getTime() - second.orderDate.getTime()) <= 24 * 3600000;
      if (sameOrder) add({ entityType: "order", primaryRecordId: first.orderId, candidateRecordId: second.orderId, confidence: 90, reasons: ["gleiche E-Mail, gleicher Warenkorb und gleicher Betrag innerhalb 24 Stunden"] });
    }
  }
  return writeRun(trigger, createdBy, findings);
}

/** The former daily scheduler is intentionally disabled; checks are event-driven now. */
export function startDuplicateCheckScheduler() {
  console.log("[Customer Integrity] Tägliche Gesamtsuche deaktiviert; Prüfung erfolgt nur bei neuen oder geänderten Kundendaten.");
}
