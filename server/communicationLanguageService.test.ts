import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCommunicationLanguage } from "./communicationLanguageService.js";

test("Kommunikationssprache akzeptiert ausschließlich Englisch und nutzt Deutsch als sicheren Standard", () => {
  assert.equal(normalizeCommunicationLanguage("en"), "en");
  assert.equal(normalizeCommunicationLanguage("de"), "de");
  assert.equal(normalizeCommunicationLanguage(undefined), "de");
  assert.equal(normalizeCommunicationLanguage("fr"), "de");
  assert.equal(normalizeCommunicationLanguage("EN"), "de");
});
