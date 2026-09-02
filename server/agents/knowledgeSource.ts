import { createSign } from "node:crypto";

type CachedKnowledge = {
  text: string;
  expiresAt: number;
};

type CachedToken = {
  token: string;
  expiresAt: number;
};

const cache = new Map<string, CachedKnowledge>();
let googleTokenCache: CachedToken | null = null;

function getCacheTtlMs(): number {
  const seconds = Number(process.env.PEPGPT_KNOWLEDGE_CACHE_SECONDS || "300");
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 300_000;
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function getGoogleDriveAccessToken(): Promise<string> {
  const nowMs = Date.now();
  if (googleTokenCache && googleTokenCache.expiresAt > nowMs + 60_000) {
    return googleTokenCache.token;
  }

  const clientEmail = process.env.GOOGLE_DRIVE_CLIENT_EMAIL || "";
  const privateKey = (process.env.GOOGLE_DRIVE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) {
    throw new Error(
      "Private Google Drive access is not configured. Set GOOGLE_DRIVE_CLIENT_EMAIL and GOOGLE_DRIVE_PRIVATE_KEY."
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(
    JSON.stringify({
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const signingInput = `${header}.${claim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = base64Url(signer.sign(privateKey));
  const assertion = `${signingInput}.${signature}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google OAuth token error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("Google OAuth token response did not include access_token");
  }

  googleTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return data.access_token;
}

async function fetchGoogleDocText(documentId: string): Promise<string> {
  const cacheKey = `gdrive:${documentId}`;
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.text;

  const token = await getGoogleDriveAccessToken();
  const exportUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    documentId
  )}/export?mimeType=${encodeURIComponent("text/plain")}`;

  const response = await fetch(exportUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google Drive export error (${response.status}): ${errorText}`);
  }

  const text = (await response.text()).trim();
  if (!text) {
    throw new Error(`Google Drive document is empty: ${documentId}`);
  }

  cache.set(cacheKey, { text, expiresAt: now + getCacheTtlMs() });
  return text;
}

async function fetchText(url: string): Promise<string> {
  const cached = cache.get(url);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.text;

  const response = await fetch(url, {
    headers: {
      Accept: "text/plain,text/markdown;q=0.9,*/*;q=0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`Knowledge source unavailable (${response.status}): ${url}`);
  }

  const text = (await response.text()).trim();
  if (!text) {
    throw new Error(`Knowledge source returned empty content: ${url}`);
  }

  cache.set(url, { text, expiresAt: now + getCacheTtlMs() });
  return text;
}

export type PepKnowledge = {
  behavior: string;
  productKnowledge: string;
};

export async function loadPepKnowledge(): Promise<PepKnowledge> {
  const behaviorDocumentId = process.env.PEPGPT_BEHAVIOR_DOCUMENT_ID || "";
  const productDocumentId = process.env.PEPGPT_PRODUCT_KNOWLEDGE_DOCUMENT_ID || "";

  if (behaviorDocumentId && productDocumentId) {
    const [behavior, productKnowledge] = await Promise.all([
      fetchGoogleDocText(behaviorDocumentId),
      fetchGoogleDocText(productDocumentId),
    ]);
    return { behavior, productKnowledge };
  }

  const behaviorUrl = process.env.PEPGPT_BEHAVIOR_URL || "";
  const productKnowledgeUrl = process.env.PEPGPT_PRODUCT_KNOWLEDGE_URL || "";
  if (behaviorUrl && productKnowledgeUrl) {
    const [behavior, productKnowledge] = await Promise.all([
      fetchText(behaviorUrl),
      fetchText(productKnowledgeUrl),
    ]);
    return { behavior, productKnowledge };
  }

  throw new Error(
    "PepGPT knowledge is not configured. Prefer private Google Drive IDs with GOOGLE_DRIVE_CLIENT_EMAIL/GOOGLE_DRIVE_PRIVATE_KEY, or configure both knowledge URLs."
  );
}

export function clearPepKnowledgeCache(): void {
  cache.clear();
  googleTokenCache = null;
}
