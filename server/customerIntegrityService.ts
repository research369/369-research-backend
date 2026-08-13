import { desc, eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { customers, duplicateCheckRuns, duplicateFindings, orderItems, orders, shopSettings } from "../drizzle/schema.js";

const PAID_STATUSES = new Set(["bezahlt", "gepackt", "versendet", "zugestellt"]);
const PLACEHOLDER_EMAILS = new Set(["keine@angabe.de", "noemail@noemail.de", "no@email.de", "noreply@noreply.de", "placeholder@placeholder.de", "test@test.de", "info@info.de"]);

const clean = (value?: string | null) => (value || "").trim().toLowerCase();
const phone = (value?: string | null) => clean(value).replace(/[^0-9+]/g, "");
const compact = (value?: string | null) => clean(value).replace(/[^a-z0-9äöüß]/g, "");
const emailUsable = (value?: string | null) => { const v = clean(value); return !!v && !PLACEHOLDER_EMAILS.has(v); };

function group<T>(rows: T[], key: (row: T) => string) {
  const result = new Map<string, T[]>();
  for (const row of rows) { const k = key(row); if (!k) continue; const list = result.get(k) || []; list.push(row); result.set(k, list); }
  return [...result.values()].filter(list => list.length > 1);
}

export async function runDuplicateCheck(trigger: "manual" | "scheduled", createdBy = "system") {
  const db = await getDb();
  if (!db) throw new Error("Datenbank nicht verfügbar");
  const startedAt = new Date();
  const [run] = await db.insert(duplicateCheckRuns).values({ trigger, status: "running", createdBy, startedAt }).returning();
  const allCustomers = await db.select().from(customers);
  const allOrders = await db.select().from(orders).orderBy(desc(orders.orderDate));
  const allItems = await db.select().from(orderItems);
  const findings: Array<{ entityType: "customer" | "order"; primaryRecordId: string; candidateRecordId: string; confidence: number; reasons: string[] }> = [];
  const known = new Set<string>();
  const add = (entityType: "customer" | "order", a: string, b: string, confidence: number, reasons: string[]) => {
    const [primaryRecordId, candidateRecordId] = [a, b].sort(); const key = `${entityType}:${primaryRecordId}:${candidateRecordId}`;
    if (!known.has(key)) { known.add(key); findings.push({ entityType, primaryRecordId, candidateRecordId, confidence, reasons }); }
  };
  for (const records of group(allCustomers.filter(c => emailUsable(c.email)), c => clean(c.email))) {
    for (let i = 0; i < records.length; i++) for (let j = i + 1; j < records.length; j++) add("customer", String(records[i].id), String(records[j].id), 100, ["identische E-Mail-Adresse"]);
  }
  for (const records of group(allCustomers.filter(c => phone(c.phone).length >= 7), c => phone(c.phone))) {
    for (let i = 0; i < records.length; i++) for (let j = i + 1; j < records.length; j++) add("customer", String(records[i].id), String(records[j].id), 96, ["identische Telefonnummer"]);
  }
  for (const records of group(allCustomers.filter(c => compact(c.name) && compact(c.street) && compact(c.zip)), c => `${compact(c.name)}|${compact(c.street)}|${compact(c.houseNumber)}|${compact(c.zip)}`)) {
    for (let i = 0; i < records.length; i++) for (let j = i + 1; j < records.length; j++) add("customer", String(records[i].id), String(records[j].id), 82, ["gleicher Name und gleiche Lieferadresse"]);
  }
  const itemFingerprint = (orderId: string) => allItems.filter(i => i.orderId === orderId).map(i => `${compact(i.name)}:${compact(i.dosage)}:${i.quantity}`).sort().join("|");
  const orderGroups = group(allOrders.filter(o => emailUsable(o.email) && PAID_STATUSES.has(o.status)), o => `${clean(o.email)}|${o.total}|${itemFingerprint(o.orderId)}`);
  for (const records of orderGroups) {
    for (let i = 0; i < records.length; i++) for (let j = i + 1; j < records.length; j++) {
      const hours = Math.abs(records[i].orderDate.getTime() - records[j].orderDate.getTime()) / 3600000;
      if (hours <= 24) add("order", records[i].orderId, records[j].orderId, 90, ["gleiche E-Mail, gleicher Warenkorb und gleicher Betrag innerhalb 24 Stunden"]);
    }
  }
  for (const finding of findings) await db.insert(duplicateFindings).values({ runId: run.id, entityType: finding.entityType, primaryRecordId: finding.primaryRecordId, candidateRecordId: finding.candidateRecordId, confidence: finding.confidence, reasons: JSON.stringify(finding.reasons) });
  const customerFindings = findings.filter(f => f.entityType === "customer").length;
  const orderFindings = findings.length - customerFindings;
  await db.update(duplicateCheckRuns).set({ status: "completed", customerFindings, orderFindings, completedAt: new Date(), summary: JSON.stringify({ reviewedRecords: { customers: allCustomers.length, orders: allOrders.length }, findings: findings.length }) }).where(eq(duplicateCheckRuns.id, run.id));
  await db.insert(shopSettings).values({ key: "customer_integrity_last_run", value: new Date().toISOString() }).onConflictDoUpdate({ target: shopSettings.key, set: { value: new Date().toISOString(), updatedAt: new Date() } });
  return { runId: run.id, customerFindings, orderFindings, totalFindings: findings.length };
}

let timer: NodeJS.Timeout | undefined;
export function startDuplicateCheckScheduler() {
  if (timer) return;
  const tick = async () => {
    const db = await getDb(); if (!db) return;
    const rows = await db.select().from(shopSettings);
    const config = Object.fromEntries(rows.map(r => [r.key, r.value]));
    if (config.customer_integrity_enabled === "false") return;
    const hour = Number(config.customer_integrity_schedule_hour || "3");
    const now = new Date(); const today = now.toISOString().slice(0, 10);
    if (now.getHours() !== hour || config.customer_integrity_last_run?.slice(0, 10) === today) return;
    await runDuplicateCheck("scheduled", "scheduler");
  };
  timer = setInterval(() => void tick().catch(e => console.error("[Customer Integrity] Scheduler", e)), 15 * 60 * 1000);
  void tick();
}
