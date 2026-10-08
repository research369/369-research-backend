import { getPool } from "./db.js";

export type PartnerProgramKey = "creator" | "partner" | "self_user";
export type PartnerSettlementMethod = "payout" | "shop_credit" | "none";
export type CustomerDiscountPolicy = "each_valid_code_use" | "first_paid_code_use" | "own_email_only";
export type CommissionPolicy = "each_paid_code_order" | "first_paid_code_order" | "none";

export type PartnerProgram = {
  key: PartnerProgramKey;
  label: string;
  customerDiscountPolicy: CustomerDiscountPolicy;
  commissionPolicy: CommissionPolicy;
  settlementMethod: PartnerSettlementMethod;
  allowSelfOrderCredit: boolean;
  active: boolean;
};

/** A public code's current commercial terms. Historical orders always use their snapshots. */
export type PartnerCodeTerms = {
  id?: number;
  code: string;
  commissionPercent: number;
  customerDiscountPercent: number;
  isActive: boolean;
};

export type StoredPartnerCodeTerms = Required<Pick<PartnerCodeTerms, "id">> & PartnerCodeTerms;

export type ResolvedPartnerCode = {
  /** Immutable identifier for the exact public code used by a new order. */
  codeId: number;
  partnerId: number;
  partnerName: string;
  partnerCode: string;
  partnerNumber: string;
  partnerEmail: string | null;
  commissionPercent: number;
  customerDiscountPercent: number;
  program: PartnerProgram;
};

const PROGRAM_KEYS: PartnerProgramKey[] = ["creator", "partner", "self_user"];

export function isPartnerProgramKey(value: unknown): value is PartnerProgramKey {
  return typeof value === "string" && PROGRAM_KEYS.includes(value as PartnerProgramKey);
}

export function normalizePartnerCode(value: string): string {
  return value.trim().replace(/\s+/g, "").toUpperCase();
}

export function splitPartnerCodes(value: string): string[] {
  return [...new Set(value.split(",").map(normalizePartnerCode).filter(Boolean))];
}

