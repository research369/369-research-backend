/**
 * Bunq API Service
 * Handles authentication (installation, device-server, session-server)
 * and payment retrieval with proper RSA request signing.
 */

import crypto from "crypto";

const BUNQ_BASE = "https://api.bunq.com/v1";

interface BunqSession {
  sessionToken: string;
  userId: number;
  installToken: string;
  privateKey: string;
  serverPublicKey: string;
  createdAt: number;
}

let cachedSession: BunqSession | null = null;

function getHeaders(token: string, body: string, privateKey?: string) {
  const requestId = crypto.randomUUID();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "369Research/1.0",
    "X-Bunq-Client-Request-Id": requestId,
    "X-Bunq-Geolocation": "0 0 0 0 000",
    "X-Bunq-Language": "en_US",
    "X-Bunq-Region": "en_US",
  };

  // Only include auth header if token is provided (not for installation call)
  if (token) {
    headers["X-Bunq-Client-Authentication"] = token;
  }

  // Sign the request if we have a private key
  if (privateKey) {
    const sign = crypto.createSign("SHA256");
    sign.update(body);
    sign.end();
    headers["X-Bunq-Client-Signature"] = sign.sign(privateKey, "base64");
  }

  return headers;
}

async function createSession(): Promise<BunqSession> {
  const apiKey = process.env.BUNQ_API_KEY;
  if (!apiKey) throw new Error("BUNQ_API_KEY not set");

  // Generate RSA keypair
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  // Step 1: Installation
  const installBody = JSON.stringify({ client_public_key: publicKey });
  const installRes = await fetch(`${BUNQ_BASE}/installation`, {
    method: "POST",
    headers: getHeaders("", installBody),
    body: installBody,
  });

  if (!installRes.ok) {
    const err = await installRes.json();
    throw new Error(`Bunq installation failed: ${JSON.stringify(err)}`);
  }

  const installData = await installRes.json();
  const installToken = installData.Response?.find((r: any) => r.Token)?.Token?.token;
  const serverPublicKey = installData.Response?.find((r: any) => r.ServerPublicKey)?.ServerPublicKey?.server_public_key;

  if (!installToken) throw new Error("No installation token received");

  // Step 2: Device-Server
  const deviceBody = JSON.stringify({
    description: "369 Research WaWi",
    secret: apiKey,
    permitted_ips: ["*"],
  });
  const deviceRes = await fetch(`${BUNQ_BASE}/device-server`, {
    method: "POST",
    headers: getHeaders(installToken, deviceBody, privateKey),
    body: deviceBody,
  });

  if (!deviceRes.ok) {
    const err = await deviceRes.json();
    throw new Error(`Bunq device-server failed: ${JSON.stringify(err)}`);
  }

  // Step 3: Session-Server
  const sessionBody = JSON.stringify({ secret: apiKey });
  const sessionRes = await fetch(`${BUNQ_BASE}/session-server`, {
    method: "POST",
    headers: getHeaders(installToken, sessionBody, privateKey),
    body: sessionBody,
  });

  if (!sessionRes.ok) {
    const err = await sessionRes.json();
    throw new Error(`Bunq session-server failed: ${JSON.stringify(err)}`);
  }

  const sessionData = await sessionRes.json();
  const sessionToken = sessionData.Response?.find((r: any) => r.Token)?.Token?.token;
  const userInfo = sessionData.Response?.find(
    (r: any) => r.UserPerson || r.UserCompany || r.UserApiKey
  );
  const user = userInfo?.UserPerson || userInfo?.UserCompany || userInfo?.UserApiKey;
  const userId = user?.id;

  if (!sessionToken || !userId) {
    throw new Error("No session token or user ID received");
  }

  const session: BunqSession = {
    sessionToken,
    userId,
    installToken,
    privateKey,
    serverPublicKey: serverPublicKey || "",
    createdAt: Date.now(),
  };

  cachedSession = session;
  console.log("[Bunq] Session created successfully, userId:", userId);
  return session;
}

async function getSession(): Promise<BunqSession> {
  // Session expires after ~1 hour, refresh after 50 minutes
  if (cachedSession && Date.now() - cachedSession.createdAt < 50 * 60 * 1000) {
    return cachedSession;
  }
  return createSession();
}

export interface BunqPayment {
  id: number;
  amount: { value: string; currency: string };
  description: string;
  counterpartyAlias: {
    type: string;
    value: string;
    name: string;
  };
  created: string;
  type: string;
  subType: string;
}

/**
 * Get monetary accounts for the user
 */
export async function getMonetaryAccounts(): Promise<any[]> {
  const session = await getSession();

  const url = `${BUNQ_BASE}/user/${session.userId}/monetary-account`;
  const body = "";
  const res = await fetch(url, {
    method: "GET",
    headers: getHeaders(session.sessionToken, body, session.privateKey),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Failed to get monetary accounts: ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  return data.Response || [];
}

/**
 * Get payments for a specific monetary account
 */
export async function getPayments(
  monetaryAccountId: number,
  count: number = 50
): Promise<BunqPayment[]> {
  const session = await getSession();

  const url = `${BUNQ_BASE}/user/${session.userId}/monetary-account/${monetaryAccountId}/payment?count=${count}`;
  const body = "";
  const res = await fetch(url, {
    method: "GET",
    headers: getHeaders(session.sessionToken, body, session.privateKey),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Failed to get payments: ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  const payments: BunqPayment[] = (data.Response || []).map((item: any) => {
    const p = item.Payment;
    return {
      id: p.id,
      amount: p.amount,
      description: p.description,
      counterpartyAlias: {
        type: p.counterparty_alias?.type || "",
        value: p.counterparty_alias?.value || "",
        name: p.counterparty_alias?.display_name || p.counterparty_alias?.name || "",
      },
      created: p.created,
      type: p.type,
      subType: p.sub_type,
    };
  });

  return payments;
}

/**
 * Get all incoming payments (positive amounts) and try to match with order IDs
 */
export async function getIncomingPayments(count: number = 100): Promise<BunqPayment[]> {
  try {
    const accounts = await getMonetaryAccounts();
    const allPayments: BunqPayment[] = [];

    for (const accountWrapper of accounts) {
      const account =
        accountWrapper.MonetaryAccountBank ||
        accountWrapper.MonetaryAccountJoint ||
        accountWrapper.MonetaryAccountSavings;
      if (!account) continue;

      // Only active accounts
      if (account.status !== "ACTIVE") continue;

      try {
        const payments = await getPayments(account.id, count);
        // Filter only incoming payments (positive amount)
        const incoming = payments.filter(
          (p) => parseFloat(p.amount.value) > 0
        );
        allPayments.push(...incoming);
      } catch (err) {
        console.warn(`[Bunq] Failed to get payments for account ${account.id}:`, err);
      }
    }

    return allPayments;
  } catch (err) {
    console.error("[Bunq] Failed to get incoming payments:", err);
    throw err;
  }
}

/**
 * Match a payment description against an order ID
 * Order IDs are like "369-XXXXXX"
 */
export function matchPaymentToOrder(
  payment: BunqPayment,
  orderIds: string[]
): string | null {
  const desc = payment.description.toUpperCase().trim();
  for (const orderId of orderIds) {
    if (desc.includes(orderId.toUpperCase())) {
      return orderId;
    }
  }
  return null;
}
