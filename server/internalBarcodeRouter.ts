import { randomBytes } from "node:crypto";
import { z } from "zod";
import { router, adminProcedure } from "./trpc.js";
import { getPool } from "./db.js";
import { renderInternalBarcodeLabelSvg } from "./internalBarcodeLabel.js";

function createBarcodeValue(): string {
  // Opaque Code 128 payload; it contains no product name, SKU, dosage, or order data.
  return `369${randomBytes(8).toString("hex").toUpperCase()}`;
}

export const internalBarcodeRouter = router({
  /** Creates one reusable code per physical inventory article/variant. */
  getOrCreateForArticle: adminProcedure
    .input(z.object({ articleId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");

      // The unique article constraint makes repeated calls safe. If concurrent
      // requests race, the loser reads the code created by the winner.
      const inserted = await pool.query(
        `INSERT INTO internal_article_barcodes (article_id, barcode_value, created_by)
         SELECT a.id, $2, $3 FROM articles a WHERE a.id = $1
         ON CONFLICT (article_id) DO NOTHING
         RETURNING article_id AS "articleId", barcode_value AS "barcodeValue", symbology`,
        [input.articleId, createBarcodeValue(), ctx.user.id],
      );
      if (inserted.rows[0]) return inserted.rows[0];

      const existing = await pool.query(
        `SELECT article_id AS "articleId", barcode_value AS "barcodeValue", symbology
           FROM internal_article_barcodes WHERE article_id = $1`,
        [input.articleId],
      );
      if (existing.rows[0]) return existing.rows[0];

      throw new Error("Artikel nicht gefunden; es wurde kein Barcode angelegt");
    }),

  /** Lists only barcode assignments. Protected from public and packing roles. */
  list: adminProcedure.query(async () => {
    const pool = await getPool();
    if (!pool) return [];
    const result = await pool.query(
      `SELECT b.article_id, b.barcode_value, b.symbology, b.created_at,
              a.sku, a.name
         FROM internal_article_barcodes b
         JOIN articles a ON a.id = b.article_id
        ORDER BY b.created_at DESC, b.article_id DESC`,
    );
    return result.rows.map((row) => ({
      articleId: row.article_id,
      barcodeValue: row.barcode_value,
      symbology: row.symbology,
      createdAt: row.created_at,
      sku: row.sku,
      name: row.name,
    }));
  }),

  /** Returns opaque 50 x 30 mm SVG artwork for the NIIMBOT label app. */
  getLabelSvg: adminProcedure
    .input(z.object({ articleId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");
      const result = await pool.query(
        `SELECT barcode_value FROM internal_article_barcodes WHERE article_id = $1`,
        [input.articleId],
      );
      const barcodeValue = result.rows[0]?.barcode_value;
      if (!barcodeValue) throw new Error("Für diesen Artikel ist noch kein Barcode angelegt");
      return renderInternalBarcodeLabelSvg(barcodeValue);
    }),
});
