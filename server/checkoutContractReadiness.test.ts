import assert from "node:assert/strict";
import test from "node:test";
import {
  CHECKOUT_CONTRACT_LOCAL_BASELINE,
  CHECKOUT_CONTRACT_REQUIREMENTS,
  checkCheckoutContractReadiness,
  type CheckoutContractEvidenceInput,
  type CheckoutContractRequirementId,
} from "./checkoutContractReadiness.js";

function completeEvidence(): CheckoutContractEvidenceInput {
  return Object.fromEntries(CHECKOUT_CONTRACT_REQUIREMENTS.map(({ id }) => [
    id,
    { status: "verified", reference: `local-fixture:${id}` },
  ]));
}

test("empty evidence blocks every requirement and never claims connectivity or release", () => {
  const result = checkCheckoutContractReadiness({});
  assert.equal(result.offlineEvidenceComplete, false);
  assert.equal(result.scope, "offline_evidence_checklist");
  assert.equal(result.connected, false);
  assert.equal(result.releaseApproved, false);
  assert.deepEqual(result.blockers.map(({ id }) => id), CHECKOUT_CONTRACT_REQUIREMENTS.map(({ id }) => id));
  assert.ok(result.blockers.every(({ reason }) => reason === "unverified"));
});

test("historical baseline exposes missing legacy fields without pretending V2 closes them", () => {
  const result = checkCheckoutContractReadiness(CHECKOUT_CONTRACT_LOCAL_BASELINE);
  for (const id of ["legacy_preview", "legacy_confirmation_token", "confirmation_evidence", "wise_payment_instructions"] as const) {
    assert.equal(result.blockers.find((blocker) => blocker.id === id)?.reason, "missing");
  }
  assert.equal(result.blockers.find(({ id }) => id === "canonical_pricing")?.reason, "unverified");
  assert.equal(result.offlineEvidenceComplete, false);
});

test("caller-supplied complete evidence only completes the offline checklist", () => {
  const result = checkCheckoutContractReadiness(completeEvidence());
  assert.equal(result.offlineEvidenceComplete, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.connected, false);
  assert.equal(result.releaseApproved, false);
});

test("each individual requirement is mandatory", () => {
  for (const { id } of CHECKOUT_CONTRACT_REQUIREMENTS) {
    const evidence = { ...completeEvidence() };
    delete evidence[id];
    const result = checkCheckoutContractReadiness(evidence);
    assert.equal(result.offlineEvidenceComplete, false, id);
    assert.deepEqual(result.blockers.map((blocker) => blocker.id), [id]);
  }
});

test("verified evidence without a nonblank reference remains blocked", () => {
  for (const reference of [undefined, "", " \n\t"]) {
    const result = checkCheckoutContractReadiness({
      ...completeEvidence(),
      legacy_preview: { status: "verified", reference },
    });
    assert.deepEqual(result.blockers.map(({ id, reason }) => ({ id, reason })), [
      { id: "legacy_preview", reason: "missing_reference" },
    ]);
  }
});

test("explicit missing and unverified statuses remain blocked even with references", () => {
  for (const status of ["missing", "unverified"] as const) {
    const result = checkCheckoutContractReadiness({
      ...completeEvidence(),
      wise_payment_instructions: { status, reference: "documented-but-not-verified" },
    });
    assert.equal(result.offlineEvidenceComplete, false);
    assert.equal(result.blockers[0]?.reason, status);
  }
});

test("checker is deterministic, leaves frozen inputs untouched, and reports unique IDs", () => {
  const evidence = Object.freeze(Object.fromEntries(CHECKOUT_CONTRACT_REQUIREMENTS.map(({ id }) => [
    id,
    Object.freeze({ status: "unverified", reference: `fixture:${id}` }),
  ])));
  assert.deepEqual(checkCheckoutContractReadiness(evidence), checkCheckoutContractReadiness(evidence));
  const ids: CheckoutContractRequirementId[] = CHECKOUT_CONTRACT_REQUIREMENTS.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(checkCheckoutContractReadiness(evidence).blockers.length, ids.length);
});
