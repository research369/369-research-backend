import { createHmac, randomBytes, randomInt } from "node:crypto";
import type { Request } from "express";
import type { Pool, PoolClient } from "pg";
import { TRPCError } from "@trpc/server";
import { ENV } from "./env.js";
import { getPool } from "./db.js";

type AccountKind = "partner" | "kwk";
const config = {
  partner: { table: "partners", resetTable: "partner_password_resets", id: "partner_id", active: "is_active = 1" },
  kwk: { table: "kwk_accounts", resetTable: "kwk_account_password_resets", id: "kwk_id", active: "status = 'aktiv' AND deleted_at IS NULL" },
} as const;
export function authDigest(domain: string, value: string): string {
  return createHmac("sha256", ENV.jwtSecret).update(`369:auth:${domain}:v1:${value}`).digest("hex");
}
function resetDigest(kind: AccountKind, id: number, secret: string): string {
  return authDigest(kind === "kwk" ? "reset:kwk" : `reset:partner:${id}`, secret);
}
export function newResetSecret(kind: AccountKind): string {
  return kind === "partner" ? randomInt(100000, 1000000).toString() : randomBytes(32).toString("hex");
}
export function sanitizePartnerNotes(notes: string | null): string | null {
  return notes?.replace(/\|?__RESET_CODE__:[^|]*/g, "") || null;
}
async function database(pool?: Pool): Promise<Pool> {
  const result = pool || await getPool();
  if (!result) throw new Error("Database not available");
  return result;
}

// No User-Agent / client supplied forwarded-address / internal-header exemptions.
// Express defaults to the socket peer. A deployment may configure ONLY its trusted
// reverse proxy chain centrally; never trust arbitrary x-forwarded-for here.
export async function enforceAuthRateLimit(req: Request, action: string, identity: string, pool?: Pool): Promise<void> {
  const db = await database(pool);
  const peer = req.ip || req.socket?.remoteAddress || "unknown";
  for (const [dimension, value, max] of [["ip", peer, 30], ["identity", identity.trim().toLowerCase(), 10]] as const) {
    const bucket = authDigest("rate", `${action}:${dimension}:${value}`);
    const result = await db.query(`INSERT INTO account_auth_rate_limits (bucket_hash, window_started_at, attempts)
      VALUES ($1, NOW(), 1) ON CONFLICT (bucket_hash) DO UPDATE SET
      attempts = CASE WHEN account_auth_rate_limits.window_started_at <= NOW() - INTERVAL '15 minutes' THEN 1 ELSE account_auth_rate_limits.attempts + 1 END,
      window_started_at = CASE WHEN account_auth_rate_limits.window_started_at <= NOW() - INTERVAL '15 minutes' THEN NOW() ELSE account_auth_rate_limits.window_started_at END
      RETURNING attempts`, [bucket]);
    if (Number(result.rows[0].attempts) > max) {
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Zu viele Versuche. Bitte in 15 Minuten erneut versuchen." });
    }
  }
  // Bounded retention without disclosing IPs or identifiers in storage/logs.
  await db.query("DELETE FROM account_auth_rate_limits WHERE window_started_at < NOW() - INTERVAL '1 day'");
}
async function lockAccount(client: PoolClient, kind: AccountKind, id: number, activeOnly = true) {
  const c = config[kind];
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`369:password:${kind}:${id}`]);
  const result = await client.query(`SELECT id, password_hash, session_version FROM ${c.table} WHERE id = $1 ${activeOnly ? `AND ${c.active}` : ""} FOR UPDATE`, [id]);
  return result.rows[0];
}

