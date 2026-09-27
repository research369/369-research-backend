import { z } from "zod";
import { router, goodieProcedure, productManagerProcedure, adminProcedure } from "./trpc.js";
import { getPool } from "./db.js";

const optionalLabel = z.string().trim().max(160).optional().transform((value) => value || undefined);
const optionalGroup = z.string().trim().max(80).optional().transform((value) => value || undefined);

function actor(ctx: { user?: { name?: string | null; username?: string | null } | null }): string {
  return ctx.user?.name || ctx.user?.username || "admin";
}

function generateSku(): string {
  return `GOODIE-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

/**
 * Goodies are deliberately separate from order_items.
 * Their own immutable assignment journal makes packing history visible without
 * touching checkout totals, invoices, payment calculations or the peptide order contract.
 */
export const goodieRouter = router({
  catalog: goodieProcedure.query(async () => {
    const pool = await getPool();
    if (!pool) throw new Error("Datenbank nicht verfügbar");
    const result = await pool.query(`
      SELECT
        gc.id AS catalog_id,
        gc.article_id,
        gc.group_label,
        gc.display_label,
        gc.is_active,
        gc.reward_eligible,
        gc.shop_sellable,
        gc.sort_order,
        a.sku,
        a.name,
        a.stock,
        a.min_stock,
        a.purchase_price,
        a.selling_price,
        a.tax_rate,
        a.notes,
        a.shop_visible,
        a.is_active AS article_is_active,
        a.mockup_image_url,
        a.gallery_images,
        a.short_description
      FROM goodie_catalog gc
      JOIN articles a ON a.id = gc.article_id
      WHERE gc.is_active = TRUE AND a.is_active = 1
      ORDER BY COALESCE(NULLIF(LOWER(gc.group_label), ''), 'zzzz'), gc.sort_order, LOWER(a.name)
    `);
    return result.rows.map((row) => ({
      catalogId: Number(row.catalog_id),
      articleId: Number(row.article_id),
      groupLabel: row.group_label || null,
      displayLabel: row.display_label || null,
      isActive: Boolean(row.is_active),
      rewardEligible: Boolean(row.reward_eligible),
      shopSellable: Boolean(row.shop_sellable),
      sortOrder: Number(row.sort_order),
      sku: row.sku,
      name: row.name,
      stock: Number(row.stock),
      minStock: Number(row.min_stock),
      purchasePrice: Number(row.purchase_price || 0),
      sellingPrice: Number(row.selling_price || 0),
      taxRate: Number(row.tax_rate || 19),
      notes: row.notes || null,
      shopVisible: Number(row.shop_visible || 0),
      imageUrl: row.mockup_image_url || null,
      galleryImages: Array.isArray(row.gallery_images) ? row.gallery_images : [],
      shortDescription: row.short_description || null,
    }));
  }),

  create: productManagerProcedure.input(z.object({
    name: z.string().trim().min(2).max(200),
    sku: z.string().trim().min(2).max(50).optional(),
    groupLabel: optionalGroup,
    displayLabel: optionalLabel,
    purchasePrice: z.number().min(0).max(9999).default(0),
    sellingPrice: z.number().min(0).max(9999).default(0),
    taxRate: z.number().min(0).max(100).default(19),
    stock: z.number().int().min(0).max(999999).default(0),
    minStock: z.number().int().min(0).max(999999).default(0),
    notes: z.string().trim().max(5000).optional(),
    rewardEligible: z.boolean().default(false),
    shopSellable: z.boolean().default(false),
  })).mutation(async ({ input, ctx }) => {
    const pool = await getPool();
    if (!pool) throw new Error("Datenbank nicht verfügbar");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const sku = input.sku || generateSku();
      const articleResult = await client.query(`
        INSERT INTO articles (
          sku, name, category, purchase_price, selling_price, tax_rate,
          stock, min_stock, max_stock, notes, shop_visible, is_active, created_at, updated_at
        ) VALUES ($1, $2, 'Goodies', $3, $4, $5, $6, $7, 999, $8, 0, 1, NOW(), NOW())
        RETURNING id, sku, name, stock
      `, [sku, input.name, input.purchasePrice.toFixed(2), input.sellingPrice.toFixed(2), input.taxRate.toFixed(2), input.stock, input.minStock, input.notes || null]);
      const article = articleResult.rows[0];
      const catalogResult = await client.query(`
        INSERT INTO goodie_catalog (
          article_id, group_label, display_label, reward_eligible, shop_sellable, is_active, sort_order, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, TRUE, 999, NOW(), NOW())
        RETURNING id
      `, [article.id, input.groupLabel || null, input.displayLabel || null, input.rewardEligible, input.shopSellable]);
      if (input.stock > 0) {
        await client.query(`
          INSERT INTO stock_history (
            article_id, change_type, quantity_before, quantity_change, quantity_after, reason, user_name, created_at
          ) VALUES ($1, 'wareneingang', 0, $2, $2, 'Erstbestand Goodie', $3, NOW())
        `, [article.id, input.stock, actor(ctx)]);
      }
      await client.query("COMMIT");
      return { success: true, articleId: Number(article.id), catalogId: Number(catalogResult.rows[0].id), sku: article.sku };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  update: productManagerProcedure.input(z.object({
    articleId: z.number().int().positive(),
    groupLabel: optionalGroup.nullable().optional(),
    displayLabel: optionalLabel.nullable().optional(),
    rewardEligible: z.boolean().optional(),
    shopSellable: z.boolean().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })).mutation(async ({ input }) => {
    const pool = await getPool();
    if (!pool) throw new Error("Datenbank nicht verfügbar");
    const fields: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => { values.push(value); fields.push(`${column} = $${values.length}`); };
    if (input.groupLabel !== undefined) set("group_label", input.groupLabel || null);
    if (input.displayLabel !== undefined) set("display_label", input.displayLabel || null);
    if (input.rewardEligible !== undefined) set("reward_eligible", input.rewardEligible);
    if (input.shopSellable !== undefined) set("shop_sellable", input.shopSellable);
    if (input.isActive !== undefined) set("is_active", input.isActive);
    if (input.sortOrder !== undefined) set("sort_order", input.sortOrder);
    if (fields.length === 0) return { success: true };
    fields.push("updated_at = NOW()");
    values.push(input.articleId);
    const result = await pool.query(`UPDATE goodie_catalog SET ${fields.join(", ")} WHERE article_id = $${values.length}`, values);
    if ((result.rowCount || 0) !== 1) throw new Error("Goodie nicht gefunden");
    return { success: true };
  }),

  assignmentsForOrder: goodieProcedure.input(z.object({ orderId: z.string().trim().min(1).max(32) })).query(async ({ input }) => {
    const pool = await getPool();
    if (!pool) throw new Error("Datenbank nicht verfügbar");
    const result = await pool.query(`
      SELECT id, order_id, customer_id, article_id, article_name_snapshot, sku_snapshot,
             display_label_snapshot, group_label_snapshot, quantity, source, assigned_by,
             assigned_at, reversed_at, reversed_by, reversal_reason
      FROM goodie_assignments
      WHERE order_id = $1
      ORDER BY assigned_at ASC, id ASC
    `, [input.orderId]);
    return result.rows.map((row) => ({
      id: Number(row.id), orderId: row.order_id, customerId: row.customer_id === null ? null : Number(row.customer_id), articleId: Number(row.article_id),
      articleName: row.article_name_snapshot, sku: row.sku_snapshot, displayLabel: row.display_label_snapshot || null,
      groupLabel: row.group_label_snapshot || null, quantity: Number(row.quantity), source: row.source,
      assignedBy: row.assigned_by, assignedAt: row.assigned_at, reversedAt: row.reversed_at || null,
      reversedBy: row.reversed_by || null, reversalReason: row.reversal_reason || null,
    }));
  }),

  historyForOrder: goodieProcedure.input(z.object({ orderId: z.string().trim().min(1).max(32) })).query(async ({ input }) => {
    const pool = await getPool();
    if (!pool) throw new Error("Datenbank nicht verfügbar");
    const currentOrder = await pool.query(`SELECT customer_id FROM orders WHERE order_id = $1 LIMIT 1`, [input.orderId]);
    const customerId = currentOrder.rows[0]?.customer_id;
    if (!customerId) return [];
    const result = await pool.query(`
      SELECT ga.id, ga.order_id, ga.article_name_snapshot, ga.display_label_snapshot,
             ga.quantity, ga.assigned_at, o.order_date
      FROM goodie_assignments ga
      JOIN orders o ON o.order_id = ga.order_id
      WHERE ga.customer_id = $1 AND ga.reversed_at IS NULL AND ga.order_id <> $2
      ORDER BY ga.assigned_at DESC, ga.id DESC
      LIMIT 100
    `, [customerId, input.orderId]);
    return result.rows.map((row) => ({
      id: Number(row.id),
      orderId: row.order_id,
      name: row.article_name_snapshot,
      displayLabel: row.display_label_snapshot || null,
      quantity: Number(row.quantity),
      assignedAt: row.assigned_at,
      orderDate: row.order_date,
    }));
  }),

  assign: goodieProcedure.input(z.object({
    orderId: z.string().trim().min(1).max(32),
    articleId: z.number().int().positive(),
    quantity: z.number().int().min(1).max(999).default(1),
    requestId: z.string().uuid(),
  })).mutation(async ({ input, ctx }) => {
    const pool = await getPool();
    if (!pool) throw new Error("Datenbank nicht verfügbar");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existingResult = await client.query(`
        SELECT ga.id, a.stock
        FROM goodie_assignments ga
        JOIN articles a ON a.id = ga.article_id
        WHERE ga.request_id = $1
        LIMIT 1
      `, [input.requestId]);
      if (existingResult.rows.length === 1) {
        await client.query("COMMIT");
        return {
          success: true,
          alreadyAssigned: true,
          assignmentId: Number(existingResult.rows[0].id),
          remainingStock: Number(existingResult.rows[0].stock),
          assignedAt: null as string | null,
        };
      }
      const orderResult = await client.query(`SELECT order_id, customer_id FROM orders WHERE order_id = $1 FOR UPDATE`, [input.orderId]);
      if (orderResult.rows.length !== 1) throw new Error("Bestellung nicht gefunden");
      const goodieResult = await client.query(`
        SELECT gc.article_id, gc.group_label, gc.display_label, a.sku, a.name, a.stock
        FROM goodie_catalog gc
        JOIN articles a ON a.id = gc.article_id
        WHERE gc.article_id = $1 AND gc.is_active = TRUE AND a.is_active = 1
        FOR UPDATE OF gc, a
      `, [input.articleId]);
      if (goodieResult.rows.length !== 1) throw new Error("Dieses Goodie ist nicht aktiv");
      const goodie = goodieResult.rows[0];
      const previousStock = Number(goodie.stock);
      if (previousStock < input.quantity) {
        throw new Error(`Nicht genug Bestand: verfügbar ${previousStock}, benötigt ${input.quantity}`);
      }
      const nextStock = previousStock - input.quantity;
      await client.query(`UPDATE articles SET stock = $1, updated_at = NOW() WHERE id = $2`, [nextStock, goodie.article_id]);
      await client.query(`
        INSERT INTO stock_history (
          article_id, change_type, quantity_before, quantity_change, quantity_after, reason, order_id, user_name, created_at
        ) VALUES ($1, 'verkauf', $2, $3, $4, $5, $6, $7, NOW())
      `, [goodie.article_id, previousStock, -input.quantity, nextStock, `Goodie-Ausgabe zu Bestellung ${input.orderId}`, input.orderId, actor(ctx)]);
      const assignment = await client.query(`
        INSERT INTO goodie_assignments (
          order_id, customer_id, article_id, article_name_snapshot, sku_snapshot,
          display_label_snapshot, group_label_snapshot, quantity, source, request_id, assigned_by, assigned_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'packing_manual', $9, $10, NOW())
        ON CONFLICT DO NOTHING
        RETURNING id, assigned_at
      `, [input.orderId, orderResult.rows[0].customer_id, goodie.article_id, goodie.name, goodie.sku,
        goodie.display_label || null, goodie.group_label || null, input.quantity, input.requestId, actor(ctx)]);
      if (assignment.rows.length !== 1) {
        // A simultaneous retry won the unique request_id race. Roll back this
        // transaction (including its temporary stock decrease) and return the
        // already persisted result instead of ever booking the Goodie twice.
        await client.query("ROLLBACK");
        const duplicate = await pool.query(`
          SELECT ga.id, a.stock
          FROM goodie_assignments ga
          JOIN articles a ON a.id = ga.article_id
          WHERE ga.request_id = $1
          LIMIT 1
        `, [input.requestId]);
        if (duplicate.rows.length !== 1) throw new Error("Goodie-Ausgabe konnte nicht eindeutig gespeichert werden");
        return {
          success: true,
          alreadyAssigned: true,
          assignmentId: Number(duplicate.rows[0].id),
          remainingStock: Number(duplicate.rows[0].stock),
          assignedAt: null as string | null,
        };
      }
      await client.query("COMMIT");
      return { success: true, alreadyAssigned: false, assignmentId: Number(assignment.rows[0].id), remainingStock: nextStock, assignedAt: assignment.rows[0].assigned_at };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  reverseAssignment: goodieProcedure.input(z.object({
    assignmentId: z.number().int().positive(),
    reason: z.string().trim().min(2).max(500).default("Packkorrektur"),
  })).mutation(async ({ input, ctx }) => {
    const pool = await getPool();
    if (!pool) throw new Error("Datenbank nicht verfügbar");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const assignmentResult = await client.query(`
        SELECT id, order_id, article_id, quantity, article_name_snapshot, reversed_at
        FROM goodie_assignments WHERE id = $1 FOR UPDATE
      `, [input.assignmentId]);
      if (assignmentResult.rows.length !== 1) throw new Error("Goodie-Ausgabe nicht gefunden");
      const assignment = assignmentResult.rows[0];
      if (assignment.reversed_at) throw new Error("Diese Goodie-Ausgabe wurde bereits korrigiert");
      const articleResult = await client.query(`SELECT id, stock FROM articles WHERE id = $1 FOR UPDATE`, [assignment.article_id]);
      if (articleResult.rows.length !== 1) throw new Error("Lagerartikel nicht gefunden");
      const previousStock = Number(articleResult.rows[0].stock);
      const nextStock = previousStock + Number(assignment.quantity);
      await client.query(`UPDATE articles SET stock = $1, updated_at = NOW() WHERE id = $2`, [nextStock, assignment.article_id]);
      await client.query(`
        UPDATE goodie_assignments
        SET reversed_at = NOW(), reversed_by = $1, reversal_reason = $2
        WHERE id = $3
      `, [actor(ctx), input.reason, assignment.id]);
      await client.query(`
        INSERT INTO stock_history (
          article_id, change_type, quantity_before, quantity_change, quantity_after, reason, order_id, user_name, created_at
        ) VALUES ($1, 'retoure', $2, $3, $4, $5, $6, $7, NOW())
      `, [assignment.article_id, previousStock, Number(assignment.quantity), nextStock, `Goodie-Korrektur: ${input.reason}`, assignment.order_id, actor(ctx)]);
      await client.query("COMMIT");
      return { success: true, remainingStock: nextStock };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  rewardConfig: adminProcedure.query(async () => {
    const pool = await getPool();
    if (!pool) throw new Error("Datenbank nicht verfügbar");
    const result = await pool.query(`SELECT enabled, qualification_basis, tiers_json, updated_at, updated_by FROM goodie_reward_config WHERE id = 1`);
    const row = result.rows[0];
    return {
      enabled: Boolean(row?.enabled),
      qualificationBasis: row?.qualification_basis || "after_discount_excluding_shipping",
      tiers: Array.isArray(row?.tiers_json) ? row.tiers_json : [],
      updatedAt: row?.updated_at || null,
      updatedBy: row?.updated_by || null,
    };
  }),

  updateRewardConfig: adminProcedure.input(z.object({
    enabled: z.boolean(),
    qualificationBasis: z.literal("after_discount_excluding_shipping").default("after_discount_excluding_shipping"),
    tiers: z.array(z.object({
      minimumSubtotal: z.number().nonnegative().max(100000),
      selectionCount: z.number().int().min(1).max(10).default(1),
      articleIds: z.array(z.number().int().positive()).min(1).max(50),
    })).max(20),
  })).mutation(async ({ input, ctx }) => {
    const pool = await getPool();
    if (!pool) throw new Error("Datenbank nicht verfügbar");
    await pool.query(`
      UPDATE goodie_reward_config
      SET enabled = $1, qualification_basis = $2, tiers_json = $3::jsonb, updated_at = NOW(), updated_by = $4
      WHERE id = 1
    `, [input.enabled, input.qualificationBasis, JSON.stringify(input.tiers), actor(ctx)]);
    return { success: true };
  }),
});
