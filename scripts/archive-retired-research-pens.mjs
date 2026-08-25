import pg from "pg";

const { Pool } = pg;

const targets = [
  { id: 115, sku: "PEN-GOLD" },
  { id: 116, sku: "PEN-BLAU" },
  { id: 132, sku: "PEN-LILA" },
  { id: 133, sku: "PEN-ROSA" },
];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes("railway") ? { rejectUnauthorized: false } : undefined,
});

const client = await pool.connect();

try {
  await client.query("BEGIN");

  const ids = targets.map(({ id }) => id);
  const current = await client.query(
    `SELECT id, sku, name, is_active, shop_visible, stock
       FROM articles
      WHERE id = ANY($1::int[])
      ORDER BY id
      FOR UPDATE`,
    [ids],
  );

  if (current.rows.length !== targets.length) {
    throw new Error(
      `Safety check failed: expected ${targets.length} exact article IDs, found ${current.rows.length}`,
    );
  }

  for (const target of targets) {
    const row = current.rows.find((candidate) => candidate.id === target.id);
    if (!row || row.sku !== target.sku) {
      throw new Error(
        `Safety check failed for article ${target.id}: expected SKU ${target.sku}`,
      );
    }
  }

  const result = await client.query(
    `UPDATE articles
        SET is_active = 0,
            shop_visible = 0,
            updated_at = NOW()
      WHERE (id = $1 AND sku = $2)
         OR (id = $3 AND sku = $4)
         OR (id = $5 AND sku = $6)
         OR (id = $7 AND sku = $8)
      RETURNING id, sku, name, is_active, shop_visible, stock`,
    [
      targets[0].id, targets[0].sku,
      targets[1].id, targets[1].sku,
      targets[2].id, targets[2].sku,
      targets[3].id, targets[3].sku,
    ],
  );

  if (result.rows.length !== targets.length) {
    throw new Error(
      `Safety check failed: expected to archive ${targets.length} articles, updated ${result.rows.length}`,
    );
  }

  await client.query("COMMIT");

  console.log("[RetiredPens] Archived exact legacy articles:", result.rows);
} catch (error) {
  await client.query("ROLLBACK");
  console.error("[RetiredPens] No changes committed:", error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
