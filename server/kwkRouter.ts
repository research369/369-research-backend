/**
 * KWK Router – Kunden-werben-Kunden API
 *
 * ISOLIERTES MODUL: Alle Endpunkte unter /api/v1/kwk
 * Keine bestehenden Router werden verändert.
 *
 * Endpunkte:
 *   PUBLIC:
 *     kwk.register        – Registrierung
 *     kwk.login           – Login
 *     kwk.validateCode    – KWK-Code im Checkout prüfen
 *     kwk.requestReset    – Passwort-Reset anfordern
 *     kwk.resetPassword   – Passwort zurücksetzen
 *
 *   KWK-AUTH (JWT):
 *     kwk.getProfile      – Dashboard-Daten
 *     kwk.getLedger       – Guthaben-Verlauf
 *     kwk.getReferrals    – Geworbene Bestellungen
 *     kwk.redeemCredit    – Guthaben einlösen (Checkout)
 *
 *   ADMIN (WaWi-Auth):
 *     kwk.adminList       – Alle KWK-Accounts
 *     kwk.adminGet        – Einzelner Account
 *     kwk.adminUpdate     – Status ändern, Notiz
 *     kwk.adminLedger     – Ledger eines Accounts
 *     kwk.adminManualCredit – Manuelle Gutschrift/Korrektur
 */

import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { router, publicProcedure, adminProcedure, middleware } from "./trpc.js";
import { getPool } from "./db.js";
import { ENV } from "./env.js";
import {
  isKwkEnabled,
  generateKwkNumber,
  generateReferralCode,
  computeBalanceFromLedger,
  detectFraudFlags,
  hashAddress,
  auditLog,
  checkLoginRateLimit,
  recordFailedLogin,
  resetLoginAttempts,
  calculateKwkDiscount,
  KWK_DISCOUNT_PERCENT,
  KWK_COMMISSION_PERCENT,
} from "./kwkService.js";
import type { Request } from "express";

// ── KWK Auth Helpers ──────────────────────────────────────────────────────

const KWK_TOKEN_EXPIRY = "30d";

function createKwkToken(kwkId: number): string {
  return jwt.sign({ kwkId, type: "kwk" }, ENV.jwtSecret, { expiresIn: KWK_TOKEN_EXPIRY });
}

function verifyKwkToken(token: string): { kwkId: number } | null {
  try {
    const payload = jwt.verify(token, ENV.jwtSecret) as any;
    if (payload.type !== "kwk") return null;
    return { kwkId: payload.kwkId };
  } catch {
    return null;
  }
}

async function getKwkFromRequest(req: Request): Promise<{ kwkId: number } | null> {
  const authHeader = req.headers.authorization;
  let token: string | undefined;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }
  if (!token) return null;
  return verifyKwkToken(token);
}

// Middleware: KWK-Auth prüfen
const kwkAuthMiddleware = middleware(async ({ ctx, next }) => {
  const kwkAuth = await getKwkFromRequest(ctx.req as Request);
  if (!kwkAuth) {
    throw new Error("KWK-Authentifizierung erforderlich");
  }
  return next({ ctx: { ...ctx, kwkId: kwkAuth.kwkId } });
});

const kwkProcedure = publicProcedure.use(kwkAuthMiddleware);

// Middleware: Feature Flag prüfen
const kwkEnabledMiddleware = middleware(async ({ next }) => {
  const enabled = await isKwkEnabled();
  if (!enabled) {
    throw new Error("KWK-Programm ist derzeit nicht aktiv");
  }
  return next();
});

const kwkPublicProcedure = publicProcedure.use(kwkEnabledMiddleware);
const kwkAuthProcedure = kwkProcedure.use(kwkEnabledMiddleware);

// ── Router ────────────────────────────────────────────────────────────────

