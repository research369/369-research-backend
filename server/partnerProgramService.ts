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

export type ResolvedPartnerCode = {
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

/** Keeps the legacy display field and the normalized public lookup registry aligned. */
export async function replacePartnerCodes(partnerId: number, value: string): Promise<void> {
  const codes = splitPartnerCodes(value);
  if (codes.length === 0) throw new Error("Mindestens ein Partnercode ist erforderlich");
  const pool = await getPool();
  if (!pool) throw new Error("Datenbank nicht verfügbar");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM partner_codes WHERE partner_id = $1", [partnerId]);
    for (const code of codes) {
      await client.query(
        `INSERT INTO partner_codes (partner_id, display_code, code_normalized, is_active, updated_at)
         VALUES ($1, $2, $3, TRUE, NOW())`,
        [partnerId, code, code],
      );
    }
    await client.query("COMMIT");
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

export function calculateProgramDiscount(subtotal: number, priorProductDiscount: number, percentage: number): number {
  const base = Math.max(0, Math.round((subtotal - priorProductDiscount) * 100) / 100);
  const percent = Math.max(0, Math.min(100, percentage));
  return Math.round((base * percent / 100) * 100) / 100;
}

export async function resolveActivePartnerCode(rawCode: string): Promise<ResolvedPartnerCode | null> {
  const code = normalizePartnerCode(rawCode);
  if (!code) return null;
  const pool = await getPool();
  if (!pool) throw new Error("Datenbank nicht verfügbar");
  const result = await pool.query<{
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
    SELECT p.id AS partner_id,
           p.name AS partner_name,
           pc.display_code AS partner_code,
           p.partner_number,
           p.email AS partner_email,
           p.commission_percent,
           p.customer_discount_percent,
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
