import type { Pool, PoolClient } from "pg";
/** Deliberately no production adapter. Construction checks the actual database identity. */
export class IsolatedPhase1Store {
  private constructor(readonly pool: Pool) {}
  static async connect(pool: Pool) {
    const r = await pool.query("SELECT current_database() AS db");
    if (!/^whatsapp_phase1_test_[a-z0-9_]+$/.test(r.rows[0].db))
      throw Error("isolated_database_required");
    return new IsolatedPhase1Store(pool);
  }
  async transaction<T>(run: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL statement_timeout='5000ms'");
      const result = await run(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
}
