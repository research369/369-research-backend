import { getPool } from "./db.js";

/** Only codes issued from an existing order receive this internal reminder. */
export const PERSONAL_PROMO_EXPIRY_REMINDER_DAYS = 10;

export type PersonalPromoExpiryReminderSchedule = {
  expiresAt: Date;
  dueAt: Date;
};

function endOfPromoValidityDate(validUntil: Date): Date {
  const end = new Date(validUntil);
  // Normal WaWi promotion codes are valid through the entire selected date.
  // Keep the internal reminder aligned with that established validation rule.
  end.setHours(23, 59, 59, 999);
  return end;
}

/**
 * Returns the one internal reminder schedule for a still-valid issued code.
 * A code with fewer than ten days remaining becomes due immediately because its
 * scheduled date is already in the past; no customer message is sent here.
 */
export function calculatePersonalPromoExpiryReminderSchedule(
  validUntil: Date | null | undefined,
  now = new Date(),
): PersonalPromoExpiryReminderSchedule | null {
  if (!validUntil || Number.isNaN(validUntil.getTime())) return null;

  const expiresAt = endOfPromoValidityDate(validUntil);
  if (expiresAt <= now) return null;

  return {
    expiresAt,
    dueAt: new Date(expiresAt.getTime() - PERSONAL_PROMO_EXPIRY_REMINDER_DAYS * 24 * 60 * 60 * 1000),
  };
}

/** Additive, idempotent storage for internal expiry reminders. */
export async function ensurePersonalPromoExpiryReminderSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für Aktionscode-Erinnerungen nicht verfügbar");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS personal_promo_expiry_reminders (
      id SERIAL PRIMARY KEY,
      promo_code_id INTEGER NOT NULL UNIQUE REFERENCES promo_codes(id) ON DELETE RESTRICT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      origin_order_id VARCHAR(32) NOT NULL REFERENCES orders(order_id) ON DELETE RESTRICT,
      code VARCHAR(50) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      due_at TIMESTAMP NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped')),
      completed_at TIMESTAMP,
      skipped_at TIMESTAMP,
      completed_by VARCHAR(100),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS personal_promo_expiry_reminders_status_due_idx
      ON personal_promo_expiry_reminders (status, due_at);

    CREATE INDEX IF NOT EXISTS personal_promo_expiry_reminders_customer_idx
      ON personal_promo_expiry_reminders (customer_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS personal_promo_expiry_reminders_order_idx
      ON personal_promo_expiry_reminders (origin_order_id, created_at DESC);
  `);

  console.log("[PersonalPromoExpiryReminders] Schema ready");
}

type Queryable = {
  query: (query: string, values?: unknown[]) => Promise<{ rowCount?: number | null }>;
};

/**
 * Creates the queue record at issue time. It is a no-op for unlimited or
 * already-expired codes and remains idempotent per issued promo-code ID.
 */
export async function createPersonalPromoExpiryReminder(
  client: Queryable,
  input: {
    promoCodeId: number;
    customerId: number;
    originOrderId: string;
    code: string;
    validUntil: Date | null | undefined;
  },
  now = new Date(),
): Promise<{ created: boolean; schedule: PersonalPromoExpiryReminderSchedule | null }> {
  const schedule = calculatePersonalPromoExpiryReminderSchedule(input.validUntil, now);
  if (!schedule) return { created: false, schedule: null };

  const result = await client.query(
    `INSERT INTO personal_promo_expiry_reminders
       (promo_code_id, customer_id, origin_order_id, code, expires_at, due_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (promo_code_id) DO NOTHING`,
    [
      input.promoCodeId,
      input.customerId,
      input.originOrderId,
      input.code,
      schedule.expiresAt,
      schedule.dueAt,
    ],
  );

  return { created: (result.rowCount || 0) === 1, schedule };
}

/**
 * Backfills missing queue records for issued order codes made before this
 * feature was deployed. It never creates reminders for general promo codes,
 * deactivated, exhausted, or already expired codes.
 */
export async function syncPersonalPromoExpiryReminders(now = new Date()): Promise<number> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für Aktionscode-Erinnerungen nicht verfügbar");

  const result = await pool.query(
    `INSERT INTO personal_promo_expiry_reminders
       (promo_code_id, customer_id, origin_order_id, code, expires_at, due_at)
     SELECT assignment.promo_code_id,
            assignment.customer_id,
            assignment.origin_order_id,
            promo.code,
            date_trunc('day', promo.valid_until) + INTERVAL '1 day' - INTERVAL '1 millisecond',
            date_trunc('day', promo.valid_until) + INTERVAL '1 day' - INTERVAL '1 millisecond' - ($1::int * INTERVAL '1 day')
       FROM customer_promo_assignments assignment
       JOIN promo_codes promo ON promo.id = assignment.promo_code_id
      WHERE promo.valid_until IS NOT NULL
        AND promo.is_active = 1
        AND (promo.max_uses = 0 OR promo.current_uses < promo.max_uses)
        AND date_trunc('day', promo.valid_until) + INTERVAL '1 day' - INTERVAL '1 millisecond' > $2
     ON CONFLICT (promo_code_id) DO NOTHING`,
    [PERSONAL_PROMO_EXPIRY_REMINDER_DAYS, now],
  );

  return result.rowCount || 0;
}
