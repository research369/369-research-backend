/**
 * TOTP 2FA Router
 * Endpoints for setting up, enabling, and verifying TOTP-based 2FA.
 * Uses otpauth library (RFC 6238 compliant, works with Google Authenticator, Authy etc.)
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { router, protectedProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { users } from "../drizzle/schema.js";

const ISSUER = "369 Research WaWi";

/** Generate a new TOTP secret and QR code for the current user */
export const totpRouter = router({
  /** Generate setup: returns secret + QR code data URL */
  setup: protectedProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Datenbank nicht verfügbar");

      // Generate new secret
      const newSecret = new OTPAuth.Secret({ size: 20 });
      const totp = new OTPAuth.TOTP({
        issuer: ISSUER,
        label: ctx.user!.username,
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret: newSecret,
      });

      const secret = totp.secret.base32;
      const otpAuthUrl = totp.toString();

      // Generate QR code as data URL
      const qrDataUrl = await QRCode.toDataURL(otpAuthUrl, {
        width: 256,
        margin: 2,
        color: { dark: "#0040C1", light: "#FFFFFF" },
      });

      // Save secret to DB (not yet enabled)
      await db
        .update(users)
        .set({ totpSecret: secret })
        .where(eq(users.id, ctx.user!.id));

      return {
        secret,
        qrDataUrl,
        otpAuthUrl,
      };
    }),

  /** Verify a TOTP code and enable 2FA */
  enable: protectedProcedure
    .input(z.object({ code: z.string().length(6) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Datenbank nicht verfügbar");

      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, ctx.user!.id))
        .limit(1);

      if (!user?.totpSecret) {
        throw new Error("Kein TOTP-Secret gefunden. Bitte Setup erneut starten.");
      }

      const totp = new OTPAuth.TOTP({
        issuer: ISSUER,
        label: user.username,
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(user.totpSecret),
      });

      const delta = totp.validate({ token: input.code, window: 1 });
      if (delta === null) {
        throw new Error("Ungültiger Code. Bitte erneut versuchen.");
      }

      await db
        .update(users)
        .set({ totpEnabled: 1 })
        .where(eq(users.id, ctx.user!.id));

      return { success: true };
    }),

  /** Disable 2FA (requires valid TOTP code) */
  disable: protectedProcedure
    .input(z.object({ code: z.string().length(6) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Datenbank nicht verfügbar");

      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, ctx.user!.id))
        .limit(1);

      if (!user?.totpSecret || !user.totpEnabled) {
        throw new Error("2FA ist nicht aktiviert.");
      }

      const totp = new OTPAuth.TOTP({
        issuer: ISSUER,
        label: user.username,
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(user.totpSecret),
      });

      const delta = totp.validate({ token: input.code, window: 1 });
      if (delta === null) {
        throw new Error("Ungültiger Code. Bitte erneut versuchen.");
      }

      await db
        .update(users)
        .set({ totpEnabled: 0, totpSecret: null })
        .where(eq(users.id, ctx.user!.id));

      return { success: true };
    }),

  /** Get current 2FA status for the logged-in user */
  status: protectedProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) return { enabled: false };

      const [user] = await db
        .select({ totpEnabled: users.totpEnabled })
        .from(users)
        .where(eq(users.id, ctx.user!.id))
        .limit(1);

      return { enabled: !!user?.totpEnabled };
    }),
});

/** Verify a TOTP code for a user (used during login) */
export async function verifyTotpCode(userId: number, code: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  const [user] = await db
    .select({ totpSecret: users.totpSecret, totpEnabled: users.totpEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user?.totpSecret || !user.totpEnabled) return true; // 2FA not enabled = pass

  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: "user",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(user.totpSecret),
  });

  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}