// Each account has one reset slot. Account lock serializes request, claim and
// password writes. Cooldown cannot be raced or reset by incorrect submissions.
export async function issueAccountReset(kind: AccountKind, id: number, pool?: Pool): Promise<string | null> {
  const db = await database(pool);
  const client = await db.connect();
  const c = config[kind];
  try {
    await client.query("BEGIN");
    if (!await lockAccount(client, kind, id)) { await client.query("COMMIT"); return null; }
    const secret = newResetSecret(kind);
    const result = await client.query(`INSERT INTO ${c.resetTable} (${c.id}, token_hash, requested_at, expires_at)
      VALUES ($1, $2, NOW(), NOW() + INTERVAL '${kind === "partner" ? "15 minutes" : "1 hour"}')
      ON CONFLICT (${c.id}) DO UPDATE SET token_hash = EXCLUDED.token_hash, requested_at = NOW(),
        expires_at = EXCLUDED.expires_at, used_at = NULL, attempts = 0
      WHERE ${c.resetTable}.requested_at <= NOW() - INTERVAL '15 minutes' RETURNING ${c.id}`,
      [id, resetDigest(kind, id, secret)]);
    await client.query("COMMIT");
    return result.rows.length ? secret : null;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
export async function invalidateAccountReset(kind: AccountKind, id: number, secret: string, pool?: Pool): Promise<void> {
  const db = await database(pool);
  const c = config[kind];
  await db.query(`UPDATE ${c.resetTable} SET used_at = NOW() WHERE ${c.id} = $1 AND token_hash = $2`, [id, resetDigest(kind, id, secret)]);
}
export async function findKwkResetAccount(secret: string, pool?: Pool): Promise<number | null> {
  // Index-backed hashed lookup; ownership is held by the reset-table FK.
  const db = await database(pool);
  const rows = await db.query("SELECT kwk_id FROM kwk_account_password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() AND attempts < 5", [resetDigest("kwk", 0, secret)]);
  return rows.rows[0] ? Number(rows.rows[0].kwk_id) : null;
}
export async function confirmAccountReset(kind: AccountKind, id: number, secret: string, passwordHash: string, pool?: Pool): Promise<boolean> {
  const db = await database(pool);
  const client = await db.connect();
  const c = config[kind];
  try {
    await client.query("BEGIN");
    if (!await lockAccount(client, kind, id)) { await client.query("COMMIT"); return false; }
    // The conditional UPDATE is the atomic claim. Failed tries are committed as
    // well; rolling them back on an error would silently defeat attempt limits.
    const claim = await client.query(`UPDATE ${c.resetTable} SET attempts = attempts + 1,
      used_at = CASE WHEN token_hash = $2 THEN NOW() ELSE used_at END
      WHERE ${c.id} = $1 AND used_at IS NULL AND expires_at > NOW() AND attempts < 5
      RETURNING token_hash = $2 AS matched`, [id, resetDigest(kind, id, secret)]);
    if (claim.rows[0]?.matched !== true) { await client.query("COMMIT"); return false; }
    await client.query(`UPDATE ${c.table} SET password_hash = $1, session_version = session_version + 1, updated_at = NOW() WHERE id = $2`, [passwordHash, id]);
    await client.query("COMMIT");
    return true;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function writeAccountPassword(kind: AccountKind, id: number, passwordHash: string,
  expected?: { passwordHash: string; sessionVersion: number }, pool?: Pool): Promise<void> {
  const db = await database(pool);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await writePasswordOnClient(client, kind, id, passwordHash, expected);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
async function writePasswordOnClient(client: PoolClient, kind: AccountKind, id: number, passwordHash: string,
  expected?: { passwordHash: string; sessionVersion: number }): Promise<void> {
  const account = await lockAccount(client, kind, id, !!expected);
  if (!account) throw new Error("Konto nicht gefunden");
  if (expected && (account.password_hash !== expected.passwordHash || Number(account.session_version) !== expected.sessionVersion)) {
    throw new TRPCError({ code: "CONFLICT", message: "Passwort wurde zwischenzeitlich geändert. Bitte erneut einloggen." });
  }
  const c = config[kind];
  await client.query(`UPDATE ${c.table} SET password_hash = $1, session_version = session_version + 1, updated_at = NOW() WHERE id = $2`, [passwordHash, id]);
  await client.query(`UPDATE ${c.resetTable} SET used_at = NOW() WHERE ${c.id} = $1 AND used_at IS NULL`, [id]);
}

export type CredentialsResult = { success: boolean; passwordSaved: true; emailStatus: "accepted" | "failed" | "unknown"; message: string };
// Provider delivery and a DB commit cannot be one atomic transaction. Commit the
// actual password before submitting; serialize all password paths until provider
// acceptance so a concurrent reset cannot make the emailed value stale. Never
// undo a committed password after a possibly accepted email.
export async function setupAndSendPartnerCredentials(id: number, passwordHash: string,
  send: () => Promise<{ ok: boolean }>, pool?: Pool): Promise<CredentialsResult> {
  const db = await database(pool);
  const client = await db.connect();
  let locked = false;
  let destroyed = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [`369:password:partner:${id}`]);
    locked = true;
    await client.query("BEGIN");
    try { await writePasswordOnClient(client, "partner", id, passwordHash); await client.query("COMMIT"); }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    try {
      const response = await send();
      return response.ok
        ? { success: true, passwordSaved: true, emailStatus: "accepted", message: "Passwort gespeichert; Zugangsdaten vom E-Mail-Service angenommen (Zustellung nicht bestätigt)." }
        : { success: false, passwordSaved: true, emailStatus: "failed", message: "Passwort gespeichert, aber E-Mail-Service hat den Versand abgelehnt. Nicht als zugestellt melden." };
    } catch {
      return { success: false, passwordSaved: true, emailStatus: "unknown", message: "Passwort gespeichert; Versandstatus wegen Verbindungsfehler unbekannt. Vor erneutem Versand prüfen." };
    }
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`369:password:partner:${id}`]); }
      catch { client.release(true); destroyed = true; }
    }
    if (!destroyed) client.release();
  }
}
