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
 * Normalize a string for fuzzy matching: lowercase, remove special chars, collapse whitespace
 */
function normalize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9äöüß\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Extract potential order IDs from a description string.
 * Matches patterns like "369-10003", "369 10003", "36910003", "369_10003"
 */
function extractOrderIds(description: string): string[] {
  const results: string[] = [];
  // Match "369" followed by optional separator and digits
  const patterns = [
    /369[\s\-_\.]*(\d{4,6})/gi,  // 369-10003, 369 10003, 36910003
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(description)) !== null) {
      results.push(`369-${match[1]}`);
    }
  }
  return results;
}

export interface MatchResult {
  orderId: string;
  matchType: "orderNumber" | "nameAndAmount" | "amountOnly" | "nameOnly" | "none";
  confidence: "high" | "medium" | "low";
  matchedPayment: BunqPayment | null;
  amountMatch: boolean;
  nameMatch: boolean;
  orderNumberMatch: boolean;
}

/**
 * Intelligent payment matching for an order against all payments.
 * Checks: (1) Order number in description, (2) Name match, (3) Amount match
 * Returns the best match with confidence level.
 */
export function intelligentMatch(
  order: { orderId: string; firstName: string; lastName: string; total: string },
  payments: BunqPayment[]
): MatchResult {
  const orderTotal = parseFloat(order.total);
  const orderName = normalize(`${order.firstName} ${order.lastName}`);
  const orderNameParts = orderName.split(" ").filter(p => p.length > 1);

  let bestMatch: MatchResult = {
    orderId: order.orderId,
    matchType: "none",
    confidence: "low",
    matchedPayment: null,
    amountMatch: false,
    nameMatch: false,
    orderNumberMatch: false,
  };

  for (const payment of payments) {
    const paymentAmount = parseFloat(payment.amount.value);
    const paymentDesc = payment.description || "";
    const senderName = normalize(payment.counterpartyAlias.name || "");

    // Check 1: Order number in description (with fuzzy matching)
    const extractedIds = extractOrderIds(paymentDesc);
    const orderNumberMatch = extractedIds.some(
      id => id.toUpperCase() === order.orderId.toUpperCase()
    ) || paymentDesc.toUpperCase().includes(order.orderId.toUpperCase());

    // Check 2: Name matching (sender name contains customer name parts or vice versa)
    const nameMatch = orderNameParts.length > 0 && orderNameParts.some(part =>
      senderName.includes(part) || normalize(paymentDesc).includes(part)
    );

    // Check 3: Amount matching (within 0.05 EUR tolerance)
    const amountMatch = Math.abs(paymentAmount - orderTotal) <= 0.05;

    // Determine match type and confidence
    let matchType: MatchResult["matchType"] = "none";
    let confidence: MatchResult["confidence"] = "low";

    if (orderNumberMatch && amountMatch) {
      // Best case: order number + amount match
      matchType = "orderNumber";
      confidence = "high";
    } else if (orderNumberMatch && nameMatch) {
      // Order number + name but amount differs (partial payment?)
      matchType = "orderNumber";
      confidence = "high";
    } else if (orderNumberMatch) {
      // Only order number match
      matchType = "orderNumber";
      confidence = "medium";
    } else if (nameMatch && amountMatch) {
      // Name + amount match (customer forgot order number)
      matchType = "nameAndAmount";
      confidence = "medium";
    } else if (amountMatch && !nameMatch) {
      // Only amount matches – could be coincidence
      matchType = "amountOnly";
      confidence = "low";
    } else if (nameMatch && !amountMatch) {
      // Only name matches
      matchType = "nameOnly";
      confidence = "low";
    }

    // Keep the best match (highest confidence)
    const confidenceRank = { high: 3, medium: 2, low: 1 };
    if (matchType !== "none" && confidenceRank[confidence] > confidenceRank[bestMatch.confidence]) {
      bestMatch = {
        orderId: order.orderId,
        matchType,
        confidence,
        matchedPayment: payment,
        amountMatch,
        nameMatch,
        orderNumberMatch,
      };
    }
    // If same confidence, prefer the one with more matching criteria
    else if (matchType !== "none" && confidenceRank[confidence] === confidenceRank[bestMatch.confidence]) {
      const currentScore = (amountMatch ? 1 : 0) + (nameMatch ? 1 : 0) + (orderNumberMatch ? 1 : 0);
      const bestScore = (bestMatch.amountMatch ? 1 : 0) + (bestMatch.nameMatch ? 1 : 0) + (bestMatch.orderNumberMatch ? 1 : 0);
      if (currentScore > bestScore) {
        bestMatch = {
          orderId: order.orderId,
          matchType,
          confidence,
          matchedPayment: payment,
          amountMatch,
          nameMatch,
          orderNumberMatch,
        };
      }
    }
  }

  return bestMatch;
}

/**
 * Legacy: Match a payment description against an order ID
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
  // Also try fuzzy matching (369 10003 instead of 369-10003)
  const extractedIds = extractOrderIds(payment.description);
  for (const extracted of extractedIds) {
    const match = orderIds.find(id => id.toUpperCase() === extracted.toUpperCase());
    if (match) return match;
  }
  return null;
}