export const kwkRouter = router({

  // ── PUBLIC: Registrierung ──────────────────────────────────────────────
  register: kwkPublicProcedure
    .input(z.object({
      name: z.string().min(2).max(255),
      email: z.string().email().max(255),
      phone: z.string().min(5).max(50),
      password: z.string().min(8).max(100),
      passwordConfirm: z.string(),
      company: z.string().max(255).optional(),
      whatsapp: z.string().max(50).optional(),
      notes: z.string().max(1000).optional(),
      agreeToTerms: z.boolean(),
    }))
    .mutation(async ({ input }) => {
      if (input.password !== input.passwordConfirm) {
        throw new Error("Passwörter stimmen nicht überein");
      }
      if (!input.agreeToTerms) {
        throw new Error("Bitte stimme den KWK-Bedingungen zu");
      }

      const pool = await getPool();
      if (!pool) throw new Error("Database not available");

      // E-Mail-Duplikat prüfen
      const existing = await pool.query(
        "SELECT id FROM kwk_accounts WHERE email = $1 LIMIT 1",
        [input.email.toLowerCase()]
      );
      if (existing.rows.length > 0) {
        throw new Error("Diese E-Mail-Adresse ist bereits registriert");
      }

      // KWK-Nummer und Referral-Code generieren
      const kwkNumber = await generateKwkNumber();
      const referralCode = generateReferralCode(kwkNumber);

      // Passwort hashen (bcrypt, gleiche Methode wie Partner-Auth)
      const passwordHash = await bcrypt.hash(input.password, 12);

      // Account erstellen
      const result = await pool.query(
        `INSERT INTO kwk_accounts
           (kwk_number, referral_code, name, email, phone, password_hash, company, whatsapp, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, kwk_number, referral_code`,
        [
          kwkNumber,
          referralCode,
          input.name,
          input.email.toLowerCase(),
          input.phone,
          passwordHash,
          input.company || null,
          input.whatsapp || null,
          input.notes || null,
        ]
      );

      const account = result.rows[0];
      const token = createKwkToken(account.id);

      console.log(`[KWK] New account registered: ${kwkNumber} (${input.email})`);

      return {
        success: true,
        token,
        kwkNumber: account.kwk_number,
        referralCode: account.referral_code,
        referralLink: `${ENV.frontendUrl}/r/${account.referral_code}`,
      };
    }),

  // ── PUBLIC: Login ──────────────────────────────────────────────────────
  login: kwkPublicProcedure
    .input(z.object({
      emailOrKwkNumber: z.string(),
      password: z.string(),
    }))
    .mutation(async ({ input }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");

      // Account suchen (E-Mail oder KWK-Nummer)
      const isKwkNumber = input.emailOrKwkNumber.toUpperCase().startsWith("KWK-");
      const result = await pool.query(
        isKwkNumber
          ? "SELECT * FROM kwk_accounts WHERE kwk_number = $1 AND deleted_at IS NULL LIMIT 1"
          : "SELECT * FROM kwk_accounts WHERE email = $1 AND deleted_at IS NULL LIMIT 1",
        [isKwkNumber ? input.emailOrKwkNumber.toUpperCase() : input.emailOrKwkNumber.toLowerCase()]
      );

      if (result.rows.length === 0) {
        throw new Error("Ungültige Anmeldedaten");
      }

      const account = result.rows[0];

      // Rate Limiting prüfen
      const rateLimit = await checkLoginRateLimit(account.id);
      if (rateLimit.locked) {
        throw new Error(`Account temporär gesperrt. Bitte versuche es nach ${rateLimit.lockedUntil?.toLocaleTimeString("de-DE")} erneut.`);
      }

      // Status prüfen
      if (account.status === "gesperrt" || account.status === "deaktiviert") {
        throw new Error("Dieser Account ist nicht aktiv. Bitte kontaktiere den Support.");
      }

      // Passwort prüfen
      const valid = await bcrypt.compare(input.password, account.password_hash);
      if (!valid) {
        await recordFailedLogin(account.id);
        throw new Error("Ungültige Anmeldedaten");
      }

      // Login erfolgreich
      await resetLoginAttempts(account.id);

      const token = createKwkToken(account.id);
      const balance = await computeBalanceFromLedger(account.id);

      return {
        success: true,
        token,
        kwkNumber: account.kwk_number,
        referralCode: account.referral_code,
        referralLink: `${ENV.frontendUrl}/r/${account.referral_code}`,
        name: account.name,
        email: account.email,
        status: account.status,
        creditAvailable: balance.available,
        creditPending: balance.pending,
        creditRedeemed: balance.redeemed,
      };
    }),

  // ── PUBLIC: KWK-Code validieren (Checkout) ─────────────────────────────
  validateCode: kwkPublicProcedure
    .input(z.object({
      code: z.string(),
    }))
    .query(async ({ input }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");

      const result = await pool.query(
        "SELECT id, kwk_number, name, status FROM kwk_accounts WHERE referral_code = $1 AND deleted_at IS NULL LIMIT 1",
        [input.code.toUpperCase()]
      );

      if (result.rows.length === 0) {
        return { valid: false, reason: "Ungültiger KWK-Code" };
      }

      const account = result.rows[0];

      if (account.status !== "aktiv") {
        return { valid: false, reason: "Dieser KWK-Code ist nicht aktiv" };
      }

      return {
        valid: true,
        kwkId: account.id,
        kwkNumber: account.kwk_number,
        discountPercent: KWK_DISCOUNT_PERCENT,
      };
    }),

  // ── KWK-AUTH: Profil abrufen ───────────────────────────────────────────
  getProfile: kwkAuthProcedure
    .query(async ({ ctx }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");
      const { kwkId } = ctx as any;

      const result = await pool.query(
        "SELECT id, kwk_number, referral_code, name, email, phone, company, whatsapp, status, created_at FROM kwk_accounts WHERE id = $1",
        [kwkId]
      );

      if (result.rows.length === 0) throw new Error("Account nicht gefunden");

      const account = result.rows[0];
      const balance = await computeBalanceFromLedger(kwkId);

      return {
        ...account,
        referralLink: `${ENV.frontendUrl}/r/${account.referral_code}`,
        creditAvailable: balance.available,
        creditPending: balance.pending,
        creditRedeemed: balance.redeemed,
      };
    }),

  // ── KWK-AUTH: Ledger abrufen ───────────────────────────────────────────
  getLedger: kwkAuthProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
    }).optional())
    .query(async ({ ctx, input }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");
      const { kwkId } = ctx as any;
      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;

      const result = await pool.query(
        `SELECT id, order_id, amount, type, status, note, created_at
         FROM kwk_ledger
         WHERE kwk_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [kwkId, limit, offset]
      );

      const balance = await computeBalanceFromLedger(kwkId);

      return {
        entries: result.rows,
        balance,
      };
    }),

  // ── KWK-AUTH: Geworbene Bestellungen ──────────────────────────────────
  getReferrals: kwkAuthProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
    }).optional())
    .query(async ({ ctx, input }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");
      const { kwkId } = ctx as any;
      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;

      const result = await pool.query(
        `SELECT id, order_id, discount_applied, commission_base, commission_amount, status, created_at
         FROM kwk_referrals
         WHERE kwk_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [kwkId, limit, offset]
      );

      const total = await pool.query(
        "SELECT COUNT(*) FROM kwk_referrals WHERE kwk_id = $1",
        [kwkId]
      );

      return {
        referrals: result.rows,
        total: parseInt(total.rows[0].count),
      };
    }),

  // ── KWK-AUTH: Guthaben einlösen ────────────────────────────────────────
  redeemCredit: kwkAuthProcedure
    .input(z.object({
      orderId: z.string(),
      amount: z.number().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { kwkId } = ctx as any;

      // Guthaben einlösen (Service-Funktion, atomar)
      const { redeemCredit } = await import("./kwkService.js");
      await redeemCredit(kwkId, input.orderId, input.amount);

      const balance = await computeBalanceFromLedger(kwkId);

      return {
        success: true,
        amountRedeemed: input.amount,
        newBalance: balance.available,
      };
    }),

  // ── ADMIN: Alle KWK-Accounts ───────────────────────────────────────────
  adminList: adminProcedure
    .input(z.object({
      search: z.string().optional(),
      status: z.enum(["aktiv", "gesperrt", "review", "deaktiviert"]).optional(),
      limit: z.number().min(1).max(200).default(50),
      offset: z.number().min(0).default(0),
    }).optional())
    .query(async ({ input }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");
      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;

      let query = `
        SELECT id, kwk_number, referral_code, name, email, phone, company, status,
               credit_available, credit_pending, credit_redeemed, created_at, last_login
        FROM kwk_accounts
        WHERE deleted_at IS NULL
      `;
      const params: any[] = [];

      if (input?.search) {
        params.push(`%${input.search}%`);
        query += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length} OR kwk_number ILIKE $${params.length})`;
      }
      if (input?.status) {
        params.push(input.status);
        query += ` AND status = $${params.length}`;
      }

      query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);
      const countResult = await pool.query(
        "SELECT COUNT(*) FROM kwk_accounts WHERE deleted_at IS NULL",
        []
      );

      return {
        accounts: result.rows,
        total: parseInt(countResult.rows[0].count),
      };
    }),

  // ── ADMIN: Account aktualisieren ──────────────────────────────────────
  adminUpdate: adminProcedure
    .input(z.object({
      kwkId: z.number(),
      status: z.enum(["aktiv", "gesperrt", "review", "deaktiviert"]).optional(),
      notes: z.string().optional(),
      adminNote: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");
      const adminUser = (ctx as any).user?.username || "admin";

      // Alten Wert lesen
      const old = await pool.query(
        "SELECT status, notes FROM kwk_accounts WHERE id = $1",
        [input.kwkId]
      );
      if (old.rows.length === 0) throw new Error("Account nicht gefunden");

      const updates: string[] = [];
      const params: any[] = [];

      if (input.status !== undefined) {
        params.push(input.status);
        updates.push(`status = $${params.length}`);
      }
      if (input.notes !== undefined) {
        params.push(input.notes);
        updates.push(`notes = $${params.length}`);
      }

      if (updates.length > 0) {
        updates.push("updated_at = NOW()");
        params.push(input.kwkId);
        await pool.query(
          `UPDATE kwk_accounts SET ${updates.join(", ")} WHERE id = $${params.length}`,
          params
        );
      }

      // Audit-Log
      await auditLog(
        input.kwkId,
        adminUser,
        "account_update",
        JSON.stringify({ status: old.rows[0].status }),
        JSON.stringify({ status: input.status }),
        input.adminNote
      );

      return { success: true };
    }),

  // ── ADMIN: Ledger eines Accounts ──────────────────────────────────────
  adminLedger: adminProcedure
    .input(z.object({
      kwkId: z.number(),
      limit: z.number().min(1).max(200).default(100),
    }))
    .query(async ({ input }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");

      const result = await pool.query(
        `SELECT id, order_id, amount, type, status, note, created_by, created_at
         FROM kwk_ledger
         WHERE kwk_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [input.kwkId, input.limit]
      );

      const balance = await computeBalanceFromLedger(input.kwkId);

      return {
        entries: result.rows,
        balance,
      };
    }),

  // ── ADMIN: Manuelle Gutschrift/Korrektur ───────────────────────────────
  adminManualCredit: adminProcedure
    .input(z.object({
      kwkId: z.number(),
      amount: z.number(), // positiv = Gutschrift, negativ = Korrektur
      note: z.string().min(3),
    }))
    .mutation(async ({ input, ctx }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");
      const adminUser = (ctx as any).user?.username || "admin";

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        await client.query(
          `INSERT INTO kwk_ledger (kwk_id, amount, type, status, note, created_by)
           VALUES ($1, $2, 'manual_correction', 'confirmed', $3, $4)`,
          [input.kwkId, input.amount.toFixed(2), input.note, adminUser]
        );

        // Cache synchronisieren
        const { syncCacheFromLedger } = await import("./kwkService.js") as any;
        if (syncCacheFromLedger) {
          // syncCacheFromLedger ist privat – direktes SQL
          const ledgerResult = await client.query(
            `SELECT
               COALESCE(SUM(CASE WHEN type = 'pending_credit' AND status = 'pending' THEN amount ELSE 0 END), 0) AS pending,
               COALESCE(SUM(CASE WHEN type = 'credit_released' AND status = 'confirmed' THEN amount ELSE 0 END), 0) AS released,
               COALESCE(SUM(CASE WHEN type = 'redeemed' THEN ABS(amount) ELSE 0 END), 0) AS redeemed_total
             FROM kwk_ledger WHERE kwk_id = $1`,
            [input.kwkId]
          );
          const r = ledgerResult.rows[0];
          const pending = parseFloat(r.pending) || 0;
          const released = parseFloat(r.released) || 0;
          const redeemed = parseFloat(r.redeemed_total) || 0;
          const available = Math.max(0, released - redeemed);
          await client.query(
            `UPDATE kwk_accounts SET credit_pending = $1, credit_available = $2, credit_redeemed = $3, updated_at = NOW() WHERE id = $4`,
            [pending.toFixed(2), available.toFixed(2), redeemed.toFixed(2), input.kwkId]
          );
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      await auditLog(
        input.kwkId,
        adminUser,
        "manual_credit",
        null,
        input.amount.toFixed(2),
        input.note
      );

      return { success: true };
    }),

  // ── ADMIN: Feature Flag umschalten ────────────────────────────────────
  adminToggleFeature: adminProcedure
    .input(z.object({
      enabled: z.boolean(),
    }))
    .mutation(async ({ input, ctx }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");
      const adminUser = (ctx as any).user?.username || "admin";

      await pool.query(
        `INSERT INTO shop_settings (key, value) VALUES ('kwk_enabled', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [input.enabled ? "true" : "false"]
      );

      await auditLog(
        null,
        adminUser,
        "feature_flag_toggle",
        (!input.enabled).toString(),
        input.enabled.toString(),
        `KWK-Modul ${input.enabled ? "aktiviert" : "deaktiviert"}`
      );

            console.log(`[KWK] Feature flag set to: ${input.enabled} by ${adminUser}`);
      return { success: true, enabled: input.enabled };
    }),


  // ── PUBLIC: Passwort-Reset anfordern ─────────────────────────────────────────
  // Sendet eine Reset-E-Mail mit einem 1-Stunde gültigen Token
  requestPasswordReset: publicProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ input }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");

      // Prüfen ob E-Mail existiert (kein Fehler wenn nicht – Security)
      const { rows } = await pool.query(
        "SELECT id, name FROM kwk_accounts WHERE email = $1 AND status != 'banned' LIMIT 1",
        [input.email.toLowerCase()]
      );

      if (rows.length > 0) {
        const account = rows[0];
        // Token generieren (64 Zeichen hex)
        const crypto = await import("crypto");
        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 Stunde

        // Alte Tokens für diese E-Mail löschen
        await pool.query("DELETE FROM kwk_password_resets WHERE email = $1", [input.email.toLowerCase()]);

        // Neuen Token speichern
        await pool.query(
          "INSERT INTO kwk_password_resets (email, token, expires_at) VALUES ($1, $2, $3)",
          [input.email.toLowerCase(), token, expiresAt]
        );

        // Reset-E-Mail senden via Resend
        const resetUrl = `https://www.369research.eu/kwk/reset-password?token=${token}`;
        const RESEND_KEY = process.env.RESEND_API_KEY;
        if (RESEND_KEY) {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "369 Research <noreply@mail.369research.eu>",
              to: [input.email.toLowerCase()],
              bcc: ["369rebackup@gmail.com"],
              subject: "Dein KWK-Passwort zurücksetzen – 369 Research",
              html: `
                <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#f9fafb;padding:24px;border-radius:12px;">
                  <h2 style="color:#0040C1;margin:0 0 16px;">Passwort zurücksetzen</h2>
                  <p style="color:#374151;font-size:14px;">Hallo ${account.name},</p>
                  <p style="color:#374151;font-size:14px;">du hast einen Passwort-Reset für dein KWK-Konto angefordert. Klicke auf den Button, um ein neues Passwort zu setzen:</p>
                  <div style="text-align:center;margin:24px 0;">
                    <a href="${resetUrl}" style="background:#0040C1;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px;">
                      Passwort zurücksetzen
                    </a>
                  </div>
                  <p style="color:#6b7280;font-size:12px;">Dieser Link ist 1 Stunde gültig. Falls du keinen Reset angefordert hast, ignoriere diese E-Mail.</p>
                  <p style="color:#9ca3af;font-size:11px;margin-top:16px;">369 Research · KWK-Programm · Research Use Only</p>
                </div>
              `,
            }),
          }).catch(() => {}); // Silent fail
        }
      }

      // Immer gleiche Antwort (Security: kein Hinweis ob E-Mail existiert)
      return { success: true, message: "Falls diese E-Mail registriert ist, erhältst du in Kürze eine Nachricht." };
    }),

  // ── PUBLIC: Passwort zurücksetzen ─────────────────────────────────────────────
  // Setzt das Passwort mit einem gültigen Token zurück
  confirmPasswordReset: publicProcedure
    .input(z.object({
      token: z.string().min(1),
      newPassword: z.string().min(8).max(100),
    }))
    .mutation(async ({ input }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");

      // Token prüfen
      const { rows } = await pool.query(
        "SELECT email, expires_at, used_at FROM kwk_password_resets WHERE token = $1 LIMIT 1",
        [input.token]
      );

      if (rows.length === 0) throw new Error("Ungültiger oder abgelaufener Reset-Link.");
      const reset = rows[0];
      if (reset.used_at) throw new Error("Dieser Reset-Link wurde bereits verwendet.");
      if (new Date(reset.expires_at) < new Date()) throw new Error("Dieser Reset-Link ist abgelaufen. Bitte fordere einen neuen an.");

      // Neues Passwort setzen
      const passwordHash = await bcrypt.hash(input.newPassword, 12);
      await pool.query(
        "UPDATE kwk_accounts SET password_hash = $1, updated_at = NOW() WHERE email = $2",
        [passwordHash, reset.email]
      );

      // Token als verwendet markieren
      await pool.query(
        "UPDATE kwk_password_resets SET used_at = NOW() WHERE token = $1",
        [input.token]
      );

      return { success: true, message: "Passwort erfolgreich zurückgesetzt. Du kannst dich jetzt einloggen." };
    }),

  // ── ADMIN: Feature Flag Status lesen ──────────────────────────────────────────────────────────────────────────────────────
  getFeatureStatus: adminProcedure
    .query(async () => {
      const enabled = await isKwkEnabled();
      return { enabled };
    }),
});
