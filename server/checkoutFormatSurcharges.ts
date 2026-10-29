/**
 * Server-authoritative format surcharges for Checkout V2.
 * Keep these values aligned with client/src/lib/plugPlayConfig.ts before a release.
 * The checkout always derives the charged price from this module, never from
 * a client-supplied line price.
 */
export const PLUGPLAY_SURCHARGE = 15;
export const NASAL_DIY_SET_SURCHARGE = 7;
