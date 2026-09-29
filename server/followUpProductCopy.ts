import { ENV } from "./env.js";

export type FollowUpCopyArticle = {
  id: number;
  name: string;
  category?: string | null;
  shortDescription?: string | null;
  description?: unknown;
  beautyData?: unknown;
};

export type FollowUpProductCopy = {
  articleId: number;
  copy: string;
};

export type FollowUpCopyGeneration = {
  copies: FollowUpProductCopy[];
  source: "ai" | "fallback";
};

const FOLLOW_UP_COPY_MODEL = "gpt-5-mini";
const MAX_COPY_LENGTH = 360;
const DISALLOWED_COPY_PATTERNS = [
  /\b(einnahme|einnehmen|oral|injizier|dosier|therapie|therapeutisch|behandelt|heil[et]|heilt|heilung|krankheit|patient|nebenwirkung|sicher(?:heit)?|garantiert|klinisch|studie(?:n)? (?:zeigt|belegt)|hautpflege(?:routine)?|anwend(?:en|ung)|auftragen|verzehr)\b/i,
  /\b(wirkt gegen|unterstützt (?:deine|die) haut|verbessert (?:deine|die) haut|glättet|verjüngt|fördert (?:deine|die) haar)\b/i,
];

function safePlainText(value: unknown, maxLength = 900): string | null {
  if (!value) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const compact = text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return compact ? compact.slice(0, maxLength) : null;
}

function sentenceCount(value: string): number {
  return (value.match(/[.!?](?=\s|$)/g) || []).length;
}

export function isSafeFollowUpProductCopy(value: string): boolean {
  const copy = value.replace(/\s+/g, " ").trim();
  return (
    copy.length >= 55 &&
    copy.length <= MAX_COPY_LENGTH &&
    sentenceCount(copy) === 2 &&
    !DISALLOWED_COPY_PATTERNS.some((pattern) => pattern.test(copy))
  );
}

export function fallbackFollowUpProductCopy(article: FollowUpCopyArticle): string {
  const category = article.category?.trim() || "Forschungsbereich";
  return `${article.name} ist eine gezielte Ergänzung für Forschungsprojekte im Bereich ${category}. Wenn du deine bisherige Auswahl sinnvoll erweitern möchtest, ist das eine klare Option im Sortiment.`;
}

export function buildFollowUpCopyPrompt(articles: FollowUpCopyArticle[]): string {
  const catalog = articles.map((article) => ({
    articleId: article.id,
    name: article.name,
    category: article.category || null,
    shortDescription: safePlainText(article.shortDescription),
    description: safePlainText(article.description),
    beautyData: safePlainText(article.beautyData, 700),
  }));

  return `Ausgewählte Produkte:\n${JSON.stringify(catalog)}\n\nErstelle für JEDES ausgewählte Produkt genau einen deutschen Kurztext mit genau zwei kurzen Sätzen. Ton: direkt, konkret, verkaufsstark, nie geschwollen. Der Text muss mit dem Produktnamen beginnen und zuerst klar sagen, wofür das Produkt im jeweiligen Forschungs- bzw. Beauty-Kontext interessant ist. Der zweite Satz ordnet es als gezielte Ergänzung ein.\n\nNutze ausschließlich die gegebenen Katalogdaten und die Produktidentität. Wenn keine detaillierten Katalogdaten vorliegen, bleibe bei der Produktidentität und Kategorie – erfinde keine Reinheit, Verfügbarkeit, Studien oder Wirkversprechen. Bei GHK-Cu darf der Forschungsfokus Beauty/Regeneration sowie Hautmatrix, Kollagen, Elastin und Haarfollikel genannt werden, jedoch nur als Forschungsfokus und niemals als Wirkung am Menschen.\n\nStrikt verboten: Einnahme, Dosierung, Anwendung am Menschen, Therapie, Heilung, Krankheiten, Sicherheit, Nebenwirkungen, klinische Aussagen, Studienergebnisse, Gesundheits- oder Pflegeversprechen. Kein Rabatt, kein Link, keine Begrüßung, keine Emojis, keine Markdown-Formatierung.`;
}

export function parseFollowUpProductCopies(
  raw: unknown,
  selectedArticleIds: number[],
): FollowUpProductCopy[] | null {
  if (typeof raw !== "string") return null;

  try {
    const parsed = JSON.parse(raw) as { productCopies?: Array<{ articleId?: unknown; copy?: unknown }> };
    const copies = parsed.productCopies;
    if (!Array.isArray(copies) || copies.length !== selectedArticleIds.length) return null;

    const byId = new Map<number, string>();
    for (const item of copies) {
      const articleId = Number(item.articleId);
      const copy = typeof item.copy === "string" ? item.copy.replace(/\s+/g, " ").trim() : "";
      if (!selectedArticleIds.includes(articleId) || byId.has(articleId) || !isSafeFollowUpProductCopy(copy)) {
        return null;
      }
      byId.set(articleId, copy);
    }

    return selectedArticleIds.map((articleId) => ({ articleId, copy: byId.get(articleId)! }));
  } catch {
    return null;
  }
}

export async function generateFollowUpProductCopies(
  articles: FollowUpCopyArticle[],
): Promise<FollowUpCopyGeneration> {
  const fallback = (): FollowUpCopyGeneration => ({
    copies: articles.map((article) => ({ articleId: article.id, copy: fallbackFollowUpProductCopy(article) })),
    source: "fallback",
  });

  if (!ENV.forgeApiKey || articles.length === 0 || articles.length > 2) {
    return fallback();
  }

  try {
    const response = await fetch(`${ENV.forgeApiUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ENV.forgeApiKey}`,
      },
      body: JSON.stringify({
        model: FOLLOW_UP_COPY_MODEL,
        temperature: 0.2,
        max_completion_tokens: 900,
        reasoning: { effort: "minimal" },
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "followup_product_copy",
            strict: true,
            schema: {
              type: "object",
              properties: {
                productCopies: {
                  type: "array",
                  minItems: articles.length,
                  maxItems: articles.length,
                  items: {
                    type: "object",
                    properties: {
                      articleId: { type: "integer" },
                      copy: { type: "string" },
                    },
                    required: ["articleId", "copy"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["productCopies"],
              additionalProperties: false,
            },
          },
          messages: [
            {
              role: "system",
              content: "Du schreibst kurze deutsche Produkttexte für einen Research-Shop. Gib ausschließlich valides JSON im verlangten Schema aus.",
            },
            { role: "user", content: buildFollowUpCopyPrompt(articles) },
          ],
        },
      }),
    });

    if (!response.ok) {
      console.warn(`[FollowUp] KI-Produkttext nicht verfügbar (${response.status}); sichere Vorlage wird verwendet.`);
      return fallback();
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const parsed = parseFollowUpProductCopies(
      data.choices?.[0]?.message?.content,
      articles.map((article) => article.id),
    );
    if (!parsed) {
      console.warn("[FollowUp] KI-Produkttext war ungültig; sichere Vorlage wird verwendet.");
      return fallback();
    }

    return { copies: parsed, source: "ai" };
  } catch (error) {
    console.warn("[FollowUp] KI-Produkttext fehlgeschlagen; sichere Vorlage wird verwendet.", error instanceof Error ? error.message : "unknown error");
    return fallback();
  }
}
