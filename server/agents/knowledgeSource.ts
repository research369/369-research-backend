type CachedKnowledge = {
  text: string;
  expiresAt: number;
};

const cache = new Map<string, CachedKnowledge>();

function getCacheTtlMs(): number {
  const seconds = Number(process.env.PEPGPT_KNOWLEDGE_CACHE_SECONDS || "300");
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 300_000;
}

async function fetchText(url: string): Promise<string> {
  const cached = cache.get(url);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.text;

  const response = await fetch(url, {
    headers: {
      Accept: "text/plain,text/markdown;q=0.9,*/*;q=0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`Knowledge source unavailable (${response.status}): ${url}`);
  }

  const text = (await response.text()).trim();
  if (!text) {
    throw new Error(`Knowledge source returned empty content: ${url}`);
  }

  cache.set(url, { text, expiresAt: now + getCacheTtlMs() });
  return text;
}

export type PepKnowledge = {
  behavior: string;
  productKnowledge: string;
};

export async function loadPepKnowledge(): Promise<PepKnowledge> {
  const behaviorUrl = process.env.PEPGPT_BEHAVIOR_URL || "";
  const productKnowledgeUrl = process.env.PEPGPT_PRODUCT_KNOWLEDGE_URL || "";

  if (!behaviorUrl || !productKnowledgeUrl) {
    throw new Error(
      "PepGPT knowledge is not configured. Set PEPGPT_BEHAVIOR_URL and PEPGPT_PRODUCT_KNOWLEDGE_URL."
    );
  }

  const [behavior, productKnowledge] = await Promise.all([
    fetchText(behaviorUrl),
    fetchText(productKnowledgeUrl),
  ]);

  return { behavior, productKnowledge };
}

export function clearPepKnowledgeCache(): void {
  cache.clear();
}
