/**
 * Follow-Up Router – Cross-Sell Follow-ups nach Versand
 *
 * Logik:
 * - 7 Tage nach shipped_at wird automatisch ein Follow-up erstellt
 * - Nur 1 Follow-up pro Bestellung (unique constraint auf order_id)
 * - Individueller 48h-Rabattcode pro Follow-up (AGAIN-[ORDERNR]-[4CHARS])
 * - Code wird erst beim Klick auf "Nachricht generieren" erzeugt
 * - Gültiger Code wird wiederverwendet, abgelaufener Code gibt Warnung zurück
 */
import { z } from "zod";
import { eq, and, lte, isNull, desc, or, inArray, ne } from "drizzle-orm";
import { router, adminProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { ENV } from "./env.js";
import {
  salesFollowups,
  salesFollowupProducts,
  orders,
  orderItems,
  articles,
  customers,
  promoCodes,
} from "../drizzle/schema.js";

const RESEND_API_URL = "https://api.resend.com/emails";
const SHOP_BASE_URL = "https://www.369research.eu";

/**
 * Zentrale Konfiguration – alle Parameter hier ändern, nirgendwo sonst hardcoden
 */
const FOLLOWUP_CONFIG = {
  discountPercent: 10,          // Rabatt in Prozent
  codeValidityHours: 48,        // Gültigkeit des Codes in Stunden
  reminderDaysAfterShipping: 7, // Tage nach Versand bis Follow-up fällig
  defaultReminderStage: 1,      // Erste Stufe (für spätere Erweiterung: 1, 2, 3)
  codePrefix: "AGAIN",          // Prefix für generierten Code
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalisiert Telefonnummern auf +49-Format für WhatsApp-Links */
function normalizePhone(phone: string): string {
  if (!phone) return "";
  let p = phone.replace(/[\s\-\.\(\)\/]/g, "");
  if (p.startsWith("0049")) p = "+49" + p.slice(4);
  else if (p.startsWith("00")) p = "+" + p.slice(2);
  else if (p.startsWith("0")) p = "+49" + p.slice(1);
  else if (!p.startsWith("+")) p = "+49" + p;
  return p;
}

/**
 * Generiert einen eindeutigen individuellen Rabattcode für ein Follow-up.
 * Format: AGAIN-[BESTELLNUMMER]-[4CHARS]
 * Beispiel: AGAIN-369-10145-X7K2
 * Nur Großbuchstaben und Zahlen, keine Sonderzeichen außer Bindestrichen.
 */
function generateCodeForOrder(orderId: string): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ohne O, I, 0, 1 (Verwechslungsgefahr)
  let suffix = "";
  for (let i = 0; i < 4; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  // Bestellnummer bereinigen: nur Buchstaben, Zahlen, Bindestriche
  const cleanOrderId = orderId.replace(/[^A-Z0-9\-]/gi, "").toUpperCase();
  return `${FOLLOWUP_CONFIG.codePrefix}-${cleanOrderId}-${suffix}`;
}

/**
 * Erstellt einen individuellen Promo-Code in der DB und verknüpft ihn mit dem Follow-up.
 * Gibt den erstellten Code zurück.
 */
async function createIndividualCode(db: any, followupId: number, orderId: string): Promise<{
  code: string;
  promoCodeId: number;
  expiresAt: Date;
}> {
  const expiresAt = new Date(Date.now() + FOLLOWUP_CONFIG.codeValidityHours * 60 * 60 * 1000);
  const now = new Date();

  // Eindeutigen Code generieren (Kollisions-Check)
  let code = generateCodeForOrder(orderId);
  let attempts = 0;
  while (attempts < 5) {
    const existing = await db
      .select({ id: promoCodes.id })
      .from(promoCodes)
      .where(eq(promoCodes.code, code))
      .limit(1);
    if (existing.length === 0) break;
    code = generateCodeForOrder(orderId); // Neuen Code generieren bei Kollision
    attempts++;
  }

  // Code in promo_codes anlegen
  const [inserted] = await db.insert(promoCodes).values({
    code,
    discountType: "percent",
    percentage: String(FOLLOWUP_CONFIG.discountPercent),
    fixedAmount: "0",
    minOrder: "0",
    maxUses: 1,       // Einmalig nutzbar
    currentUses: 0,
    validFrom: now,
    validUntil: expiresAt,
    isActive: 1,
    description: `Follow-up Code für Bestellung ${orderId} – ${FOLLOWUP_CONFIG.discountPercent}% Rabatt, gültig ${FOLLOWUP_CONFIG.codeValidityHours}h`,
  }).returning({ id: promoCodes.id });

  const promoCodeId = inserted.id;

  // Code im Follow-up speichern
  await db
    .update(salesFollowups)
    .set({
      promoCodeId,
      discountCode: code,
      codeCreatedAt: now,
      codeExpiresAt: expiresAt,
      updatedAt: now,
    })
    .where(eq(salesFollowups.id, followupId));

  console.log(`[FollowUp] Individueller Code ${code} erstellt für Follow-up ${followupId} (Order ${orderId}), gültig bis ${expiresAt.toISOString()}`);
  return { code, promoCodeId, expiresAt };
}

/** Lädt alle Bestellungen eines Kunden (Matching: customerId → email → phone) */
async function getCustomerOrderHistory(db: any, order: any): Promise<any[]> {
  const conditions: any[] = [];

  // Primär: customer_id
  if (order.customerId) {
    conditions.push(eq(orders.customerId, order.customerId));
  }

  // Fallback: E-Mail
  const email = (order.email || "").toLowerCase().trim();
  const PLACEHOLDER_EMAILS = new Set([
    "keine@angabe.de", "noemail@noemail.de", "no@email.de",
    "noreply@noreply.de", "placeholder@placeholder.de", "test@test.de",
  ]);
  if (email && !PLACEHOLDER_EMAILS.has(email)) {
    conditions.push(eq(orders.email, order.email));
  }

  if (conditions.length === 0) {
    return [order]; // Nur die Ursprungsbestellung
  }

  const allOrders = await db
    .select()
    .from(orders)
    .where(or(...conditions))
    .orderBy(desc(orders.orderDate));

  // Deduplizieren nach orderId
  const seen = new Set<string>();
  return allOrders.filter((o: any) => {
    if (seen.has(o.orderId)) return false;
    seen.add(o.orderId);
    return true;
  });
}

/** Generiert WhatsApp-Nachricht – entweder mit echtem Code oder Platzhalter */
function generateWhatsAppMessage(
  order: any,
  selectedArticles: any[],
  promoCode: string,
  codeExpiresAt: Date | null
): string {
  const firstName = order.firstName || order.first_name || "";
  const orderDate = order.orderDate
    ? new Date(order.orderDate).toLocaleDateString("de-DE")
    : "";

  const expiryStr = codeExpiresAt
    ? codeExpiresAt.toLocaleDateString("de-DE", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      })
    : "[ABLAUFDATUM]";

  const productLines = selectedArticles
    .map((a) => {
      const slug = a.shopProductId || "";
      const link = slug ? `${SHOP_BASE_URL}/product/${slug}` : SHOP_BASE_URL;
      const price = a.sellingPrice ? `${parseFloat(a.sellingPrice).toFixed(2).replace(".", ",")} €` : "";
      return `• ${a.name}${price ? ` (${price})` : ""}\n  ${link}`;
    })
    .join("\n");

  return `Hallo ${firstName},

wir hoffen, du bist zufrieden mit deiner Bestellung vom ${orderDate}! 🙏

Als Dankeschön für dein Vertrauen möchten wir dir heute einige Produkte vorstellen, die hervorragend zu deiner bisherigen Forschung passen könnten:

${productLines}

Mit dem Code *${promoCode}* erhältst du *${FOLLOWUP_CONFIG.discountPercent}% Rabatt* auf deine nächste Bestellung – einfach im Checkout eingeben.

⏳ _Dieser Code ist nur für dich und nur bis ${expiryStr} Uhr gültig._

Alle Produkte sind ausschließlich für In-vitro-Forschungszwecke bestimmt.

Bei Fragen stehen wir dir jederzeit zur Verfügung. 🔬

Viele Grüße,
Dein 369 Research Team`;
}

/** Generiert E-Mail-Betreff und -Body – entweder mit echtem Code oder Platzhalter */
function generateEmailContent(
  order: any,
  selectedArticles: any[],
  promoCode: string,
  codeExpiresAt: Date | null
): { subject: string; body: string } {
  const firstName = order.firstName || order.first_name || "";
  const orderDate = order.orderDate
    ? new Date(order.orderDate).toLocaleDateString("de-DE")
    : "";

  const expiryStr = codeExpiresAt
    ? codeExpiresAt.toLocaleDateString("de-DE", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      })
    : "[ABLAUFDATUM]";

  const productRows = selectedArticles
    .map((a) => {
      const slug = a.shopProductId || "";
      const link = slug ? `${SHOP_BASE_URL}/product/${slug}` : SHOP_BASE_URL;
      const price = a.sellingPrice
        ? `${parseFloat(a.sellingPrice).toFixed(2).replace(".", ",")} €`
        : "";
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">
          <a href="${link}" style="color:#0040C1;text-decoration:none;font-weight:600;">${a.name}</a>
          ${a.category ? `<br><span style="color:#64748b;font-size:12px;">${a.category}</span>` : ""}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;white-space:nowrap;">${price}</td>
      </tr>`;
    })
    .join("");

  const subject = `Dein exklusives Angebot von 369 Research – ${FOLLOWUP_CONFIG.discountPercent}% Rabatt für dich`;

  const body = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f7f9fc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <!-- Header -->
    <div style="background:#0A1628;padding:32px 40px;text-align:center;">
      <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700;letter-spacing:-0.5px;">369 Research</h1>
      <p style="color:#6B9FFF;margin:8px 0 0;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;">Premium Research Peptides</p>
    </div>
    <!-- Body -->
    <div style="padding:40px;">
      <p style="color:#1A1A2E;font-size:16px;margin:0 0 8px;">Hallo ${firstName},</p>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 24px;">
        wir hoffen, du bist zufrieden mit deiner Bestellung vom <strong>${orderDate}</strong>!
        Als Dankeschön für dein Vertrauen möchten wir dir heute einige Produkte vorstellen,
        die hervorragend zu deiner bisherigen Forschung passen könnten.
      </p>
      <!-- Products -->
      <h2 style="color:#1A1A2E;font-size:16px;font-weight:700;margin:0 0 16px;">Empfehlungen für dich</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <thead>
          <tr style="background:#f7f9fc;">
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Produkt</th>
            <th style="padding:8px 12px;text-align:right;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Preis</th>
          </tr>
        </thead>
        <tbody>${productRows}</tbody>
      </table>
      <!-- Promo Code -->
      <div style="background:#f0f7ff;border:2px dashed #0040C1;border-radius:8px;padding:20px;text-align:center;margin-bottom:16px;">
        <p style="color:#475569;font-size:14px;margin:0 0 8px;">Dein persönlicher Rabattcode</p>
        <p style="color:#0040C1;font-size:28px;font-weight:800;letter-spacing:0.1em;margin:0 0 8px;">${promoCode}</p>
        <p style="color:#475569;font-size:14px;margin:0;"><strong>${FOLLOWUP_CONFIG.discountPercent}% Rabatt</strong> auf deine nächste Bestellung</p>
      </div>
      <p style="color:#ef4444;font-size:13px;text-align:center;margin:0 0 24px;">
        ⏳ Dieser Code ist nur für dich und nur bis <strong>${expiryStr} Uhr</strong> gültig.
      </p>
      <div style="text-align:center;margin-bottom:24px;">
        <a href="${SHOP_BASE_URL}" style="display:inline-block;background:#0040C1;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;">Jetzt shoppen →</a>
      </div>
      <!-- Disclaimer -->
      <p style="color:#94a3b8;font-size:12px;line-height:1.5;border-top:1px solid #f0f0f0;padding-top:16px;margin:0;">
        Alle Produkte sind ausschließlich für In-vitro-Forschungs- und Laborzwecke bestimmt.
        Nicht für den menschlichen oder tierärztlichen Verzehr.
      </p>
    </div>
    <!-- Footer -->
    <div style="background:#f7f9fc;padding:20px 40px;text-align:center;">
      <p style="color:#94a3b8;font-size:12px;margin:0;">369 Research · <a href="${SHOP_BASE_URL}" style="color:#0040C1;">www.369research.eu</a></p>
    </div>
  </div>
</body>
</html>`;

  return { subject, body };
}

// ─── Cross-Sell Empfehlungs-Matrix ──────────────────────────────────────────

/**
 * Empfehlungs-Matrix: Welche Kategorien werden für welche Ursprungskategorie empfohlen?
 * Reihenfolge = Priorität (Index 0 = höchste Priorität)
 */
const CROSS_SELL_MATRIX: Record<string, string[]> = {
  intake:       ["output", "regeneration"],
  output:       ["intake", "signaling"],
  regeneration: ["regeneration", "signaling"],
  signaling:    ["signaling", "regeneration"],
  structural:   ["regeneration", "signaling"],
};

/**
 * Begründungs-Texte für Empfehlungen
 */
const CROSS_SELL_REASONS: Record<string, Record<string, string>> = {
  intake: {
    output:       "Ergänzt deinen GLP-1/Intake-Stack optimal – Output-Peptide verstärken die metabolische Wirkung.",
    regeneration: "Regenerations-Peptide unterstützen die Gewebereparatur während der Intake-Phase.",
  },
  output: {
    intake:    "SLU-PP-332 und GLP-1 wirken synergistisch – Intake-Peptide optimieren den Output-Effekt.",
    signaling: "Signaling-Peptide verbessern die Zellkommunikation und verstärken Output-Ergebnisse.",
  },
  regeneration: {
    regeneration: "Kombinierte Regenerations-Peptide (z.B. BPC-157 + TB-500) zeigen synergistische Wirkung.",
    signaling:    "Signaling-Peptide beschleunigen die Regeneration durch verbesserte Zellkommunikation.",
  },
  signaling: {
    signaling:    "Mehrere Signaling-Peptide können kombiniert werden für breiteres Wirkspektrum.",
    regeneration: "Regenerations-Peptide ergänzen Signaling-Stacks für umfassendere Forschungsergebnisse.",
  },
  structural: {
    regeneration: "Regenerations-Peptide unterstützen strukturelle Prozesse auf Gewebeebene.",
    signaling:    "Signaling-Peptide optimieren die strukturelle Peptid-Wirkung.",
  },
};

/**
 * Berechnet Cross-Sell Empfehlungen basierend auf gekauften Artikeln.
 * Gibt max. 2 Vorschläge zurück, keine bereits gekauften Produkte.
 */
function computeCrossSellRecommendations(
  boughtArticles: Array<{ id: number; name: string; followUpCategory: string | null }>,
  availableArticles: Array<{
    id: number;
    name: string;
    sellingPrice: number;
    shopProductId: string | null;
    category: string | null;
    followUpCategory: string | null;
    stock: number;
    alreadyBought: boolean;
  }>
): Array<{
  articleId: number;
  name: string;
  sellingPrice: number;
  shopProductId: string | null;
  category: string | null;
  followUpCategory: string | null;
  stock: number;
  reason: string;
  priority: number;
}> {
  // Kategorien der gekauften Artikel
  const boughtCategories = new Set(
    boughtArticles
      .map((a) => a.followUpCategory)
      .filter((c): c is string => !!c)
  );

  // Bereits gekaufte Artikel-IDs
  const boughtIds = new Set(boughtArticles.map((a) => a.id));

  // Kandidaten: nicht gekauft, auf Lager, hat followUpCategory
  const candidates = availableArticles.filter(
    (a) => !a.alreadyBought && !boughtIds.has(a.id) && a.followUpCategory && a.stock > 0
  );

  if (candidates.length === 0) return [];

  // Scoring: Priorität basierend auf Matrix
  const scored: Array<{ article: typeof candidates[0]; score: number; reason: string }> = [];

  for (const candidate of candidates) {
    const candidateCat = candidate.followUpCategory!;
    let bestScore = -1;
    let bestReason = "Ergänzt deine bisherige Forschung sinnvoll.";

    for (const boughtCat of boughtCategories) {
      const matrixPriorities = CROSS_SELL_MATRIX[boughtCat] || [];
      const idx = matrixPriorities.indexOf(candidateCat);
      if (idx >= 0) {
        // Score: höher = besser (Index 0 = Prio 1 = Score 10, Index 1 = Score 5)
        const score = idx === 0 ? 10 : 5;
        if (score > bestScore) {
          bestScore = score;
          const reasons = CROSS_SELL_REASONS[boughtCat]?.[candidateCat];
          if (reasons) bestReason = reasons;
        }
      }
    }

    if (bestScore >= 0) {
      scored.push({ article: candidate, score: bestScore, reason: bestReason });
    }
  }

  // Nach Score sortieren, dann nach Preis (teurer = besser bei gleichem Score)
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.article.sellingPrice - a.article.sellingPrice;
  });

  // Keine doppelten Kategorien (max 1 pro Kategorie)
  const usedCategories = new Set<string>();
  const result: ReturnType<typeof computeCrossSellRecommendations> = [];

  for (const { article, score, reason } of scored) {
    if (result.length >= 2) break;
    const cat = article.followUpCategory!;
    if (usedCategories.has(cat)) continue;
    usedCategories.add(cat);
    result.push({
      articleId: article.id,
      name: article.name,
      sellingPrice: article.sellingPrice,
      shopProductId: article.shopProductId,
      category: article.category,
      followUpCategory: article.followUpCategory,
      stock: article.stock,
      reason,
      priority: score,
    });
  }

  return result;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const followUpRouter = router({
  /**
   * Erstellt fehlende Follow-ups für alle versendeten Bestellungen
   * die shipped_at + FOLLOWUP_CONFIG.reminderDaysAfterShipping Tage überschritten haben.
   * Wird beim Dashboard-Load aufgerufen (idempotent).
   * KEIN automatischer Code-Aufruf – Code wird erst bei "Nachricht generieren" erstellt.
   */
  createMissingFollowUps: adminProcedure.mutation(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const cutoff = new Date(
      Date.now() - FOLLOWUP_CONFIG.reminderDaysAfterShipping * 24 * 60 * 60 * 1000
    );

    // Alle versendeten Bestellungen mit shipped_at <= cutoff
    const shippedOrders = await db
      .select({ orderId: orders.orderId, shippedAt: orders.shippedAt })
      .from(orders)
      .where(
        and(
          eq(orders.status, "versendet"),
          lte(orders.shippedAt, cutoff)
        )
      );

    if (shippedOrders.length === 0) return { created: 0 };

    // Bestehende Follow-up order_ids laden
    const existingFollowUps = await db
      .select({ orderId: salesFollowups.orderId })
      .from(salesFollowups);
    const existingOrderIds = new Set(existingFollowUps.map((f: any) => f.orderId));

    let created = 0;
    for (const o of shippedOrders) {
      if (existingOrderIds.has(o.orderId)) continue;

      if (!o.shippedAt) continue;
      const dueAt = new Date(
        new Date(o.shippedAt).getTime() +
        FOLLOWUP_CONFIG.reminderDaysAfterShipping * 24 * 60 * 60 * 1000
      );

      try {
        await db.insert(salesFollowups).values({
          orderId: o.orderId,
          status: "pending",
          dueAt,
          reminderStage: FOLLOWUP_CONFIG.defaultReminderStage,
        });
        created++;
      } catch (err: any) {
        // unique constraint violation = already exists, skip
        if (!err.message?.includes("unique") && !err.message?.includes("duplicate")) {
          console.error(`[FollowUp] Failed to create follow-up for ${o.orderId}:`, err.message);
        }
      }
    }

    if (created > 0) {
      console.log(`[FollowUp] Created ${created} new follow-ups`);
    }

    return { created };
  }),

  /**
   * Listet alle fälligen Follow-ups mit Bestelldaten und Kundendaten
   */
  listDueFollowUps: adminProcedure
    .input(z.object({
      status: z.enum(["pending", "done", "skipped", "all"]).optional().default("pending"),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const now = new Date();

      const allFollowUps = await db
        .select()
        .from(salesFollowups)
        .orderBy(desc(salesFollowups.dueAt));

      // Filtern
      const filtered = allFollowUps.filter((f: any) => {
        if (input.status === "all") return true;
        return f.status === input.status;
      });

      if (filtered.length === 0) return [];

      // Bestelldaten laden
      const orderIds = filtered.map((f: any) => f.orderId);
      const orderList = await db
        .select()
        .from(orders)
        .where(inArray(orders.orderId, orderIds));
      const orderMap = new Map(orderList.map((o: any) => [o.orderId, o]));

      return filtered.map((f: any) => {
        const order = orderMap.get(f.orderId) || {};
        const isOverdue = f.status === "pending" && new Date(f.dueAt) < now;
        const codeExpired = f.discountCode && f.codeExpiresAt
          ? new Date(f.codeExpiresAt) < now
          : false;
        return {
          id: f.id,
          orderId: f.orderId,
          status: f.status,
          dueAt: f.dueAt,
          completedAt: f.completedAt,
          skippedAt: f.skippedAt,
          isOverdue,
          reminderStage: f.reminderStage || 1,
          // Code-Info
          discountCode: f.discountCode || null,
          codeExpiresAt: f.codeExpiresAt || null,
          codeExpired,
          messageGeneratedAt: f.messageGeneratedAt || null,
          // Bestelldaten
          orderDate: order.orderDate,
          total: order.total ? parseFloat(order.total) : 0,
          // Kundendaten (aus Bestellung)
          customerName: `${order.firstName || ""} ${order.lastName || ""}`.trim(),
          customerEmail: order.email || "",
          customerPhone: order.phone || "",
          customerId: order.customerId,
          discountCodeUsed: order.discountCode,
          partnerCode: order.partnerCode,
          trackingNumber: order.trackingNumber,
          shippedAt: order.shippedAt,
        };
      });
    }),

  /**
   * Dashboard-Statistiken für das Widget
   */
  dashboardStats: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    const allPending = await db
      .select({ id: salesFollowups.id, dueAt: salesFollowups.dueAt })
      .from(salesFollowups)
      .where(eq(salesFollowups.status, "pending"));

    const dueTodayCount = allPending.filter((f: any) => {
      const due = new Date(f.dueAt);
      return due >= todayStart && due < todayEnd;
    }).length;

    const overdueCount = allPending.filter((f: any) => {
      return new Date(f.dueAt) < todayStart;
    }).length;

    const totalPending = allPending.length;

    return { dueTodayCount, overdueCount, totalPending };
  }),

  /**
   * Vollständige Detailansicht eines Follow-ups inkl. Bestellhistorie
   */
  getFollowUpDetail: adminProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const now = new Date();

      // Follow-up laden
      const [followUp] = await db
        .select()
        .from(salesFollowups)
        .where(eq(salesFollowups.id, input.id))
        .limit(1);

      if (!followUp) throw new Error("Follow-up nicht gefunden");

      // Code-Status berechnen
      const codeExpired = followUp.discountCode && followUp.codeExpiresAt
        ? new Date(followUp.codeExpiresAt) < now
        : false;

      // Ursprungsbestellung laden
      const [originOrder] = await db
        .select()
        .from(orders)
        .where(eq(orders.orderId, followUp.orderId))
        .limit(1);

      if (!originOrder) throw new Error("Ursprungsbestellung nicht gefunden");

      // Artikel der Ursprungsbestellung
      const originItems = await db
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, followUp.orderId));

      // Vollständige Bestellhistorie des Kunden
      const allCustomerOrders = await getCustomerOrderHistory(db, originOrder);

      // Für jede Bestellung die Items laden
      const allOrderIds = allCustomerOrders.map((o: any) => o.orderId);
      const allItems = allOrderIds.length > 0
        ? await db.select().from(orderItems).where(inArray(orderItems.orderId, allOrderIds))
        : [];

      // Items nach orderId gruppieren
      const itemsByOrder = new Map<string, any[]>();
      for (const item of allItems) {
        if (!itemsByOrder.has(item.orderId)) itemsByOrder.set(item.orderId, []);
        itemsByOrder.get(item.orderId)!.push(item);
      }

      // Statistiken
      const nonCancelledOrders = allCustomerOrders.filter((o: any) => o.status !== "storniert");
      const totalSpent = nonCancelledOrders.reduce(
        (sum: number, o: any) => sum + parseFloat(o.total || "0"),
        0
      );

      // Alle gekauften Artikel-IDs sammeln
      const boughtArticleIds = new Set<number>();
      for (const item of allItems) {
        if (item.articleId) boughtArticleIds.add(item.articleId);
      }

      // Ausgewählte Produkte für dieses Follow-up
      const selectedProducts = await db
        .select({
          id: salesFollowupProducts.id,
          articleId: salesFollowupProducts.articleId,
          name: articles.name,
          sellingPrice: articles.sellingPrice,
          shopProductId: articles.shopProductId,
          category: articles.category,
          stock: articles.stock,
        })
        .from(salesFollowupProducts)
        .leftJoin(articles, eq(salesFollowupProducts.articleId, articles.id))
        .where(eq(salesFollowupProducts.followupId, input.id));

      return {
        followUp: {
          ...followUp,
          codeExpired,
        },
        originOrder: {
          ...originOrder,
          items: originItems,
        },
        customerHistory: allCustomerOrders.map((o: any) => ({
          ...o,
          items: itemsByOrder.get(o.orderId) || [],
        })),
        stats: {
          totalOrders: allCustomerOrders.length,
          totalSpent,
          boughtArticleIds: Array.from(boughtArticleIds),
        },
        selectedProducts,
      };
    }),

  /**
   * Produkte für ein Follow-up auswählen (ersetzt bestehende Auswahl)
   */
  selectProducts: adminProcedure
    .input(z.object({
      followupId: z.number(),
      articleIds: z.array(z.number()),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Alte Auswahl löschen
      await db
        .delete(salesFollowupProducts)
        .where(eq(salesFollowupProducts.followupId, input.followupId));

      // Neue Auswahl speichern
      if (input.articleIds.length > 0) {
        await db.insert(salesFollowupProducts).values(
          input.articleIds.map((articleId) => ({
            followupId: input.followupId,
            articleId,
          }))
        );
      }

      return { ok: true };
    }),

  /**
   * Nachrichten generieren (WhatsApp + E-Mail) mit Platzhalter [DISCOUNT_CODE].
   *
   * WICHTIG: Kein Code wird hier erstellt!
   * Der Code wird erst beim Klick auf "WhatsApp öffnen" oder "E-Mail senden" erstellt
   * via resolveCode Prozedur. So startet die 48h-Gültigkeit exakt beim Kundenkontakt.
   */
  generateMessages: adminProcedure
    .input(z.object({ followupId: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const now = new Date();

      // Follow-up laden
      const [followUp] = await db
        .select()
        .from(salesFollowups)
        .where(eq(salesFollowups.id, input.followupId))
        .limit(1);
      if (!followUp) throw new Error("Follow-up nicht gefunden");

      // Ursprungsbestellung laden
      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.orderId, followUp.orderId))
        .limit(1);
      if (!order) throw new Error("Bestellung nicht gefunden");

      // Ausgewählte Produkte laden
      const selectedProducts = await db
        .select({
          id: articles.id,
          name: articles.name,
          sellingPrice: articles.sellingPrice,
          shopProductId: articles.shopProductId,
          category: articles.category,
        })
        .from(salesFollowupProducts)
        .leftJoin(articles, eq(salesFollowupProducts.articleId, articles.id))
        .where(eq(salesFollowupProducts.followupId, input.followupId));

      if (selectedProducts.length === 0) {
        throw new Error("Keine Produkte ausgewählt. Bitte zuerst Produkte auswählen.");
      }

      // Nachrichten mit Platzhalter generieren – KEIN Code-Erstellen hier
      const whatsappMessage = generateWhatsAppMessage(order, selectedProducts, "[DISCOUNT_CODE]", null);
      const { subject, body } = generateEmailContent(order, selectedProducts, "[DISCOUNT_CODE]", null);

      // Platzhalter-Text im Follow-up speichern
      await db
        .update(salesFollowups)
        .set({
          whatsappMessage,
          emailSubject: subject,
          emailBody: body,
          messageGeneratedAt: now,
          updatedAt: now,
        })
        .where(eq(salesFollowups.id, input.followupId));

      console.log(`[FollowUp] Nachrichten mit Platzhalter generiert für Follow-up ${input.followupId} – Code wird erst bei Versand erstellt`);

      return {
        whatsappMessage,
        emailSubject: subject,
        emailBody: body,
        // Kein Code hier – wird erst bei resolveCode erstellt
        hasCode: false,
        discountCode: followUp.discountCode || null,
        codeExpiresAt: followUp.codeExpiresAt || null,
        codeExpired: followUp.discountCode && followUp.codeExpiresAt
          ? new Date(followUp.codeExpiresAt) < now
          : false,
      };
    }),

  /**
   * Code auflösen und Platzhalter ersetzen.
   *
   * Wird aufgerufen wenn der Nutzer auf "WhatsApp öffnen" oder "E-Mail senden" klickt.
   * Logik:
   * 1. Gültiger Code vorhanden → wiederverwenden
   * 2. Kein Code oder Code abgelaufen → neuen Code erstellen
   * 3. Platzhalter [DISCOUNT_CODE] in gespeicherten Nachrichten ersetzen
   * 4. Finale Nachrichten zurückgeben
   */
  resolveCode: adminProcedure
    .input(z.object({ followupId: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const now = new Date();

      // Follow-up laden
      const [followUp] = await db
        .select()
        .from(salesFollowups)
        .where(eq(salesFollowups.id, input.followupId))
        .limit(1);
      if (!followUp) throw new Error("Follow-up nicht gefunden");

      if (!followUp.whatsappMessage) {
        throw new Error("Nachrichten noch nicht generiert. Bitte zuerst 'Nachricht generieren' klicken.");
      }

      // Ursprungsbestellung laden (für Nachricht-Regenerierung)
      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.orderId, followUp.orderId))
        .limit(1);
      if (!order) throw new Error("Bestellung nicht gefunden");

      // Ausgewählte Produkte laden
      const selectedProducts = await db
        .select({
          id: articles.id,
          name: articles.name,
          sellingPrice: articles.sellingPrice,
          shopProductId: articles.shopProductId,
          category: articles.category,
        })
        .from(salesFollowupProducts)
        .leftJoin(articles, eq(salesFollowupProducts.articleId, articles.id))
        .where(eq(salesFollowupProducts.followupId, input.followupId));

      // ── Code-Logik ──────────────────────────────────────────────────────────
      let promoCode: string;
      let codeExpiresAt: Date;
      let isNewCode = false;

      if (followUp.discountCode && followUp.codeExpiresAt) {
        const expiry = new Date(followUp.codeExpiresAt);
        if (expiry > now) {
          // Gültiger Code vorhanden → wiederverwenden
          promoCode = followUp.discountCode;
          codeExpiresAt = expiry;
          console.log(`[FollowUp] Bestehenden Code ${promoCode} wiederverwendet für Follow-up ${input.followupId}`);
        } else {
          // Code abgelaufen → neuen Code erstellen (Nutzer hat bereits auf Aktion geklickt)
          const result = await createIndividualCode(db, input.followupId, followUp.orderId);
          promoCode = result.code;
          codeExpiresAt = result.expiresAt;
          isNewCode = true;
          console.log(`[FollowUp] Neuer Code ${promoCode} erstellt (alter Code abgelaufen) für Follow-up ${input.followupId}`);
        }
      } else {
        // Kein Code vorhanden → neuen Code erstellen
        const result = await createIndividualCode(db, input.followupId, followUp.orderId);
        promoCode = result.code;
        codeExpiresAt = result.expiresAt;
        isNewCode = true;
        console.log(`[FollowUp] Erster Code ${promoCode} erstellt für Follow-up ${input.followupId}`);
      }

      // Platzhalter in gespeicherten Nachrichten ersetzen
      const finalWhatsApp = generateWhatsAppMessage(order, selectedProducts, promoCode, codeExpiresAt);
      const { subject: finalSubject, body: finalBody } = generateEmailContent(order, selectedProducts, promoCode, codeExpiresAt);

      // Finale Nachrichten in DB speichern
      await db
        .update(salesFollowups)
        .set({
          whatsappMessage: finalWhatsApp,
          emailSubject: finalSubject,
          emailBody: finalBody,
          updatedAt: now,
        })
        .where(eq(salesFollowups.id, input.followupId));

      return {
        whatsappMessage: finalWhatsApp,
        emailSubject: finalSubject,
        emailBody: finalBody,
        promoCode,
        codeExpiresAt,
        isNewCode,
      };
    }),

  /**
   * forceNewCode – Legacy, wird nicht mehr aktiv genutzt.
   * Neuer Code wird jetzt automatisch in resolveCode erstellt wenn der alte abgelaufen ist.
   * Bleibt für Rückwärtskompatibilität erhalten.
   */
  forceNewCode: adminProcedure
    .input(z.object({ followupId: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [followUp] = await db
        .select()
        .from(salesFollowups)
        .where(eq(salesFollowups.id, input.followupId))
        .limit(1);
      if (!followUp) throw new Error("Follow-up nicht gefunden");

      const result = await createIndividualCode(db, input.followupId, followUp.orderId);
      console.log(`[FollowUp] forceNewCode: Neuer Code ${result.code} für Follow-up ${input.followupId}`);
      return { code: result.code, expiresAt: result.expiresAt };
    }),

  /**
   * Follow-up als erledigt markieren
   */
  markDone: adminProcedure
    .input(z.object({
      followupId: z.number(),
      completedBy: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await db
        .update(salesFollowups)
        .set({
          status: "done",
          completedAt: new Date(),
          completedBy: input.completedBy || ctx.user?.username || "admin",
          updatedAt: new Date(),
        })
        .where(eq(salesFollowups.id, input.followupId));

      return { ok: true };
    }),

  /**
   * Follow-up überspringen
   */
  markSkipped: adminProcedure
    .input(z.object({ followupId: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await db
        .update(salesFollowups)
        .set({
          status: "skipped",
          skippedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(salesFollowups.id, input.followupId));

      return { ok: true };
    }),

  /**
   * Follow-up E-Mail via Resend senden
   */
  sendFollowUpEmail: adminProcedure
    .input(z.object({ followupId: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      if (!ENV.resendApiKey) throw new Error("Resend API Key nicht konfiguriert");

      // Follow-up laden
      const [followUp] = await db
        .select()
        .from(salesFollowups)
        .where(eq(salesFollowups.id, input.followupId))
        .limit(1);
      if (!followUp) throw new Error("Follow-up nicht gefunden");

      if (!followUp.emailBody || !followUp.emailSubject) {
        throw new Error("Nachrichten noch nicht generiert. Bitte zuerst Nachrichten generieren.");
      }

      // Code-Ablauf prüfen – bei abgelaufenem Code resolveCode aufrufen um neuen Code zu erstellen
      if (followUp.codeExpiresAt && new Date(followUp.codeExpiresAt) < new Date()) {
        // Neuen Code automatisch erstellen (E-Mail-Versand = Kundenkontakt-Moment)
        const [order2] = await db
          .select()
          .from(orders)
          .where(eq(orders.orderId, followUp.orderId))
          .limit(1);
        if (order2) {
          await createIndividualCode(db, input.followupId, followUp.orderId);
          // Follow-up neu laden mit neuem Code
          const [updatedFollowUp] = await db
            .select()
            .from(salesFollowups)
            .where(eq(salesFollowups.id, input.followupId))
            .limit(1);
          if (updatedFollowUp) {
            Object.assign(followUp, updatedFollowUp);
          }
        }
      }

      // Bestellung laden für E-Mail-Adresse
      const [order] = await db
        .select({ email: orders.email, firstName: orders.firstName, lastName: orders.lastName })
        .from(orders)
        .where(eq(orders.orderId, followUp.orderId))
        .limit(1);
      if (!order) throw new Error("Bestellung nicht gefunden");

      if (!order.email) throw new Error("Kunde hat keine E-Mail-Adresse");

      // E-Mail senden via Resend
      const response = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${ENV.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "369 Research <noreply@369research.eu>",
          to: [order.email],
          bcc: ["369rebackup@gmail.com"], // Kopie an Pakko
          subject: followUp.emailSubject,
          html: followUp.emailBody,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`E-Mail-Versand fehlgeschlagen: ${response.status} – ${errorBody}`);
      }

      // Versandstatus speichern
      await db
        .update(salesFollowups)
        .set({
          emailSentAt: new Date(),
          emailSentTo: order.email,
          updatedAt: new Date(),
        })
        .where(eq(salesFollowups.id, input.followupId));

      console.log(`[FollowUp] E-Mail gesendet an ${order.email} für Follow-up ${input.followupId}`);
      return { ok: true, sentTo: order.email };
    }),

  /**
   * Cross-Sell Empfehlungen berechnen (Ranking-Engine)
   * Gibt max. 2 automatische Vorschläge basierend auf der Empfehlungs-Matrix zurück.
   */
  getCrossSellRecommendations: adminProcedure
    .input(z.object({ followupId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Follow-up + Ursprungsbestellung laden
      const [followUp] = await db
        .select()
        .from(salesFollowups)
        .where(eq(salesFollowups.id, input.followupId))
        .limit(1);
      if (!followUp) throw new Error("Follow-up nicht gefunden");

      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.orderId, followUp.orderId))
        .limit(1);

      // Alle Bestellungen des Kunden für "bereits gekauft" Kennzeichnung
      const allCustomerOrders = order ? await getCustomerOrderHistory(db, order) : [];
      const allOrderIds = allCustomerOrders.map((o: any) => o.orderId);

      const allItems = allOrderIds.length > 0
        ? await db.select({ articleId: orderItems.articleId }).from(orderItems)
            .where(inArray(orderItems.orderId, allOrderIds))
        : [];

      const boughtArticleIds = new Set(
        allItems.map((i: any) => i.articleId).filter(Boolean)
      );

      // Gekaufte Artikel mit followUpCategory laden
      const boughtArticleIdArray = Array.from(boughtArticleIds) as number[];
      const boughtArticlesWithCat = boughtArticleIdArray.length > 0
        ? await db
            .select({ id: articles.id, name: articles.name, followUpCategory: articles.followUpCategory })
            .from(articles)
            .where(inArray(articles.id, boughtArticleIdArray))
        : [];

      // Alle aktiven + shopVisible Artikel laden
      const allArticles = await db
        .select({
          id: articles.id,
          name: articles.name,
          sellingPrice: articles.sellingPrice,
          shopProductId: articles.shopProductId,
          category: articles.category,
          followUpCategory: articles.followUpCategory,
          stock: articles.stock,
        })
        .from(articles)
        .where(and(eq(articles.isActive, 1), eq(articles.shopVisible, 1)))
        .orderBy(articles.name);

      const articlesWithBought = allArticles.map((a: any) => ({
        ...a,
        sellingPrice: a.sellingPrice ? parseFloat(a.sellingPrice) : 0,
        alreadyBought: boughtArticleIds.has(a.id),
      }));

      const recommendations = computeCrossSellRecommendations(
        boughtArticlesWithCat as any,
        articlesWithBought
      );

      console.log(`[FollowUp] Cross-Sell Empfehlungen für Follow-up ${input.followupId}: ${recommendations.map(r => r.name).join(", ") || "keine"}`);

      return {
        recommendations,
        boughtCategories: Array.from(new Set(
          boughtArticlesWithCat.map((a: any) => a.followUpCategory).filter(Boolean)
        )),
      };
    }),

  /**
   * Verfügbare Produkte für Produktauswahl laden
   * (aktiv + shopVisible, mit "bereits gekauft" Kennzeichnung)
   */
  getAvailableProducts: adminProcedure
    .input(z.object({
      followupId: z.number(),
      search: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Follow-up + Ursprungsbestellung laden
      const [followUp] = await db
        .select()
        .from(salesFollowups)
        .where(eq(salesFollowups.id, input.followupId))
        .limit(1);
      if (!followUp) throw new Error("Follow-up nicht gefunden");

      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.orderId, followUp.orderId))
        .limit(1);

      // Alle Bestellungen des Kunden für "bereits gekauft" Kennzeichnung
      const allCustomerOrders = order ? await getCustomerOrderHistory(db, order) : [];
      const allOrderIds = allCustomerOrders.map((o: any) => o.orderId);

      const allItems = allOrderIds.length > 0
        ? await db.select({ articleId: orderItems.articleId }).from(orderItems)
            .where(inArray(orderItems.orderId, allOrderIds))
        : [];

      const boughtArticleIds = new Set(
        allItems.map((i: any) => i.articleId).filter(Boolean)
      );

      // Aktive + shopVisible Artikel laden
      let allArticles = await db
        .select({
          id: articles.id,
          name: articles.name,
          sellingPrice: articles.sellingPrice,
          shopProductId: articles.shopProductId,
          category: articles.category,
          followUpCategory: articles.followUpCategory,
          stock: articles.stock,
        })
        .from(articles)
        .where(
          and(
            eq(articles.isActive, 1),
            eq(articles.shopVisible, 1)
          )
        )
        .orderBy(articles.name);

      // Suche filtern
      if (input.search) {
        const q = input.search.toLowerCase();
        allArticles = allArticles.filter((a: any) =>
          a.name.toLowerCase().includes(q) ||
          (a.category || "").toLowerCase().includes(q)
        );
      }

      // Bereits ausgewählte Produkte
      const selectedProducts = await db
        .select({ articleId: salesFollowupProducts.articleId })
        .from(salesFollowupProducts)
        .where(eq(salesFollowupProducts.followupId, input.followupId));
      const selectedIds = new Set(selectedProducts.map((p: any) => p.articleId));

      return allArticles.map((a: any) => ({
        ...a,
        sellingPrice: a.sellingPrice ? parseFloat(a.sellingPrice) : 0,
        alreadyBought: boughtArticleIds.has(a.id),
        isSelected: selectedIds.has(a.id),
        shopLink: a.shopProductId ? `${SHOP_BASE_URL}/product/${a.shopProductId}` : null,
      }));
    }),
});
