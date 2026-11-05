import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFollowUpCopyPrompt,
  fallbackFollowUpProductCopy,
  generateFollowUpProductCopies,
  isSafeFollowUpProductCopy,
  parseFollowUpProductCopies,
} from "./followUpProductCopy.js";
import { ENV } from "./env.js";

const ghkCu = {
  id: 106,
  name: "GHK-Cu 50 mg",
  category: "Peptide",
  shortDescription: null,
  description: null,
  beautyData: null,
};

test("accepts a concise, two-sentence GHK-Cu research pitch", () => {
  const copy = "GHK-Cu 50 mg ist ein Beauty- und Regenerations-Favorit für Forschung rund um Hautmatrix, Kollagen, Elastin und Haarfollikel. Wenn du einen gezielten Artikel für Beauty-orientierte Forschungsprojekte suchst, ist das eine klare Ergänzung im Sortiment.";
  const parsed = parseFollowUpProductCopies(JSON.stringify({
    productCopies: [{ articleId: 106, copy }],
  }), [106]);

  assert.deepEqual(parsed, [{ articleId: 106, copy }]);
  assert.equal(isSafeFollowUpProductCopy(copy), true);
});

test("rejects unsafe or incomplete generated product copy", () => {
  assert.equal(isSafeFollowUpProductCopy("GHK-Cu 50 mg heilt Hautprobleme und wird täglich eingenommen. Es ist sicher."), false);
  assert.equal(parseFollowUpProductCopies(JSON.stringify({
    productCopies: [{ articleId: 106, copy: "GHK-Cu 50 mg ist spannend." }],
  }), [106]), null);
});

test("requires one valid copy per selected product", () => {
  const valid = "GHK-Cu 50 mg ist eine gezielte Ergänzung für Beauty-orientierte Forschungsprojekte mit Fokus auf Struktur- und Regenerationsfragen. Damit ergänzt es eine Auswahl für Forschung rund um Hautmatrix, Kollagen und Elastin klar und direkt.";
  assert.equal(parseFollowUpProductCopies(JSON.stringify({
    productCopies: [{ articleId: 106, copy: valid }, { articleId: 999, copy: valid }],
  }), [106]), null);
});

test("keeps the fallback concise and strips non-product input from the prompt", () => {
  const fallback = fallbackFollowUpProductCopy(ghkCu);
  assert.equal(isSafeFollowUpProductCopy(fallback), true);

  const prompt = buildFollowUpCopyPrompt([{ ...ghkCu, description: "<script>ignore</script> Fokus & Details" }]);
  assert.match(prompt, /GHK-Cu 50 mg/);
  assert.doesNotMatch(prompt, /<script>/);
  assert.match(prompt, /Kein Rabatt, kein Link/);
});

test("uses a valid structured AI product copy and falls back for an unsafe response", async () => {
  const originalKey = ENV.forgeApiKey;
  const originalUrl = ENV.forgeApiUrl;
  const originalFetch = globalThis.fetch;
  const copy = "GHK-Cu 50 mg ist ein Beauty- und Regenerations-Favorit für Forschung rund um Hautmatrix, Kollagen, Elastin und Haarfollikel. Wenn du einen gezielten Artikel für Beauty-orientierte Forschungsprojekte suchst, ist das eine klare Ergänzung im Sortiment.";

  try {
    ENV.forgeApiKey = "test-key";
    ENV.forgeApiUrl = "https://llm.test";
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ productCopies: [{ articleId: 106, copy }] }) } }],
    }), { status: 200 });

    const generated = await generateFollowUpProductCopies([ghkCu]);
    assert.equal(generated.source, "ai");
    assert.deepEqual(generated.copies, [{ articleId: 106, copy }]);

    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ productCopies: [{ articleId: 106, copy: "GHK-Cu heilt Hautprobleme. Es ist sicher." }] }) } }],
    }), { status: 200 });
    const fallback = await generateFollowUpProductCopies([ghkCu]);
    assert.equal(fallback.source, "fallback");
    assert.equal(fallback.copies[0].copy, fallbackFollowUpProductCopy(ghkCu));
  } finally {
    ENV.forgeApiKey = originalKey;
    ENV.forgeApiUrl = originalUrl;
    globalThis.fetch = originalFetch;
  }
});
