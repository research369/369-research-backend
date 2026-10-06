import { closeDb } from "../db.js";
import { runLegacyCustomerBackfill } from "./legacyCustomerBackfill.js";

async function main() {
  const created = await runLegacyCustomerBackfill();
  console.log(`[Maintenance] Legacy customer backfill completed: ${created} customer record(s) created.`);
}

main()
  .catch((error) => {
    console.error("[Maintenance] Legacy customer backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
