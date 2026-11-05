import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import {AsyncLocalStorage} from 'node:async_hooks';
import { ENV } from "./env.js";

const { Pool } = pg;

let _db: NodePgDatabase | null = null;
let _pool: InstanceType<typeof Pool> | null = null;
const readScope=new AsyncLocalStorage<{db:NodePgDatabase;pool:InstanceType<typeof Pool>}>();
/** Same services, same transaction snapshot, with database-enforced read-only execution. */
export async function withReadOnlyDatabase<T>(work:()=>Promise<T>):Promise<T>{
 const pool=await getPool();if(!pool)throw Error('Database not available');const client=await pool.connect();
 try{await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='8000ms'");
 const scopedPool=new Proxy(pool,{get(target,key){if(key==='query')return client.query.bind(client);if(key==='connect'||key==='end')return ()=>{throw Error('readonly_scope_connection_forbidden');};return Reflect.get(target,key);}});
 const result=await readScope.run({db:drizzle(client),pool:scopedPool},work);await client.query('COMMIT');return result;
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}

export async function getDb() {
  if(readScope.getStore())return readScope.getStore()!.db;
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

export async function getPool() {
  if(readScope.getStore())return readScope.getStore()!.pool;
  if (!_pool && ENV.databaseUrl) {
    await getDb(); // ensures pool is initialized
  }
  return _pool;
}

export async function closeDb() {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}
