import { roundMoney } from "./kwkCheckoutPricing.js";

export type AuthoritativeShopCheckoutPricingInput = {
  subtotal: number;
  shipping: number;
  automaticGlobalDiscount: number;
  promotionDiscount: number;
  partnerDiscount: number;
  partnerCreditUsed: number;
};

export type AuthoritativeShopCheckoutPricing = {
  automaticGlobalDiscount: number;
  promotionDiscount: number;
  partnerDiscount: number;
  partnerCreditUsed: number;
  totalDiscount: number;
  total: number;
};

/**
 * Rebuilds every financial term of a public shop order from server-authoritative
 * inputs. Partner credit remains additive to the authenticated partner's direct
 * purchase discount, but can never reduce shipping or exceed the remaining
 * product value.
 */
export function calculateAuthoritativeShopCheckoutPricing(
  input: AuthoritativeShopCheckoutPricingInput,
): AuthoritativeShopCheckoutPricing {
  const subtotal = roundMoney(Math.max(0, input.subtotal));
  const shipping = roundMoney(Math.max(0, input.shipping));

  const automaticGlobalDiscount = roundMoney(Math.min(
    subtotal,
    Math.max(0, input.automaticGlobalDiscount),
  ));
  const afterAutomatic = roundMoney(subtotal - automaticGlobalDiscount);

  const promotionDiscount = roundMoney(Math.min(
    afterAutomatic,
    Math.max(0, input.promotionDiscount),
  ));
  const afterPromotion = roundMoney(afterAutomatic - promotionDiscount);

  const partnerDiscount = roundMoney(Math.min(
    afterPromotion,
    Math.max(0, input.partnerDiscount),
  ));
  const afterPartnerDiscount = roundMoney(afterPromotion - partnerDiscount);

  const partnerCreditUsed = roundMoney(Math.min(
    afterPartnerDiscount,
    Math.max(0, input.partnerCreditUsed),
  ));
  const totalDiscount = roundMoney(
    automaticGlobalDiscount + promotionDiscount + partnerDiscount + partnerCreditUsed,
  );

  return {
    automaticGlobalDiscount,
    promotionDiscount,
    partnerDiscount,
    partnerCreditUsed,
    totalDiscount,
    total: roundMoney(subtotal - totalDiscount + shipping),
  };
}
