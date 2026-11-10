import assert from "node:assert/strict";
import nodeTest, { before, after, beforeEach, mock } from "node:test";
const enabled = process.env.ACCOUNT_SECURITY_POSTGRES_TEST === "1";
const test = enabled ? nodeTest : nodeTest.skip;
import pg from "pg";
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getTableColumns } from "drizzle-orm";
import { partners } from "../drizzle/schema.js";
import { ENV } from "./env.js";
import { ensureAdminChangeLogSchema } from "./adminChangeLogService.js";
import { closeDb } from "./db.js";
import { ACCOUNT_SECURITY_SQL, ensureAccountSecuritySchema, isAccountSecuritySchemaReady } from "./accountSecuritySchema.js";
import { authDigest, confirmAccountReset, enforceAuthRateLimit, findKwkResetAccount, invalidateAccountReset, issueAccountReset, newResetSecret, sanitizePartnerNotes, setupAndSendPartnerCredentials, writeAccountPassword } from "./accountSecurityService.js";
import { createPartnerToken, getAuthenticatedPartnerFromRequest, verifyPartnerToken } from "./partnerAuth.js";
import { createKwkToken, getAuthenticatedKwkFromToken, verifyKwkToken } from "./kwkAuth.js";
import { partnerRouter } from "./partnerRouter.js";
import { kwkRouter } from "./kwkRouter.js";

// Reserved UNIX-only PostgreSQL instance. No productive URL, no external socket,
// and provider calls are mocked before any router mutation is invoked.
const socket = "/tmp/369-accounts-pg-20261106/socket";
const adminPool = new pg.Pool({ host: socket, port: 56437, user: "accounts_test", database: "postgres" });
let pool: pg.Pool;
let createdDatabase = false;
const oldUrl = ENV.databaseUrl;
const request = (token?: string, peer = "198.51.100.22") => ({
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "user-agent": "python-requests", "x-forwarded-for": "10.0.0.1" },
  ip: peer, socket: { remoteAddress: peer },
}) as any;
const calls: Array<{ name: string; args: unknown[] }> = [];
let fetchCount = 0;
let passwordHash: string;
function caller(admin = false, token?: string) {
  return partnerRouter.createCaller({ req: request(token), res: { clearCookie: (...args: unknown[]) => calls.push({ name: "clearCookie", args }), cookie: () => {} },
    user: admin ? { id: 1, username: "synthetic-admin", name: null, email: null, role: "admin" } : null } as any);
}
before(async () => {
  if (!enabled) return;
  assert.equal(process.env.DATABASE_URL || "", "", "test process must start without DB URL");
  assert.equal(process.env.RESEND_API_KEY || "", "", "provider keys must be empty");
  mock.method(globalThis, "fetch", async () => { fetchCount++; throw new Error("EXTERNAL_HTTP_FORBIDDEN"); });
  await adminPool.query("CREATE DATABASE accounts_security_synthetic_test");
  createdDatabase = true;
  pool = new pg.Pool({ host: socket, port: 56437, user: "accounts_test", database: "accounts_security_synthetic_test", max: 12 });
  await pool.query("CREATE TYPE commission_type AS ENUM ('einmalig', 'dauerhaft')");
  const cols = Object.values(getTableColumns(partners)).map(col => `${col.name} ${col.getSQLType()}${col.name === "id" ? " PRIMARY KEY" : ""}`);
  await pool.query(`CREATE TABLE partners (${cols.join(",")})`);
  await pool.query("CREATE TABLE kwk_accounts (id SERIAL PRIMARY KEY, email TEXT UNIQUE, name TEXT, password_hash TEXT, status TEXT DEFAULT 'aktiv', deleted_at TIMESTAMP, updated_at TIMESTAMP)");
  passwordHash = await bcrypt.hash("synthetic-old-password", 4);
  await pool.query("INSERT INTO partners (id, name, partner_number, code, password_hash, is_active, notes, commission_percent, customer_discount_percent, credit_balance, program_key, commission_type, updated_at) VALUES (1, 'Synthetic', 'OWN-1', 'SYNTHETIC', $1, 1, 'ordinary note|__RESET_CODE__:123456:legacy', '10','10','0','partner','dauerhaft',NOW()), (2, 'Synthetic B', 'OWN-2', 'SYNTHETIC-B', $1, 1, NULL, '10','10','0','partner','dauerhaft',NOW())", [passwordHash]);
  await pool.query("INSERT INTO kwk_accounts (id,email,name,password_hash) VALUES (1,'synthetic@example.test','Synthetic',$1)", [passwordHash]);
  await pool.query(ACCOUNT_SECURITY_SQL);
  await closeDb();
  ENV.databaseUrl = `postgresql://accounts_test@localhost:56437/accounts_security_synthetic_test?host=${encodeURIComponent(socket)}`;
  await ensureAdminChangeLogSchema();
});
beforeEach(async () => {
  if (!enabled) return;
  calls.length = 0; fetchCount = 0;
  await pool.query("TRUNCATE partner_password_resets, kwk_account_password_resets, account_auth_rate_limits");
  await pool.query("UPDATE partners SET password_hash = $1, session_version = 0, is_active = 1, email = 'synthetic@example.test', notes = 'ordinary note'", [passwordHash]);
  await pool.query("UPDATE kwk_accounts SET password_hash = $1, session_version = 0, status = 'aktiv', deleted_at = NULL", [passwordHash]);
});
after(async () => {
  if (!enabled) return;
  // Allow existing fire-and-forget admin audit to finish before closing pools.
  await new Promise(resolve => setTimeout(resolve, 100));
  await closeDb(); ENV.databaseUrl = oldUrl; mock.restoreAll();
  if (pool) await pool.end();
  if (!createdDatabase) { await adminPool.end(); return; }
  const remaining = await adminPool.query("SELECT pid, application_name, state FROM pg_stat_activity WHERE datname = 'accounts_security_synthetic_test'");
  assert.equal(remaining.rows.length, 0, `test connections still live: ${JSON.stringify(remaining.rows)}`);
  await adminPool.query("DROP DATABASE IF EXISTS accounts_security_synthetic_test");
  await adminPool.end();
});

