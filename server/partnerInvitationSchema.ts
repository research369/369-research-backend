import { readFileSync } from 'node:fs';
import { getPool } from './db.js';
let readiness: Promise<void> | undefined;
/** Lazy, invitation-only readiness. A failure is retryable and cannot break shop startup. */
export async function ensurePartnerInvitationSchema(): Promise<void> {
  if (!readiness) {
    readiness = (async () => {
        const sql = [
          readFileSync(new URL('../drizzle/migrations/0035_partner_invitation_applications.sql', import.meta.url), 'utf8'),
          readFileSync(new URL('../drizzle/migrations/0037_partner_invitation_mail_outbox.sql', import.meta.url), 'utf8'),
        ].join('\n');
      const pool = await getPool();
      if (!pool) throw Error('Invitation database unavailable');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('369:partner-invitation-schema:v1'))");
        await client.query(sql);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    })().catch(error => { readiness = undefined; throw error; });
  }
  await readiness;
}
