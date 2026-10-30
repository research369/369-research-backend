import { getPool } from "./db.js";

export type CommunicationPhoneSource = "order_snapshot" | "order_override";

type OverrideEvent = {
  id: number;
  action: "set" | "clear";
  phone_e164: string | null;
};

export type EffectiveCommunicationPhone = {
  orderId: string;
  orderPhone: string;
  effectivePhone: string;
  source: CommunicationPhoneSource;
  latestEventId: number | null;
};

export type CommunicationPhoneWriteInput = {
  orderId: string;
  phone?: string;
  reason: string;
  requestId: string;
  /** Mandatory compare-and-swap version; null explicitly means no prior event. */
  expectedLatestEventId: number | null;
  actor: string;
};

export const ORDER_COMMUNICATION_PHONE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS order_communication_phone_override_events (
    id BIGSERIAL PRIMARY KEY,
    -- No FK on purpose: the audit trail must survive an administrative order deletion.
    order_id VARCHAR(32) NOT NULL,
    action VARCHAR(8) NOT NULL CHECK (action IN ('set', 'clear')),
    phone_e164 VARCHAR(16),
    previous_effective_phone VARCHAR(16),
    reason VARCHAR(500) NOT NULL,
    actor VARCHAR(100) NOT NULL,
    request_id UUID NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
      (action = 'set' AND phone_e164 IS NOT NULL)
      OR (action = 'clear' AND phone_e164 IS NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS order_communication_phone_override_events_order_idx
    ON order_communication_phone_override_events (order_id, id DESC);

  -- Upgrade an early version which still cascaded when an order was deleted.
  DO $$
  DECLARE foreign_key_name TEXT;
  BEGIN
    SELECT constraint_name INTO foreign_key_name
      FROM information_schema.table_constraints
     WHERE table_schema = current_schema()
       AND table_name = 'order_communication_phone_override_events'
       AND constraint_type = 'FOREIGN KEY'
     LIMIT 1;
    IF foreign_key_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE order_communication_phone_override_events DROP CONSTRAINT IF EXISTS %I', foreign_key_name);
    END IF;
  END $$;

  CREATE OR REPLACE FUNCTION prevent_order_communication_phone_event_mutation()
  RETURNS TRIGGER AS $$
  BEGIN
    RAISE EXCEPTION 'Kommunikationsnummern-Audit-Ereignisse sind append-only';
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS order_communication_phone_events_append_only
    ON order_communication_phone_override_events;
  CREATE TRIGGER order_communication_phone_events_append_only
    BEFORE UPDATE OR DELETE ON order_communication_phone_override_events
    FOR EACH ROW EXECUTE FUNCTION prevent_order_communication_phone_event_mutation();
`;

/**
 * An additive, append-only audit trail. It deliberately never mutates
 * orders.phone or customers.phone: those values remain the commercial and
 * delivery snapshots captured with the order.
 */
export async function ensureOrderCommunicationPhoneSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbank für auftragsbezogene Kommunikationsnummern nicht verfügbar");
  await pool.query(ORDER_COMMUNICATION_PHONE_SCHEMA_SQL);
}

/**
 * Normalizes common local German notation and international 00/+ notation to
 * a compact E.164 representation. No country is inferred except for a local
 * German leading zero, matching the shop's existing contact normalization.
 */
export function normalizeOrderCommunicationPhone(value?: string | null): string | null {
  let digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `49${digits.replace(/^0+/, "")}`;
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

export function resolveEffectiveCommunicationPhoneFromEvent(
  orderId: string,
  orderPhone: string | null | undefined,
  event: OverrideEvent | null | undefined,
): EffectiveCommunicationPhone {
  const snapshot = String(orderPhone || "").trim();
  if (event?.action === "set" && event.phone_e164) {
    return {
      orderId,
      orderPhone: snapshot,
      effectivePhone: event.phone_e164,
      source: "order_override",
      latestEventId: Number(event.id),
    };
  }
  return {
    orderId,
    orderPhone: snapshot,
    effectivePhone: snapshot,
    source: "order_snapshot",
    latestEventId: event ? Number(event.id) : null,
  };
}

export function doesCommunicationPhoneVersionMatch(
  expectedLatestEventId: number | null,
  currentLatestEventId: number | null,
): boolean {
  return expectedLatestEventId === currentLatestEventId;
}

function assertReason(reason: string): string {
  const normalized = String(reason || "").trim().replace(/\s+/g, " ");
  if (normalized.length < 5 || normalized.length > 500) {
    throw new Error("Bitte einen kurzen Grund mit 5 bis 500 Zeichen angeben.");
  }
  return normalized;
}

function assertActor(actor: string): string {
  const normalized = String(actor || "").trim().replace(/\s+/g, " ");
  return (normalized || "WaWi-Admin").slice(0, 100);
}

async function readResolutionForLockedOrder(client: any, orderId: string): Promise<EffectiveCommunicationPhone> {
  const orderResult = await client.query(
    "SELECT order_id, phone FROM orders WHERE order_id = $1 FOR UPDATE",
    [orderId],
  );
  const order = orderResult.rows[0];
  if (!order) throw new Error("Bestellung nicht gefunden");

  const eventResult = await client.query(
    `SELECT id, action, phone_e164
       FROM order_communication_phone_override_events
      WHERE order_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [orderId],
  );
  return resolveEffectiveCommunicationPhoneFromEvent(order.order_id, order.phone, eventResult.rows[0] || null);
}