test("migration and startup are repeatable, version0 preserved, legacy note secrets removed", async () => {
  await pool.query("UPDATE partners SET notes = 'before|__RESET_CODE__:654321:legacy|after' WHERE id = 1");
  await ensureAccountSecuritySchema(); await ensureAccountSecuritySchema();
  assert.equal(isAccountSecuritySchemaReady(), true);
  const row = (await pool.query("SELECT notes, session_version FROM partners WHERE id=1")).rows[0];
  assert.equal(row.notes, "before|after"); assert.equal(row.session_version, 0);
  assert.equal(sanitizePartnerNotes("normal|__RESET_CODE__:123456:secret|text"), "normal|text");
});
test("cryptographic reset secret format, keyed/domain-separated hashes and no plaintext notes", async () => {
  assert.match(newResetSecret("partner"), /^\d{6}$/); assert.match(newResetSecret("kwk"), /^[a-f0-9]{64}$/);
  assert.notEqual(authDigest("a", "same"), authDigest("b", "same"));
  const secret = await issueAccountReset("partner", 1, pool);
  const reset = (await pool.query("SELECT * FROM partner_password_resets WHERE partner_id=1")).rows[0];
  assert.equal(reset.token_hash.length, 64); assert.notEqual(reset.token_hash, secret);
  assert.equal((await pool.query("SELECT notes FROM partners WHERE id=1")).rows[0].notes, "ordinary note");
});
test("concurrent reset requests issue only one secret; cooldown is durable", async () => {
  const issued = await Promise.all(Array.from({ length: 8 }, () => issueAccountReset("partner", 1, pool)));
  assert.equal(issued.filter(Boolean).length, 1);
  assert.equal(await issueAccountReset("partner", 1, pool), null);
  await pool.query("UPDATE partner_password_resets SET requested_at=NOW()-INTERVAL '16 minutes'");
  assert.match((await issueAccountReset("partner", 1, pool))!, /^\d{6}$/);
});
test("five wrong tries persist and lock a short code; valid code cannot bypass attempts", async () => {
  const secret = (await issueAccountReset("partner", 1, pool))!;
  const wrong = secret === "000000" ? "000001" : "000000";
  for (let i = 0; i < 5; i++) assert.equal(await confirmAccountReset("partner", 1, wrong, "changed", pool), false);
  assert.equal(await confirmAccountReset("partner", 1, secret, "changed", pool), false);
  assert.equal((await pool.query("SELECT attempts FROM partner_password_resets")).rows[0].attempts, 5);
  assert.equal((await pool.query("SELECT session_version FROM partners WHERE id=1")).rows[0].session_version, 0);
});
test("expired and explicitly invalidated codes cannot change password", async () => {
  const secret = (await issueAccountReset("partner", 1, pool))!;
  await pool.query("UPDATE partner_password_resets SET expires_at=NOW()-INTERVAL '1 second'");
  assert.equal(await confirmAccountReset("partner", 1, secret, "changed", pool), false);
  await pool.query("UPDATE partner_password_resets SET expires_at=NOW()+INTERVAL '1 hour'");
  await invalidateAccountReset("partner", 1, secret, pool);
  assert.equal(await confirmAccountReset("partner", 1, secret, "changed", pool), false);
});
test("concurrent claims change password/version exactly once and replay is denied", async () => {
  const secret = (await issueAccountReset("partner", 1, pool))!;
  const results = await Promise.all(Array.from({ length: 8 }, () => confirmAccountReset("partner", 1, secret, "new-hash", pool)));
  assert.equal(results.filter(Boolean).length, 1);
  const row = (await pool.query("SELECT password_hash,session_version FROM partners WHERE id=1")).rows[0];
  assert.equal(row.password_hash, "new-hash"); assert.equal(row.session_version, 1);
  assert.equal(await confirmAccountReset("partner", 1, secret, "replay", pool), false);
});
test("claim/password failure rolls back token consumption, attempt and version together", async () => {
  const secret = (await issueAccountReset("partner", 1, pool))!;
  await pool.query("ALTER TABLE partners ADD CONSTRAINT synthetic_password_failure CHECK (password_hash <> 'forbidden-hash')");
  try { await assert.rejects(confirmAccountReset("partner", 1, secret, "forbidden-hash", pool)); }
  finally { await pool.query("ALTER TABLE partners DROP CONSTRAINT synthetic_password_failure"); }
  const reset = (await pool.query("SELECT used_at,attempts FROM partner_password_resets")).rows[0];
  assert.equal(reset.used_at, null); assert.equal(reset.attempts, 0);
  assert.equal((await pool.query("SELECT session_version FROM partners WHERE id=1")).rows[0].session_version, 0);
  assert.equal(await confirmAccountReset("partner", 1, secret, "allowed-hash", pool), true);
});
test("KWK hashed bearer link preserves owner, atomically claims once and revokes session", async () => {
  const token = createKwkToken(1, 0);
  assert.ok(await getAuthenticatedKwkFromToken(token));
  const secret = (await issueAccountReset("kwk", 1, pool))!;
  assert.equal(await findKwkResetAccount(secret, pool), 1);
  assert.equal(await findKwkResetAccount("a".repeat(64), pool), null);
  const results = await Promise.all([confirmAccountReset("kwk", 1, secret, "kwk-new", pool), confirmAccountReset("kwk", 1, secret, "kwk-second", pool)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await findKwkResetAccount(secret, pool), null);
  assert.equal(await getAuthenticatedKwkFromToken(token), null);
  assert.ok(await getAuthenticatedKwkFromToken(createKwkToken(1, 1)));
});
test("KWK password-write failure rolls back claim and session version", async () => {
  const secret = (await issueAccountReset("kwk", 1, pool))!;
  await pool.query("ALTER TABLE kwk_accounts ADD CONSTRAINT synthetic_kwk_failure CHECK (password_hash <> 'forbidden-hash')");
  try { await assert.rejects(confirmAccountReset("kwk", 1, secret, "forbidden-hash", pool)); }
  finally { await pool.query("ALTER TABLE kwk_accounts DROP CONSTRAINT synthetic_kwk_failure"); }
  assert.equal(await findKwkResetAccount(secret, pool), 1);
  assert.equal((await pool.query("SELECT session_version FROM kwk_accounts")).rows[0].session_version, 0);
});
test("legacy version0 partner/KWK sessions stay valid until password actually changes", async () => {
  const legacyPartner = jwt.sign({ type: "partner", partnerId: 1 }, ENV.jwtSecret, { expiresIn: "1h" });
  const legacyKwk = jwt.sign({ type: "kwk", kwkId: 1 }, ENV.jwtSecret, { expiresIn: "1h" });
  assert.deepEqual(verifyPartnerToken(legacyPartner), { partnerId: 1, sessionVersion: 0 });
  assert.deepEqual(verifyKwkToken(legacyKwk), { kwkId: 1, sessionVersion: 0 });
  assert.ok(await getAuthenticatedPartnerFromRequest(request(legacyPartner)));
  assert.ok(await getAuthenticatedKwkFromToken(legacyKwk));
  await writeAccountPassword("partner", 1, "changed-hash", undefined, pool);
  await writeAccountPassword("kwk", 1, "changed-hash", undefined, pool);
  assert.equal(await getAuthenticatedPartnerFromRequest(request(legacyPartner)), null);
  assert.equal(await getAuthenticatedKwkFromToken(legacyKwk), null);
  assert.ok(await getAuthenticatedPartnerFromRequest(request(createPartnerToken(1, 1))));
  assert.ok(await getAuthenticatedPartnerFromRequest(request(createPartnerToken(2, 0))), "unrelated account stays logged in");
});
test("cookie auth reads sessionversion too; malformed or foreign session versions fail", async () => {
  const cookieReq = { headers: { cookie: `369_partner_session=${createPartnerToken(1, 0)}` } } as any;
  assert.ok(await getAuthenticatedPartnerFromRequest(cookieReq));
  await writeAccountPassword("partner", 1, "changed", undefined, pool);
  assert.equal(await getAuthenticatedPartnerFromRequest(cookieReq), null);
  assert.equal(verifyPartnerToken(jwt.sign({ type: "partner", partnerId: 1, sessionVersion: "0" }, ENV.jwtSecret)), null);
  assert.equal(verifyKwkToken(jwt.sign({ type: "kwk", kwkId: 1, sessionVersion: -1 }, ENV.jwtSecret)), null);
  assert.equal(verifyPartnerToken(createKwkToken(1)), null);
});
test("inactive/deleted accounts and attribution-only values never authorize sessions/resets", async () => {
  await pool.query("UPDATE partners SET is_active=0 WHERE id=1");
  await pool.query("UPDATE kwk_accounts SET deleted_at=NOW() WHERE id=1");
  assert.equal(await getAuthenticatedPartnerFromRequest(request(createPartnerToken(1))), null);
  assert.equal(await getAuthenticatedKwkFromToken(createKwkToken(1)), null);
  assert.equal(await issueAccountReset("partner", 1, pool), null);
  assert.equal(await issueAccountReset("kwk", 1, pool), null);
  assert.equal(await getAuthenticatedPartnerFromRequest(request("OWN-1")), null);
  // Admin reset of inactive existing partner remains allowed; not a new role.
  await writeAccountPassword("partner", 1, "admin-reset", undefined, pool);
  assert.equal((await pool.query("SELECT session_version FROM partners WHERE id=1")).rows[0].session_version, 1);
});
test("durable per-identity rate limit ignores spoofed User-Agent/XFF and races", async () => {
  const results = await Promise.allSettled(Array.from({ length: 14 }, (_, i) => enforceAuthRateLimit(request(undefined, `198.51.100.${i}`), "partner.login", "OWN-1", pool)));
  assert.equal(results.filter(x => x.status === "fulfilled").length, 10);
  await assert.rejects(enforceAuthRateLimit(request(), "partner.login", "own-1", pool), /Zu viele/);
  const stored = (await pool.query("SELECT bucket_hash FROM account_auth_rate_limits")).rows;
  assert.ok(stored.every(x => /^[a-f0-9]{64}$/.test(x.bucket_hash)));
  await pool.query("UPDATE account_auth_rate_limits SET window_started_at=NOW()-INTERVAL '16 minutes'");
  await enforceAuthRateLimit(request(), "partner.login", "OWN-1", pool);
});
test("dedicated IP rate limit blocks varying identities; actions have distinct buckets", async () => {
  for (let i = 0; i < 30; i++) await enforceAuthRateLimit(request(), "kwk.login", `synthetic-${i}`, pool);
  await assert.rejects(enforceAuthRateLimit(request(), "kwk.login", "another", pool), /Zu viele/);
  await enforceAuthRateLimit(request(), "partner.login", "OWN-1", pool);
});
test("password CAS rejects race and consumes all pending reset slots on success", async () => {
  const secret = (await issueAccountReset("partner", 1, pool))!;
  const expected = { passwordHash, sessionVersion: 0 };
  const writes = await Promise.allSettled([writeAccountPassword("partner", 1, "hash-a", expected, pool), writeAccountPassword("partner", 1, "hash-b", expected, pool)]);
  assert.equal(writes.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(await confirmAccountReset("partner", 1, secret, "reset-after-change", pool), false);
});
test("native setPassword denies non-admin and invalid id is not falsely successful", async () => {
  await assert.rejects(caller().setPassword({ partnerId: 1, password: "synthetic-new" }), /anmelden/);
  await assert.rejects(caller(true).setPassword({ partnerId: 999, password: "synthetic-new" }), /nicht gefunden/);
  const oldToken = createPartnerToken(1, 0);
  await caller(true).setPassword({ partnerId: 1, password: "synthetic-new" });
  assert.equal(await getAuthenticatedPartnerFromRequest(request(oldToken)), null);
  assert.equal(fetchCount, 0);
});
test("native own password works and revokes JWT plus native cookie; stale auth denied", async () => {
  const token = createPartnerToken(1, 0);
  await caller(false, token).portalChangePassword({ currentPassword: "synthetic-old-password", newPassword: "synthetic-new-password" });
  assert.equal(await getAuthenticatedPartnerFromRequest(request(token)), null);
  assert.equal(calls[0].name, "clearCookie"); assert.equal(calls[0].args[0], "369_partner_session");
  await assert.rejects(caller(false, token).portalChangePassword({ currentPassword: "synthetic-new-password", newPassword: "another-password" }), /Partner-Login/);
});
test("native logout clears HttpOnly cookie without password mutation or blanket logout", async () => {
  await caller().portalLogout();
  assert.equal(calls[0].args[0], "369_partner_session");
  assert.equal((await pool.query("SELECT session_version FROM partners WHERE id=1")).rows[0].session_version, 0);
});
test("native short-code confirm endpoint claims and invalidates previous session", async () => {
  const secret = (await issueAccountReset("partner", 1, pool))!;
  await caller().portalConfirmPasswordReset({ partnerNumber: "OWN-1", code: secret, newPassword: "synthetic-reset-password" });
  assert.equal(await getAuthenticatedPartnerFromRequest(request(createPartnerToken(1))), null);
  await assert.rejects(caller().portalConfirmPasswordReset({ partnerNumber: "OWN-1", code: secret, newPassword: "synthetic-replay" }), /Reset-Code/);
  assert.equal(fetchCount, 0);
});
test("native KWK token confirm endpoint claims once and old bearer is rejected", async () => {
  const secret = (await issueAccountReset("kwk", 1, pool))!;
  const native = kwkRouter.createCaller({ req: request(), res: {}, user: null } as any);
  await native.confirmPasswordReset({ token: secret, newPassword: "synthetic-kwk-reset" });
  assert.equal(await getAuthenticatedKwkFromToken(createKwkToken(1)), null);
  await assert.rejects(native.confirmPasswordReset({ token: secret, newPassword: "synthetic-kwk-replay" }), /Reset-Link/);
});
test("missing credentials provider key causes no password write, session bump or HTTP", async () => {
  await assert.rejects(caller(true).sendCredentials({ partnerId: 1, password: "synthetic-new" }), /nicht geändert/);
  const row = (await pool.query("SELECT password_hash,session_version FROM partners WHERE id=1")).rows[0];
  assert.equal(row.password_hash, passwordHash); assert.equal(row.session_version, 0); assert.equal(fetchCount, 0);
});
test("credentials DB failure/unknown account never submits provider callback", async () => {
  let submits = 0;
  await assert.rejects(setupAndSendPartnerCredentials(999, "hash", async () => { submits++; return { ok: true }; }, pool));
  await pool.query("ALTER TABLE partners ADD CONSTRAINT synthetic_send_failure CHECK (password_hash <> 'forbidden-hash')");
  try { await assert.rejects(setupAndSendPartnerCredentials(1, "forbidden-hash", async () => { submits++; return { ok: true }; }, pool)); }
  finally { await pool.query("ALTER TABLE partners DROP CONSTRAINT synthetic_send_failure"); }
  assert.equal(submits, 0); assert.equal((await pool.query("SELECT session_version FROM partners WHERE id=1")).rows[0].session_version, 0);
});
for (const state of ["accepted", "failed", "unknown"] as const) {
  test(`credentials ${state}: password is committed before provider and status never lies`, async () => {
    const result = await setupAndSendPartnerCredentials(1, "committed-hash", async () => {
      const row = (await pool.query("SELECT password_hash,session_version FROM partners WHERE id=1")).rows[0];
      assert.equal(row.password_hash, "committed-hash"); assert.equal(row.session_version, 1);
      if (state === "unknown") throw new Error("synthetic timeout");
      return { ok: state === "accepted" };
    }, pool);
    assert.equal(result.emailStatus, state); assert.equal(result.passwordSaved, true); assert.equal(result.success, state === "accepted");
    assert.equal((await pool.query("SELECT password_hash FROM partners WHERE id=1")).rows[0].password_hash, "committed-hash");
  });
}
test("credentials serializes concurrent password reset until submission returns", async () => {
  let start!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => start = resolve);
  const gate = new Promise<void>(resolve => finish = resolve);
  const sending = setupAndSendPartnerCredentials(1, "emailed-hash", async () => { start(); await gate; return { ok: true }; }, pool);
  await started;
  let wrote = false;
  const reset = writeAccountPassword("partner", 1, "later-reset", undefined, pool).then(() => { wrote = true; });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(wrote, false); finish();
  assert.equal((await sending).success, true); await reset;
  assert.equal((await pool.query("SELECT session_version FROM partners WHERE id=1")).rows[0].session_version, 2);
});

test("native login and reset requests have dedicated attempt protection before password verification", async () => {
  for (let i=0;i<10;i++) await assert.rejects(caller().portalLogin({partnerNumber:"OWN-1",password:"wrong-password"}), /Anmeldedaten/);
  await assert.rejects(caller().portalLogin({partnerNumber:"OWN-1",password:"wrong-password"}), /Zu viele/);
  const reset = await caller().portalRequestPasswordReset({partnerNumber:"OWN-1"});
  const unknown = await caller().portalRequestPasswordReset({partnerNumber:"NOT-FOUND"});
  assert.equal(reset.success, false); assert.deepEqual(unknown, reset);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM partner_password_resets")).rows[0].count, 0);
  assert.equal(fetchCount, 0);
});
test("wrong current password does not revoke valid session or consume reset", async () => {
  const secret=(await issueAccountReset("partner",1,pool))!;
  const token=createPartnerToken(1,0);
  await assert.rejects(caller(false,token).portalChangePassword({currentPassword:"wrong-password",newPassword:"synthetic-new"}), /ist falsch/);
  assert.ok(await getAuthenticatedPartnerFromRequest(request(token)));
  assert.equal(await confirmAccountReset("partner",1,secret,"valid-reset",pool),true);
});

test("native credentials route denies anonymous/packing before any password change or HTTP", async () => {
  await assert.rejects(caller().sendCredentials({partnerId:1,password:"synthetic-new"}), /anmelden/);
  const packing=partnerRouter.createCaller({req:request(),res:{},user:{id:2,username:"synthetic-packing",role:"packing"}} as any);
  await assert.rejects(packing.sendCredentials({partnerId:1,password:"synthetic-new"}), /Berechtigung/);
  assert.equal((await pool.query("SELECT session_version FROM partners WHERE id=1")).rows[0].session_version,0);
  assert.equal(fetchCount,0);
});
test("trusted proxy chain stops at real public client, ignores attacker-prepended private XFF", () => {
  const app=express();app.set("trust proxy","loopback, linklocal, uniquelocal");
  const req=Object.create(express.request);
  req.app=app;
  req.connection={remoteAddress:"10.0.0.10"};
  req.headers={"x-forwarded-for":"10.99.99.99, 198.51.100.22"};
  assert.equal(req.ip,"198.51.100.22");
  req.connection={remoteAddress:"198.51.100.23"};
  assert.equal(req.ip,"198.51.100.23");
});
