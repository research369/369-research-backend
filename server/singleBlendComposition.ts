import { z } from "zod";

/** Approved single-vial identity only; not a general blend/formulation service. */
export const singleBlendCompositionSchema = z.object({
  version: z.literal(1), kind: z.literal("blend"), basis: z.literal("single-vial"),
  totalMassMg: z.literal(15),
  components: z.tuple([
    z.object({ id: z.literal("tesamorelin"), name: z.literal("Tesamorelin"), massMg: z.literal(10) }).strict(),
    z.object({ id: z.literal("ipamorelin"), name: z.literal("Ipamorelin"), massMg: z.literal(5) }).strict(),
  ]),
}).strict();
export type SingleBlendComposition = z.infer<typeof singleBlendCompositionSchema>;

type BlendArticle = {
  id: number; shopProductId?: string | null; sku: string; description?: unknown; variants: unknown;
};

/** No name/SKU-suffix parsing or inferred component masses. */
export function getSingleBlendComposition(article: BlendArticle): SingleBlendComposition | null {
  if (article.shopProductId !== "somatide" || article.sku !== "SOMATIDE-15MG"
    || !Number.isInteger(article.id) || article.id <= 0
    || !Array.isArray(article.variants) || article.variants.length !== 1) return null;
  const v = article.variants[0];
  if (!v || typeof v !== "object" || v.label !== "15 mg" || v.dosage !== "15 mg"
    || v.sku !== "SOMATIDE-15MG" || v.inventoryArticleId !== article.id
    || v.hidden === true || v.isActive === false || v.isActive === 0) return null;
  const d = article.description;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const parsed = singleBlendCompositionSchema.safeParse((d as Record<string, unknown>).composition);
  return parsed.success ? parsed.data : null;
}

/** Scalar chemistry may be absent only for the exact, structurally valid blend. */
export function hasNoCommonBlendChemistry(article: { casNumber?: unknown; molecularWeight?: unknown }) {
  return (article.casNumber === null || article.casNumber === "")
    && (article.molecularWeight === null || article.molecularWeight === "");
}

/** Public composition additionally requires exactly one actual inventory row. */
export function getPublicSingleBlendComposition(article: BlendArticle,
  inventory: Array<{ id: number; sku: string; shopProductId: string | null }>): SingleBlendComposition | null {
  const rows = inventory.filter(row => row.shopProductId === "somatide");
  if (rows.length !== 1 || rows[0].id !== article.id || rows[0].sku !== "SOMATIDE-15MG") return null;
  return getSingleBlendComposition(article);
}
