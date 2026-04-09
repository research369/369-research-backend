/**
 * Auth module – JWT-based authentication for WaWi admin
 * No external OAuth dependency – fully self-contained
 */
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { ENV } from "./env.js";
import { getDb } from "./db.js";
import { users } from "../drizzle/schema.js";
import type { Request, Response } from "express";

const JWT_ALG = "HS256";
const TOKEN_EXPIRY = "7d"; // 7 days
const COOKIE_NAME = "369_session";

function getSecret() {
  return new TextEncoder().encode(ENV.jwtSecret);
}

export async function createToken(userId: number, role: string): Promise<string> {
  return new SignJWT({ userId, role })
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(getSecret());
}

export async function verifyToken(token: string): Promise<{ userId: number; role: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return { userId: payload.userId as number, role: payload.role as string };
  } catch {
    return null;
  }
}

export async function getUserFromRequest(req: Request) {
  // Check cookie first, then Authorization header
  const cookieHeader = req.headers.cookie || "";
  const cookies = Object.fromEntries(
    cookieHeader.split(";").map(c => {
      const [k, ...v] = c.trim().split("=");
      return [k, v.join("=")];
    })
  );

  let token = cookies[COOKIE_NAME];
  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }
  }

  if (!token) return null;

  const payload = await verifyToken(token);
  if (!payload) return null;

  const db = await getDb();
  if (!db) return null;

  const [user] = await db.select().from(users).where(eq(users.id, payload.userId)).limit(1);
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

export async function handleLogin(req: Request, res: Response) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Benutzername und Passwort erforderlich" });
  }

  const db = await getDb();
  if (!db) {
    return res.status(500).json({ error: "Datenbank nicht verfügbar" });
  }

  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!user) {
    return res.status(401).json({ error: "Ungültige Anmeldedaten" });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Ungültige Anmeldedaten" });
  }

  // Update last signed in
  await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, user.id));

  const token = await createToken(user.id, user.role);

  // Set cookie
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: "/",
  });

  return res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      role: user.role,
    },
    token, // Also return token for frontend storage
  });
}

export async function handleLogout(_req: Request, res: Response) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
  });
  return res.json({ success: true });
}

export async function handleMe(req: Request, res: Response) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: "Nicht angemeldet" });
  }
  return res.json({ user });
}

/**
 * Seed the initial admin user if none exists
 */
export async function seedAdminUser() {
  const db = await getDb();
  if (!db) return;

  const existingUsers = await db.select().from(users).limit(1);
  if (existingUsers.length > 0) {
    console.log("[Auth] Admin user already exists, skipping seed");
    return;
  }

  const username = ENV.adminUsername;
  const password = ENV.adminPassword;

  if (!password) {
    console.warn("[Auth] ADMIN_PASSWORD not set, cannot seed admin user");
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  await db.insert(users).values({
    username,
    passwordHash: hash,
    name: "Admin",
    email: "369peptides@gmail.com",
    role: "admin",
  });

  console.log(`[Auth] Admin user '${username}' created successfully`);
}
