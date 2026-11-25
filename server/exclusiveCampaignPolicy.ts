import { TRPCError } from "@trpc/server";
import {
  getActiveGlobalAutomaticDiscountFromDb,
  type ActiveGlobalAutomaticDiscount,
} from "./globalAutomaticDiscountConfig.js";

export const EXCLUSIVE_CAMPAIGN_CONFLICT_MESSAGE = "Diese Aktion ist exklusiv und nicht mit Rabattcodes, Partner-/Creator-Vorteilen oder KWK/Guthaben kombinierbar. Bitte nur den Code bzw. Guthabeneinsatz entfernen; der Aktionsrabatt bleibt erhalten.";

/** Pass a server-owned active campaign snapshot, never a browser configuration. */
export function isStrictExclusiveCampaign(active: ActiveGlobalAutomaticDiscount | null): boolean {
  return active?.exclusiveCampaign === true;
}

export type ExclusiveCampaignInputFacts = {
  promotionCode?: string | null;
  discountCode?: string | null;
  partnerCode?: string | null;
  kwkCode?: string | null;
  creditUsed?: number;
  partnerCreditUsed?: number;
  kwkCreditUsed?: number;
  partnerDiscount?: number;
  kwkDiscount?: number;
  kwkCreditKwkId?: number;
  kwkCreditToken?: string;
  /** Account identity is allowed; its implicit self-benefit must be suppressed. */
  hasPartnerSelfDiscount?: boolean;
};

/** Reject explicit benefits; do NOT reject login/account identity or BF pricing. */
export function assertExclusiveCampaignInput(
  active: ActiveGlobalAutomaticDiscount | null,
  facts: ExclusiveCampaignInputFacts,
) {
  const strict = isStrictExclusiveCampaign(active);
  const hasCode = [facts.promotionCode, facts.discountCode, facts.partnerCode, facts.kwkCode]
    .some((value) => typeof value === "string" && value.trim().length > 0);
  const hasExplicitAmount = [facts.creditUsed, facts.partnerCreditUsed, facts.kwkCreditUsed,
    facts.partnerDiscount, facts.kwkDiscount].some((value) => value !== undefined && value !== 0);
  if (strict && (hasCode || hasExplicitAmount)) {
    throw new TRPCError({ code: "CONFLICT", message: EXCLUSIVE_CAMPAIGN_CONFLICT_MESSAGE });
  }
  return {
    strict,
    suppressPartnerSelfDiscount: strict,
    suppressPartnerAttribution: strict,
    suppressKwkRewards: strict,
    allowCreditRedemption: !strict,
  };
}

export const assertExclusiveCampaignAllowsBenefits = assertExclusiveCampaignInput;

/** API guard for code validation/redemption, before any lookup or ledger writes. */
export async function assertNoExclusiveCampaignBenefitFromDb(): Promise<void> {
  if (isStrictExclusiveCampaign(await getActiveGlobalAutomaticDiscountFromDb())) {
    throw new TRPCError({ code: "CONFLICT", message: EXCLUSIVE_CAMPAIGN_CONFLICT_MESSAGE });
  }
}

const attributionIds = new Set([
  "partnerId", "partnerCode", "partnerAttributionId", "commissionPartnerId",
  "kwkId", "kwkCode", "kwkAccountId", "kwkReferrerId", "kwkCreditKwkId", "kwkCreditToken",
  "referrerId", "referralCode", "referralPartnerId", "referralAccountId",
]);
const attributionAmounts = new Set([
  "partnerDiscount", "partnerDiscountPercent", "selfDiscountPercent", "partnerCommission",
  "partnerCommissionPercent", "commissionPercent", "commissionAmount", "creditUsed", "partnerCreditUsed",
  "kwkDiscount", "kwkCreditUsed", "kwkCommission", "kwkCommissionAmount", "kwkReward",
  "referralReward", "referralRewardAmount",
]);

/**
 * Copy only the attribution/financial record, not an account/program instance.
 * PartnerNumber and customer identity remain intact. Order integration must also
 * bypass downstream commission/referral booking, including session-derived IDs.
 */
export function sanitizeExclusiveCampaignAttribution<T extends object>(
  active: ActiveGlobalAutomaticDiscount | null,
  attribution: T,
): T {
  if (!isStrictExclusiveCampaign(active)) return attribution;
  return Object.fromEntries(Object.entries(attribution).map(([key, value]) => [
    key, attributionIds.has(key) ? null : attributionAmounts.has(key) ? 0 : value,
  ])) as T;
}