function validPercentage(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label} muss zwischen 0 und 100 liegen`);
  }
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Canonicalizes public-code terms before they are written. A duplicate normalized
 * code in one request is rejected instead of silently merging different rates.
 */
export function normalizePartnerCodeTerms(input: Array<{
  id?: number;
  code: string;
  commissionPercent: number;
  customerDiscountPercent: number;
  isActive?: boolean;
}>): PartnerCodeTerms[] {
  if (input.length === 0) throw new Error("Mindestens ein Partnercode ist erforderlich");

  const seen = new Set<string>();
  const terms = input.map((entry) => {
    const code = normalizePartnerCode(entry.code);
    if (!code) throw new Error("Partnercode darf nicht leer sein");
    if (code.length > 50) throw new Error("Partnercode darf maximal 50 Zeichen haben");
    if (seen.has(code)) throw new Error(`Code "${code}" wurde mehrfach angegeben`);
    seen.add(code);

    return {
      ...(entry.id === undefined ? {} : { id: entry.id }),
      code,
      commissionPercent: validPercentage(entry.commissionPercent, "Provision"),
      customerDiscountPercent: validPercentage(entry.customerDiscountPercent, "Kundenrabatt"),
      isActive: entry.isActive !== false,
    };
  });

  if (!terms.some((entry) => entry.isActive)) {
    throw new Error("Mindestens ein öffentlicher Partnercode muss aktiv bleiben");
  }
  return terms;
}

/**
 * Compatibility bridge for older callers that still submit a comma-separated
 * `code` field. Existing code-specific terms win; only genuinely new codes use
 * the supplied legacy defaults. This prevents a legacy update from flattening
 * different rates that are already stored per code.
 */
export function buildLegacyPartnerCodeTerms(
  rawCodes: string,
  existingCodes: StoredPartnerCodeTerms[],
  defaults: { commissionPercent: number; customerDiscountPercent: number },
): PartnerCodeTerms[] {
  const existingByCode = new Map(existingCodes.map((entry) => [normalizePartnerCode(entry.code), entry]));
  return splitPartnerCodes(rawCodes).map((code) => {
    const existing = existingByCode.get(code);
    return existing
      ? {
          id: existing.id,
          code,
          commissionPercent: existing.commissionPercent,
          customerDiscountPercent: existing.customerDiscountPercent,
          isActive: true,
        }
      : {
          code,
          commissionPercent: defaults.commissionPercent,
          customerDiscountPercent: defaults.customerDiscountPercent,
          isActive: true,
        };
  });
}

/** Returns all code rows, including inactive rows retained for audit/history. */
export async function listPartnerCodeTerms(partnerId: number): Promise<StoredPartnerCodeTerms[]> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbank nicht verfügbar");
  const result = await pool.query<{
    id: number;
    display_code: string;
    commission_percent: string;
    customer_discount_percent: string;
    is_active: boolean;
  }>(`
    SELECT id, display_code, commission_percent, customer_discount_percent, is_active
      FROM partner_codes
     WHERE partner_id = $1
     ORDER BY created_at ASC, id ASC`, [partnerId]);

  return result.rows.map((row) => ({
    id: row.id,
    code: row.display_code,
    commissionPercent: Number(row.commission_percent),
    customerDiscountPercent: Number(row.customer_discount_percent),
    isActive: row.is_active,
  }));
}

/**
 * Synchronizes public-code terms without deleting or renaming historical code
 * rows. Existing code IDs are immutable identities: deactivate a retired code
 * and create a fresh row instead of changing its text. This keeps audit views,
 * legacy attribution and every order's code-ID snapshot meaningful forever.
 */
export async function replacePartnerCodes(
  partnerId: number,
  rawTerms: Array<{
    id?: number;
    code: string;
    commissionPercent: number;
    customerDiscountPercent: number;
    isActive?: boolean;
  }>,
): Promise<StoredPartnerCodeTerms[]> {
  const terms = normalizePartnerCodeTerms(rawTerms);
  const pool = await getPool();
  if (!pool) throw new Error("Datenbank nicht verfügbar");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const existingResult = await client.query<{
      id: number;
      display_code: string;
      code_normalized: string;
    }>(`
      SELECT id, display_code, code_normalized
        FROM partner_codes
       WHERE partner_id = $1
       FOR UPDATE`, [partnerId]);
    const existingById = new Map(existingResult.rows.map((row) => [row.id, row]));
    const existingByCode = new Map(existingResult.rows.map((row) => [row.code_normalized, row]));

    const collisions = await client.query<{ code_normalized: string }>(`
      SELECT code_normalized
        FROM partner_codes
       WHERE partner_id <> $1
         AND code_normalized = ANY($2::varchar[])
       LIMIT 1`, [partnerId, terms.map((entry) => entry.code)]);
    if (collisions.rows.length > 0) {
      throw new Error(`Code "${collisions.rows[0].code_normalized}" ist bereits vergeben`);
    }

    const resolvedRows = terms.map((term) => {
      const existing = term.id === undefined
        ? existingByCode.get(term.code)
        : existingById.get(term.id);
      if (term.id !== undefined && !existing) {
        throw new Error("Ein ausgewählter Partnercode gehört nicht zu diesem Partner");
      }
      if (existing && existing.code_normalized !== term.code) {
        throw new Error("Ein bestehender Partnercode kann nicht umbenannt werden. Bitte den alten Code deaktivieren und einen neuen Code anlegen.");
      }
      return { term, existing };
    });

    const retainedIds: number[] = [];
    for (const { term, existing } of resolvedRows) {
      if (existing) {
        await client.query(`
          UPDATE partner_codes
             SET commission_percent = $1,
                 customer_discount_percent = $2,
                 is_active = $3,
                 updated_at = NOW()
           WHERE id = $4`, [
          term.commissionPercent.toFixed(2),
          term.customerDiscountPercent.toFixed(2),
          term.isActive,
          existing.id,
        ]);
        retainedIds.push(existing.id);
      } else {
        const inserted = await client.query<{ id: number }>(`
          INSERT INTO partner_codes (
            partner_id, display_code, code_normalized,
            commission_percent, customer_discount_percent, is_active, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
          RETURNING id`, [
          partnerId,
          term.code,
          term.code,
          term.commissionPercent.toFixed(2),
          term.customerDiscountPercent.toFixed(2),
          term.isActive,
        ]);
        retainedIds.push(inserted.rows[0].id);
      }
    }

    await client.query(`
      UPDATE partner_codes
         SET is_active = FALSE, updated_at = NOW()
       WHERE partner_id = $1
         AND NOT (id = ANY($2::int[]))`, [partnerId, retainedIds]);

    const activeCodes = terms.filter((term) => term.isActive).map((term) => term.code).join(", ");
    await client.query(
      "UPDATE partners SET code = $1, updated_at = NOW() WHERE id = $2",
      [activeCodes, partnerId],
    );

    const stored = await client.query<{
      id: number;
      display_code: string;
      commission_percent: string;
      customer_discount_percent: string;
      is_active: boolean;
    }>(`
      SELECT id, display_code, commission_percent, customer_discount_percent, is_active
        FROM partner_codes
       WHERE partner_id = $1
       ORDER BY created_at ASC, id ASC`, [partnerId]);
    await client.query("COMMIT");

    return stored.rows.map((row) => ({
      id: row.id,
      code: row.display_code,
      commissionPercent: Number(row.commission_percent),
      customerDiscountPercent: Number(row.customer_discount_percent),
      isActive: row.is_active,
    }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function isDiscountAllowedForProgram(program: PartnerProgram, customerEmail: string | null | undefined, partnerEmail: string | null): boolean {
  if (!program.active) return false;
  if (program.customerDiscountPolicy !== "own_email_only") return true;
  if (!customerEmail || !partnerEmail) return false;
  return customerEmail.trim().toLowerCase() === partnerEmail.trim().toLowerCase();
}

export function isRepeatCodeUseAllowed(program: PartnerProgram): boolean {
  return program.customerDiscountPolicy === "each_valid_code_use";
}

export function canRedeemShopCredit(program: PartnerProgram): boolean {
  return program.settlementMethod === "shop_credit" && program.allowSelfOrderCredit;
}

export function isPayoutProgram(program: PartnerProgram): boolean {
  return program.settlementMethod === "payout";
}

/**
 * A Creator's own authenticated purchase converts the benefit normally split
 * between the customer discount and the Creator payout into one direct product
 * discount. It never applies to public code orders and must not create a second
 * commission afterwards. Other programs retain their established self-order
 * customer-discount rate.
 */
export function calculateSelfOrderDiscountPercent(
  program: PartnerProgram,
  customerDiscountPercent: number,
  commissionPercent: number,
): number {
  const customerDiscount = validPercentage(customerDiscountPercent, "Kundenrabatt");
  const commission = validPercentage(commissionPercent, "Provision");
  if (program.key !== "creator") return customerDiscount;
  return Math.min(100, Math.round((customerDiscount + commission + Number.EPSILON) * 100) / 100);
}

export function calculateProgramDiscount(subtotal: number, priorProductDiscount: number, percentage: number): number {
  const base = Math.max(0, Math.round((subtotal - priorProductDiscount) * 100) / 100);
  const percent = Math.max(0, Math.min(100, percentage));
  return Math.round((base * percent / 100) * 100) / 100;
}

/**
 * A partner code attached to a WaWi-created sale is attribution only. The
 * operator already chooses every price reduction explicitly in that workflow,
 * so the public customer discount must never be added a second time. The code
 * remains on the order and therefore still supports the normal post-payment
 * commission/credit settlement.
 */
export function calculatePublicPartnerCustomerDiscount(input: {
  subtotal: number;
  priorProductDiscount: number;
  percentage: number;
  isAuthenticatedWawiManualSale: boolean;
}): number {
  if (input.isAuthenticatedWawiManualSale) return 0;
  return calculateProgramDiscount(input.subtotal, input.priorProductDiscount, input.percentage);
}

export async function resolveActivePartnerCode(rawCode: string): Promise<ResolvedPartnerCode | null> {
  const code = normalizePartnerCode(rawCode);
  if (!code) return null;
  const pool = await getPool();
  if (!pool) throw new Error("Datenbank nicht verfügbar");
  const result = await pool.query<{
    partner_code_id: number;
    partner_id: number;
    partner_name: string;
    partner_code: string;
    partner_number: string;
    partner_email: string | null;
    commission_percent: string;
    customer_discount_percent: string;
    program_key: string;
    label: string;
    customer_discount_policy: CustomerDiscountPolicy;
    commission_policy: CommissionPolicy;
    settlement_method: PartnerSettlementMethod;
    allow_self_order_credit: boolean;
    active: boolean;
  }>(`
    SELECT pc.id AS partner_code_id,
           p.id AS partner_id,
           p.name AS partner_name,
           pc.display_code AS partner_code,
           p.partner_number,
           p.email AS partner_email,
           pc.commission_percent,
           pc.customer_discount_percent,
           pp.key AS program_key,
           pp.label,
           pp.customer_discount_policy,
           pp.commission_policy,
           pp.settlement_method,
           pp.allow_self_order_credit,
           pp.active
      FROM partner_codes pc
      JOIN partners p ON p.id = pc.partner_id AND p.is_active = 1
      JOIN partner_programs pp ON pp.key = p.program_key AND pp.active = TRUE
     WHERE pc.code_normalized = $1 AND pc.is_active = TRUE
     LIMIT 1`, [code]);
  const row = result.rows[0];
  if (!row || !isPartnerProgramKey(row.program_key)) return null;
  return {
    codeId: row.partner_code_id,
    partnerId: row.partner_id,
    partnerName: row.partner_name,
    partnerCode: row.partner_code,
    partnerNumber: row.partner_number,
    partnerEmail: row.partner_email,
    commissionPercent: Number(row.commission_percent),
    customerDiscountPercent: Number(row.customer_discount_percent),
    program: {
      key: row.program_key,
      label: row.label,
      customerDiscountPolicy: row.customer_discount_policy,
      commissionPolicy: row.commission_policy,
      settlementMethod: row.settlement_method,
      allowSelfOrderCredit: row.allow_self_order_credit,
      active: row.active,
    },
  };
}

export async function getPartnerProgram(partnerId: number): Promise<PartnerProgram | null> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbank nicht verfügbar");
  const result = await pool.query<{
    key: string;
    label: string;
    customer_discount_policy: CustomerDiscountPolicy;
    commission_policy: CommissionPolicy;
    settlement_method: PartnerSettlementMethod;
    allow_self_order_credit: boolean;
    active: boolean;
  }>(`
    SELECT pp.key, pp.label, pp.customer_discount_policy, pp.commission_policy,
           pp.settlement_method, pp.allow_self_order_credit, pp.active
      FROM partners p
      JOIN partner_programs pp ON pp.key = p.program_key
     WHERE p.id = $1
     LIMIT 1`, [partnerId]);
  const row = result.rows[0];
  if (!row || !isPartnerProgramKey(row.key)) return null;
  return {
    key: row.key,
    label: row.label,
    customerDiscountPolicy: row.customer_discount_policy,
    commissionPolicy: row.commission_policy,
    settlementMethod: row.settlement_method,
    allowSelfOrderCredit: row.allow_self_order_credit,
    active: row.active,
  };
}
