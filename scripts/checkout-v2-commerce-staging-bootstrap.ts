import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";

const { Client } = pg;

const REQUIRED_FLAGS: Record<string, string> = {
  CHECKOUT_V2_COMMERCE_STAGING: "true",
  CHECKOUT_V2_TEST_MODE: "true",
  FEATURE_CHECKOUT_V2_ENABLED: "true",
};

function fail(message: string): never {
  console.error(`[Checkout V2 Commerce Staging] ${message}`);
  process.exit(1);
}

function assertIsolatedTarget(): string {
  for (const [key, expected] of Object.entries(REQUIRED_FLAGS)) {
    if (process.env[key] !== expected) {
      fail(`${key} must equal ${expected}.`);
    }
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) fail("DATABASE_URL is required.");

  let hostname = "";
  let databaseName = "";
  try {
    const parsed = new URL(databaseUrl);
    hostname = parsed.hostname.toLowerCase();
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, "")).toLowerCase();
  } catch {
    fail("DATABASE_URL must be a valid PostgreSQL URL.");
  }

  const railwayEnvironment = process.env.RAILWAY_ENVIRONMENT_NAME;
  const railwayService = process.env.RAILWAY_SERVICE_NAME;
  if (railwayEnvironment !== undefined && railwayEnvironment !== "commerce-staging") {
    fail("Railway environment must be commerce-staging.");
  }
  if (railwayService !== undefined && railwayService !== "checkout-v2-commerce-staging-backend") {
    fail("Railway service must be checkout-v2-commerce-staging-backend.");
  }

  const explicitAllow = process.env.CHECKOUT_V2_COMMERCE_STAGING_DATABASE_ALLOWLIST?.trim().toLowerCase();
  const hasStagingMarker = `${hostname}/${databaseName}`.includes("checkout-v2-commerce-staging")
    || databaseName.includes("commerce-staging")
    || hostname.includes("commerce-staging");
  const verifiedRailwayIdentity = railwayEnvironment === "commerce-staging"
    && railwayService === "checkout-v2-commerce-staging-backend";
  if (!hasStagingMarker && !verifiedRailwayIdentity && explicitAllow !== databaseName) {
    fail("Target database is not recognizably isolated commerce staging. Set an exact staging database allowlist only for the isolated target.");
  }

  return databaseUrl;
}

function runSchemaPush(): void {
  const currentFile = fileURLToPath(import.meta.url);
  const root = resolve(dirname(currentFile), "..");
  const executable = process.platform === "win32" ? "drizzle-kit.cmd" : "drizzle-kit";
  const localExecutable = resolve(root, "node_modules", ".bin", executable);
  if (!existsSync(localExecutable)) fail("Local drizzle-kit executable was not found.");

  const result = spawnSync(localExecutable, ["push", "--config", "drizzle.config.ts", "--force"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) fail(`Schema bootstrap could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`Schema bootstrap failed with exit code ${result.status ?? "unknown"}.`);
}

async function verifyRequiredObjects(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ tablename: string }>(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = ANY($1::text[])
      ORDER BY tablename
    `, [[
      "articles",
      "customers",
      "order_items",
      "orders",
      "partners",
      "promo_codes",
      "shop_settings",
    ]]);
    const expected = ["articles", "customers", "order_items", "orders", "partners", "promo_codes", "shop_settings"];
    const actual = new Set(rows.map((row) => row.tablename));
    const missing = expected.filter((table) => !actual.has(table));
    if (missing.length > 0) fail(`Required tables are missing after schema bootstrap: ${missing.join(", ")}.`);

    await client.query(`
      CREATE SEQUENCE IF NOT EXISTS checkout_v2_order_id_sequence START WITH 1000000;
      CREATE OR REPLACE FUNCTION next_order_id()
      RETURNS varchar
      LANGUAGE sql
      VOLATILE
      AS $$ SELECT '369-' || nextval('checkout_v2_order_id_sequence')::text $$;
    `);

    await client.query(`
      INSERT INTO shop_settings (key, value)
      VALUES ('kwk_enabled', 'false')
      ON CONFLICT (key) DO NOTHING
    `);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = assertIsolatedTarget();
  runSchemaPush();
  await verifyRequiredObjects(databaseUrl);
  console.log("[Checkout V2 Commerce Staging] Isolated schema bootstrap verified; no product, customer, payment, shipping, email, or WaWi data was seeded.");
}

main().catch((error) => {
  console.error("[Checkout V2 Commerce Staging] Bootstrap failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
