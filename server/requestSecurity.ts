import type { Request, RequestHandler } from "express";
import { ENV } from "./env.js";

/** Exact first-party origins only; previews must be explicitly configured. */
export function allowedBrowserOrigins(frontendUrl = ENV.frontendUrl, production = process.env.NODE_ENV === "production"): Set<string> {
  const origins = new Set(["https://369research.eu", "https://www.369research.eu"]);
  for (const value of frontendUrl.split(",")) {
    try {
      const url = new URL(value.trim());
      if (url.protocol === "https:" && url.origin === value.trim()) origins.add(url.origin);
    } catch { /* malformed configuration never widens access */ }
  }
  if (!production) for (const port of [3000, 5173]) origins.add(`http://localhost:${port}`);
  return origins;
}
export function hasBearerAuthorization(req: Pick<Request, "headers">): boolean {
  return /^Bearer\s+\S+$/i.test(req.headers.authorization || "");
}
export function cookieRequestIsTrusted(req: Pick<Request, "headers" | "method">, origins = allowedBrowserOrigins()): boolean {
  const origin = req.headers.origin;
  if (origin) return origins.has(origin);
  // Safe first-party navigations may omit Origin. Writes require Origin.
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.referer) {
    try { return origins.has(new URL(req.headers.referer).origin); } catch { return false; }
  }
  return false;
}
export const guardCookieOrigin: RequestHandler = (req, res, next) => {
  if (hasBearerAuthorization(req)) {
    // Explicit bearer credentials take precedence, including programmatic clients
    // with no Origin. Ambient cookies must not select a different principal.
    req.headers.cookie = (req.headers.cookie || "").split(";").filter(entry =>
      !["369_session", "369_partner_session"].includes(entry.trim().split("=")[0]),
    ).join(";");
    next(); return;
  }
  const hasSessionCookie = /(?:^|;\s*)(?:369_session|369_partner_session)=/.test(req.headers.cookie || "");
  if (hasSessionCookie && !cookieRequestIsTrusted(req)) {
    res.status(403).json({ error: "Ungültiger Ursprung der Sitzung" }); return;
  }
  next();
};

/** Permanently retired public mail route; does not inspect input or providers. */
export const retiredMailRelay: RequestHandler = (_req, res) => {
  res.status(410).json({ error: "Dieser öffentliche Versandendpunkt wurde eingestellt. Bitte den authentisierten WaWi-Versand verwenden." });
};
