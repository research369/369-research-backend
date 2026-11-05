export type KwkFraudFlags = {
  sameEmail: boolean;
  samePhone: boolean;
  sameAddress: boolean;
};

/**
 * kwk_referrals.fraud_flags is intentionally a TEXT column in the additive
 * production schema. Persist stable JSON text; it must never be cast to jsonb
 * at an INSERT boundary because PostgreSQL does not implicitly write jsonb to
 * a text field.
 */
export function serializeKwkFraudFlags(flags: KwkFraudFlags): string {
  return JSON.stringify({
    sameEmail: Boolean(flags.sameEmail),
    samePhone: Boolean(flags.samePhone),
    sameAddress: Boolean(flags.sameAddress),
  });
}
