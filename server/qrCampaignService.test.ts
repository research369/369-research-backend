import assert from "node:assert/strict";
import test from "node:test";
import { buildTrackedTarget, classifyDevice } from "./qrCampaignService.js";

test("marketing QR target keeps destination and adds first-party attribution", () => {
  const url = new URL(buildTrackedTarget("https://www.369research.eu/3g?x=1", {
    shortCode: "3g-flyer-ahlen",
    attributionToken: "a".repeat(48),
    campaign: "3g-launch",
    medium: "flyer",
  }));
  assert.equal(url.pathname, "/3g");
  assert.equal(url.searchParams.get("x"), "1");
  assert.equal(url.searchParams.get("_qr"), "a".repeat(48));
  assert.equal(url.searchParams.get("qr_code"), "3g-flyer-ahlen");
  assert.equal(url.searchParams.get("utm_source"), "qr");
});

test("device classification is deterministic and privacy preserving", () => {
  assert.equal(classifyDevice("Mozilla/5.0 (iPhone; CPU iPhone OS) Mobile"), "mobile");
  assert.equal(classifyDevice("Mozilla/5.0 (iPad; CPU OS)"), "tablet");
  assert.equal(classifyDevice("Googlebot/2.1"), "bot");
});
