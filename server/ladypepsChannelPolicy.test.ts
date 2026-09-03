import assert from "node:assert/strict";
import test from "node:test";
import { LADYPEPS_CONTRACT_VERSION, getLadypepsProductPolicy } from "./ladypepsChannelPolicy.js";

test("LADYPEPS contract exposes the approved finished-spray policy", () => {
  const selank = getLadypepsProductPolicy("selank");
  const finished = selank?.forms.find((form) => form.form === "finished_nasal");
  assert.equal(LADYPEPS_CONTRACT_VERSION, "2026-09-v0.1");
  assert.equal(finished?.priceSurcharge, 15);
  assert.equal(finished?.requiresColdChain, true);
  assert.deepEqual(finished?.fulfillmentFlags, ["pre_mixed_nasal", "requires_cold_chain"]);
});

test("LADYPEPS keeps Plug&Play and Mix&Go behind explicit variant approval", () => {
  const pt141 = getLadypepsProductPolicy("pt-141");
  assert.equal(pt141?.forms.find((form) => form.form === "plug_play")?.approval, "requires_variant_approval");
  assert.equal(pt141?.forms.find((form) => form.form === "mix_and_go")?.approval, "requires_variant_approval");
});