/** Resolve one order for server-side message payloads. */
export async function getEffectiveCommunicationPhone(orderId: string): Promise<EffectiveCommunicationPhone> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbank für auftragsbezogene Kommunikationsnummern nicht verfügbar");
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const orderResult = await client.query(
      "SELECT order_id, phone FROM orders WHERE order_id = $1",
      [orderId],
    );
    const order = orderResult.rows[0];
    if (!order) throw new Error("Bestellung nicht gefunden");
    const eventResult = await client.query(
      `SELECT id, action, phone_e164
         FROM order_communication_phone_override_events
        WHERE order_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      [orderId],
    );
    await client.query("COMMIT");
    return resolveEffectiveCommunicationPhoneFromEvent(order.order_id, order.phone, eventResult.rows[0] || null);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* no transaction left to roll back */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Resolve a list without N+1 queries; orders with no event retain their snapshot. */
export async function getEffectiveCommunicationPhonesForOrders(
  orderSnapshots: Array<{ orderId: string; phone: string | null | undefined }>,
): Promise<Map<string, EffectiveCommunicationPhone>> {
  const result = new Map<string, EffectiveCommunicationPhone>();
  for (const order of orderSnapshots) {
    result.set(order.orderId, resolveEffectiveCommunicationPhoneFromEvent(order.orderId, order.phone, null));
  }
  if (orderSnapshots.length === 0) return result;

  const pool = await getPool();
  if (!pool) throw new Error("Datenbank für auftragsbezogene Kommunikationsnummern nicht verfügbar");
  const orderIds = orderSnapshots.map((order) => order.orderId);
  const events = await pool.query(
    `SELECT DISTINCT ON (order_id) order_id, id, action, phone_e164
       FROM order_communication_phone_override_events
      WHERE order_id = ANY($1::varchar[])
      ORDER BY order_id, id DESC`,
    [orderIds],
  );
  const snapshotById = new Map(orderSnapshots.map((order) => [order.orderId, order.phone]));
  for (const event of events.rows) {
    result.set(
      event.order_id,
      resolveEffectiveCommunicationPhoneFromEvent(event.order_id, snapshotById.get(event.order_id), event),
    );
  }
  return result;
}

async function writeCommunicationPhoneEvent(
  action: "set" | "clear",
  input: CommunicationPhoneWriteInput,
): Promise<EffectiveCommunicationPhone> {
  const normalizedPhone = action === "set" ? normalizeOrderCommunicationPhone(input.phone) : null;
  if (action === "set" && !normalizedPhone) {
    throw new Error("Bitte eine vollständige internationale Telefonnummer eingeben.");
  }
  const reason = assertReason(input.reason);
  const actor = assertActor(input.actor);

  const pool = await getPool();
  if (!pool) throw new Error("Datenbank für auftragsbezogene Kommunikationsnummern nicht verfügbar");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await readResolutionForLockedOrder(client, input.orderId);
    const existing = await client.query(
      `SELECT id FROM order_communication_phone_override_events WHERE request_id = $1 LIMIT 1`,
      [input.requestId],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return current;
    }

    if (!doesCommunicationPhoneVersionMatch(input.expectedLatestEventId, current.latestEventId)) {
      throw new Error("KOMMUNIKATIONSNUMMER_KONFLIKT: Die Nummer wurde zwischenzeitlich geändert. Bitte Auftrag neu laden.");
    }

    await client.query(
      `INSERT INTO order_communication_phone_override_events
         (order_id, action, phone_e164, previous_effective_phone, reason, actor, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.orderId, action, normalizedPhone, current.effectivePhone || null, reason, actor, input.requestId],
    );
    const resolved = await readResolutionForLockedOrder(client, input.orderId);
    await client.query("COMMIT");
    return resolved;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* no transaction left to roll back */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function setOrderCommunicationPhoneOverride(input: CommunicationPhoneWriteInput): Promise<EffectiveCommunicationPhone> {
  return writeCommunicationPhoneEvent("set", input);
}

export async function clearOrderCommunicationPhoneOverride(input: CommunicationPhoneWriteInput): Promise<EffectiveCommunicationPhone> {
  return writeCommunicationPhoneEvent("clear", input);
}
