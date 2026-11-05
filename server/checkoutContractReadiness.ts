/**
 * Offline release-evidence checklist, NOT a route/schema validator or checkout.
 * No imports, I/O, environment access, credentials, API, DB or business mutations.
 * Submitted evidence is not independently authenticated by this helper.
 */
export const CHECKOUT_CONTRACT_REQUIREMENTS = [
  {
    id: "legacy_preview",
    requirement: "customerDataChange.previewCheckoutChange registriert; requiresConfirmation, matchState, confirmationToken, expiresAt und changedFields kompatibel.",
  },
  {
    id: "legacy_confirmation_token",
    requirement: "order.create akzeptiert customerDataChangeConfirmationToken; serverseitige Bindung an Kundendaten, Ablauf, Manipulation und Wiederholung geprüft.",
  },
  {
    id: "confirmation_evidence",
    requirement: "confirmations research/age/noReturn/address tatsächlich übermittelt; angezeigte Texte, Versionen, Einzelwerte und Zeitpunkt dem Auftrag dauerhaft zugeordnet.",
  },
  {
    id: "wise_payment_instructions",
    requirement: "Erfolgreiches order.create liefert freigegebene paymentInstructions mit accountCount und accounts (id, labelDe, labelEn, accountHolder, iban, bic; bankAddress optional); identische freigegebene Quelle in Mail und Bestätigungsseite.",
  },
  {
    id: "canonical_pricing",
    requirement: "Legacy berechnet Artikel-/Variantenpreise, salePrice, PEN/Patronen, Plug&Play-Aufpreis, Versand und Summen serverseitig aus freigegebenen kanonischen Quellen; keine clientautorisierte Preiswahl.",
  },
  {
    id: "quantity_promo_gifts",
    requirement: "Legacy/Frontend-Parität für berechtigte Mengenstaffeln 4/8/13/20/36 mit 10/20/25/30/35 Prozent, gültige/abgelaufene Aktionscodes, Gratis-BAC und Bundlefälle.",
  },
  {
    id: "partner_kwk_pricing",
    requirement: "Partner-/KWK-Rabatte, Guthaben, Authentisierung, Kombinationsausschlüsse, Rundung und Rabattaufschlüsselung gegen den abgeglichenen Legacy-Stand abgenommen.",
  },
  {
    id: "availability",
    requirement: "Fehlende/unbekannte Bestände und API-Fehler blockieren bereits Auswahl/Hinzufügen; gemeinsame benötigte Menge einschließlich Beigaben zählt; serverseitige finale Prüfung bleibt bestehen.",
  },
  {
    id: "idempotency_and_delivery",
    requirement: "Doppelklick/Wiederholung erzeugen höchstens einen Auftrag und eine Bestands-/Guthabenbuchung; Mailfehler werden nicht als fehlgeschlagener Auftrag mit blindem Retry behandelt.",
  },
  {
    id: "isolated_legacy_acceptance",
    requirement: "Abgeglichene Frontend-/Backend-Commit-IDs und eindeutig isolierter API-/DB-/Mail-Zielstand; vollständiger Build und Legacy-E2E einschließlich Zahlungshinweis, Persistenz, Mail, Packstation, EU/Schweiz und Bestandsänderung nachgewiesen.",
  },
] as const;

export type CheckoutContractRequirementId = typeof CHECKOUT_CONTRACT_REQUIREMENTS[number]["id"];
export type CheckoutContractEvidenceStatus = "verified" | "missing" | "unverified";

export interface CheckoutContractEvidence {
  /** verified requires a non-empty traceable reference; it remains caller-supplied. */
  readonly status: CheckoutContractEvidenceStatus;
  readonly reference?: string;
  readonly note?: string;
}

export type CheckoutContractEvidenceInput = Readonly<
  Partial<Record<CheckoutContractRequirementId, CheckoutContractEvidence>>
>;

export interface CheckoutContractBlocker {
  readonly id: CheckoutContractRequirementId;
  readonly reason: "missing" | "unverified" | "missing_reference";
  readonly requirement: string;
}

export interface CheckoutContractReadinessResult {
  readonly scope: "offline_evidence_checklist";
  readonly offlineEvidenceComplete: boolean;
  readonly connected: false;
  readonly releaseApproved: false;
  readonly blockers: readonly CheckoutContractBlocker[];
}

/** Deterministic and fail-closed: omitted or unknown statuses never count as verified. */
export function checkCheckoutContractReadiness(
  evidence: CheckoutContractEvidenceInput,
): CheckoutContractReadinessResult {
  const blockers: CheckoutContractBlocker[] = [];
  for (const { id, requirement } of CHECKOUT_CONTRACT_REQUIREMENTS) {
    const entry = evidence[id];
    if (entry?.status === "verified" && entry.reference?.trim()) continue;
    const reason = entry?.status === "verified"
      ? "missing_reference"
      : entry?.status === "missing" ? "missing" : "unverified";
    blockers.push({ id, reason, requirement });
  }
  return {
    scope: "offline_evidence_checklist",
    offlineEvidenceComplete: blockers.length === 0,
    connected: false,
    releaseApproved: false,
    blockers,
  };
}

/**
 * Historical local-source assessment only (2026-11-05), before upstream integration.
 * Backend 7e5e1bc / frontend 4da2f0c. Not a deployed-state or connected-state claim.
 * Refresh in the integration worktree after upstream comparison; do not treat this
 * snapshot as live detection or a substitute for inspecting the combined sources.
 */
export const CHECKOUT_CONTRACT_LOCAL_BASELINE: CheckoutContractEvidenceInput = {
  legacy_preview: {
    status: "missing",
    reference: "backend 7e5e1bc server/routers.ts:30-54; frontend 4da2f0c railwayApi.ts:2175-2197",
    note: "Preview im Frontend verwendet, im geprüften lokalen Backend nicht registriert.",
  },
  legacy_confirmation_token: {
    status: "missing",
    reference: "backend 7e5e1bc server/orderRouter.ts:59-132; frontend 4da2f0c Checkout.tsx:626",
    note: "Tokenfeld im geprüften Create-Schema fehlt; Sicherheitssemantik nicht nachgewiesen.",
  },
  confirmation_evidence: {
    status: "missing",
    reference: "frontend 4da2f0c Checkout.tsx:593-627; backend 7e5e1bc server/orderRouter.ts:59-132",
    note: "Lokales orderData hat Checkboxwerte; orderApi.create erhält sie in diesem Stand nicht. Schema und vollständiger Persistenznachweis fehlen.",
  },
  wise_payment_instructions: {
    status: "missing",
    reference: "backend 7e5e1bc server/orderRouter.ts:1279-1289; frontend 4da2f0c railwayApi.ts:783-794",
    note: "Erfolgsantwort ohne paymentInstructions; gemeinsame freigegebene Quelle nicht nachgewiesen.",
  },
  canonical_pricing: {
    status: "unverified",
    reference: "backend 7e5e1bc server/orderRouter.ts:164-185; Audit 2026-11-05 Abschnitt 3",
    note: "KWK-Neuberechnung ist kein Nachweis vollständiger kanonischer Legacy-Preisregeln für alle Wege.",
  },
};
