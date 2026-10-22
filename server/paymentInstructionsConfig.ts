import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { shopSettings } from "../drizzle/schema.js";

export const PAYMENT_INSTRUCTIONS_CONFIG_KEY = "bank_transfer_payment_instructions";

const paymentAccountSchema = z.object({
  id: z.string().min(1).max(64),
  labelDe: z.string().min(1).max(120),
  labelEn: z.string().min(1).max(120),
  accountHolder: z.string().min(1).max(160),
  iban: z.string().min(12).max(64),
  bic: z.string().min(6).max(32),
  bankAddress: z.string().max(240).optional(),
});

export const bankTransferPaymentInstructionsSchema = z.object({
  enabled: z.boolean(),
  checkoutLabelDe: z.string().min(1).max(160),
  checkoutLabelEn: z.string().min(1).max(160),
  checkoutHintDe: z.string().min(1).max(320),
  checkoutHintEn: z.string().min(1).max(320),
  accounts: z.array(paymentAccountSchema).min(1).max(5),
});

export type BankTransferPaymentInstructionsConfig = z.infer<typeof bankTransferPaymentInstructionsSchema>;

export type PublicBankTransferPresentation = {
  enabled: boolean;
  accountCount: number;
  checkoutLabelDe: string;
  checkoutLabelEn: string;
  checkoutHintDe: string;
  checkoutHintEn: string;
};

export type ReleasedBankTransferInstructions = {
  accountCount: number;
  accounts: z.infer<typeof paymentAccountSchema>[];
};

export function parseBankTransferPaymentInstructions(value: string | undefined): BankTransferPaymentInstructionsConfig | null {
  if (!value) return null;
  try {
    return bankTransferPaymentInstructionsSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

function toWiseOnlyPaymentInstructions(config: BankTransferPaymentInstructionsConfig | null): BankTransferPaymentInstructionsConfig | null {
  if (!config || !config.enabled) return config;
  const wiseAccounts = config.accounts.filter((account) => /\bwise\b/i.test([account.id, account.labelDe, account.labelEn, account.bankAddress || ""].join(" ")));
  // Fail closed: no payment details are released unless there is exactly one
  // existing account explicitly identified as Wise.
  if (wiseAccounts.length !== 1) return null;
  return {
    ...config,
    checkoutLabelDe: "SEPA- & Echtzeitüberweisung (Wise)",
    checkoutLabelEn: "SEPA & instant bank transfer (Wise)",
    checkoutHintDe: "Die Wise-Bankverbindung und dein persönlicher Verwendungszweck werden nach erfolgreicher Bestellung freigegeben.",
    checkoutHintEn: "The Wise bank account and your personal payment reference are released after your order is created.",
    accounts: wiseAccounts,
  };
}

export async function getBankTransferPaymentInstructionsConfig(): Promise<BankTransferPaymentInstructionsConfig | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [setting] = await db.select().from(shopSettings)
    .where(eq(shopSettings.key, PAYMENT_INSTRUCTIONS_CONFIG_KEY))
    .limit(1);
  return toWiseOnlyPaymentInstructions(parseBankTransferPaymentInstructions(setting?.value));
}

export function toPublicBankTransferPresentation(config: BankTransferPaymentInstructionsConfig | null): PublicBankTransferPresentation | null {
  const wiseOnly = toWiseOnlyPaymentInstructions(config);
  if (!wiseOnly || !wiseOnly.enabled) return null;
  return {
    enabled: true,
    accountCount: wiseOnly.accounts.length,
    checkoutLabelDe: wiseOnly.checkoutLabelDe,
    checkoutLabelEn: wiseOnly.checkoutLabelEn,
    checkoutHintDe: wiseOnly.checkoutHintDe,
    checkoutHintEn: wiseOnly.checkoutHintEn,
  };
}

export function toReleasedBankTransferInstructions(config: BankTransferPaymentInstructionsConfig | null): ReleasedBankTransferInstructions | null {
  const wiseOnly = toWiseOnlyPaymentInstructions(config);
  if (!wiseOnly || !wiseOnly.enabled) return null;
  return {
    accountCount: wiseOnly.accounts.length,
    accounts: wiseOnly.accounts,
  };
}

export async function getReleasedBankTransferInstructions(): Promise<ReleasedBankTransferInstructions | null> {
  return toReleasedBankTransferInstructions(await getBankTransferPaymentInstructionsConfig());
}

export async function upsertBankTransferPaymentInstructionsConfig(input: BankTransferPaymentInstructionsConfig) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const value = JSON.stringify(input);
  const [existing] = await db.select().from(shopSettings)
    .where(eq(shopSettings.key, PAYMENT_INSTRUCTIONS_CONFIG_KEY))
    .limit(1);

  if (existing) {
    await db.update(shopSettings).set({ value, updatedAt: new Date() })
      .where(eq(shopSettings.key, PAYMENT_INSTRUCTIONS_CONFIG_KEY));
  } else {
    await db.insert(shopSettings).values({ key: PAYMENT_INSTRUCTIONS_CONFIG_KEY, value });
  }

  return input;
}
