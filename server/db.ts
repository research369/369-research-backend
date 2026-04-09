import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { ENV } from "./env.js";

const { Pool } = pg;

let _db: ReturnType<typeof drizzle> | null = null;
let _pool: InstanceType<typeof Pool> | null = null;

export async function getDb() {
  if (!_db && ENV.databaseUrl) {
    try {
      _pool = new Pool({
        connectionString: ENV.databaseUrl,
        ssl: ENV.databaseUrl.includes("railway") ? { rejectUnauthorized: false } : undefined,
      });
      _db = drizzle(_pool);
      console.log("[Database] Connected to PostgreSQL");
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function closeDb() {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}
