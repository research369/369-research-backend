import type { Pool, PoolClient } from 'pg';
import { ENV } from './env.js';
import { PARTNER_SUPPORT_CONTACT } from './partnerContactProfile.js';
import { ensurePartnerInvitationSchema } from './partnerInvitationSchema.js';
import { getPool } from './db.js';

export type InvitationMailKind = 'registration_acknowledgement' | 'approval';
export type MailTransport = (event: MailEvent) => Promise<{ ok: true; providerId?: string } | { ok: false; state: 'failed' | 'unknown'; code: string }>;
export type MailEvent = {
  id: number; applicationId: number; kind: InvitationMailKind; recipientEmail: string; recipientName: string;
  partnerCode: string | null; partnerNumber: string | null; subject: string; textBody: string; htmlBody: string;
};

const RESEND_URL = 'https://api.resend.com/emails';
const esc = (value: string) => value.replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c] || c));
const safeName = (name: string) => name.trim().slice(0, 150);
const firstName = (name: string) => safeName(name).split(/\s+/)[0] || 'Partner';

function copy(kind: InvitationMailKind, name: string, code?: string | null, number?: string | null) {
  const who = firstName(name);
  if (kind === 'registration_acknowledgement') {
    const subject = 'Deine Partner-Anmeldung bei 369 Research';
    const text = `Hallo ${who},\n\nwir haben deine Anmeldung über die persönliche Einladung von CEO Ben erhalten.\n\nDein Partnerzugang ist noch nicht freigeschaltet. Wir prüfen deine Angaben. Nach der Freigabe erhältst du eine weitere E-Mail mit deinem Code und deiner Partnernummer.\n\nDeine Konditionen nach der Freigabe:\n\n- 10 % Rabatt für deine Kunden über deinen persönlichen Code.\n- 10 % auszahlbare Provision für dich auf den provisionsfähigen Warenwert nach allen Rabatten, ohne Versandkosten.\n\nDu musst dich nicht erneut registrieren.\n\nViele Grüße\n369 Research · Partner-Support\n${PARTNER_SUPPORT_CONTACT.email}`;
    return { subject, textBody: text, htmlBody: `<p>Hallo ${esc(who)},</p><p>wir haben deine Anmeldung über die persönliche Einladung von CEO Ben erhalten.</p><p>Dein Partnerzugang ist noch nicht freigeschaltet. Wir prüfen deine Angaben. Nach der Freigabe erhältst du eine weitere E-Mail mit deinem Code und deiner Partnernummer.</p><p>Deine Konditionen nach der Freigabe:</p><ul><li><strong>10 % Rabatt für deine Kunden</strong> über deinen persönlichen Code.</li><li><strong>10 % auszahlbare Provision für dich</strong> auf den provisionsfähigen Warenwert nach allen Rabatten, ohne Versandkosten.</li></ul><p>Du musst dich nicht erneut registrieren.</p><p>Viele Grüße<br>369 Research · Partner-Support<br>${esc(PARTNER_SUPPORT_CONTACT.email)}</p>` };
  }
  const subject = 'Dein Partnercode ist freigeschaltet';
  const text = `Hallo ${who},\n\ndein Partnerzugang ist jetzt freigeschaltet.\n\nDein Kunden-Code: ${code}\nDeine Partnernummer: ${number}\n\nDeine Kunden erhalten über deinen Code 10 % Rabatt. Du erhältst 10 % auszahlbare Provision auf den nach allen Rabatten verbleibenden, provisionsfähigen Warenwert. Versandkosten zählen nicht dazu. Beispiel: 100 € Warenwert → 90 € nach deinem Rabatt → 9 € Provision.\n\nDein Code lässt sich mit weiteren aktuell kombinierbaren Aktionscodes verwenden. Ausdrücklich exklusive Aktionen bleiben ausgenommen.\n\nDein Partnerportal:\nhttps://www.369research.eu/partner\n\nMelde dich mit deiner Partnernummer und dem Passwort an, das du bei der Registrierung gewählt hast.\n\nBankverbindung für Auszahlungen:\nÖffne im Partnerportal Einstellungen → Bankverbindung und hinterlege deinen Kontoinhaber und deine IBAN, bei Bedarf die BIC. Bestätige das Speichern mit deinem aktuellen Passwort. Bitte sende keine Bankdaten per E-Mail.\n\nProvisionen werden nach bestätigter Zahlung und Versand verbucht. Die Auszahlung erfolgt separat; die Registrierung oder das Speichern deiner Bankdaten löst keine Überweisung aus.\n\nViele Grüße\n369 Research · Partner-Support\n${PARTNER_SUPPORT_CONTACT.email}`;
  const h = (v: string | null | undefined) => esc(v || '');
  return { subject, textBody: text, htmlBody: `<p>Hallo ${esc(who)},</p><p>dein Partnerzugang ist jetzt freigeschaltet.</p><p><strong>Dein Kunden-Code: ${h(code)}<br>Deine Partnernummer: ${h(number)}</strong></p><p>Deine Kunden erhalten über deinen Code <strong>10 % Rabatt</strong>. Du erhältst <strong>10 % auszahlbare Provision</strong> auf den nach allen Rabatten verbleibenden, provisionsfähigen Warenwert. Versandkosten zählen nicht dazu. Beispiel: 100 € Warenwert → 90 € nach deinem Rabatt → 9 € Provision.</p><p>Dein Code lässt sich mit weiteren aktuell kombinierbaren Aktionscodes verwenden. Ausdrücklich exklusive Aktionen bleiben ausgenommen.</p><p><strong>Dein Partnerportal:</strong><br><a href="https://www.369research.eu/partner">https://www.369research.eu/partner</a></p><p>Melde dich mit deiner Partnernummer und dem Passwort an, das du bei der Registrierung gewählt hast.</p><p><strong>Bankverbindung für Auszahlungen:</strong><br>Öffne im Partnerportal <strong>Einstellungen → Bankverbindung</strong> und hinterlege deinen Kontoinhaber und deine IBAN, bei Bedarf die BIC. Bestätige das Speichern mit deinem aktuellen Passwort. Bitte sende keine Bankdaten per E-Mail.</p><p>Provisionen werden nach bestätigter Zahlung und Versand verbucht. Die Auszahlung erfolgt separat; die Registrierung oder das Speichern deiner Bankdaten löst keine Überweisung aus.</p><p>Viele Grüße<br>369 Research · Partner-Support<br>${esc(PARTNER_SUPPORT_CONTACT.email)}</p>` };
}

export async function enqueuePartnerInvitationMail(client: Pick<PoolClient, 'query'>, application: { id: number; name: string; email: string }, kind: InvitationMailKind, identifiers?: { code: string; partnerNumber: string }) {
  const c = copy(kind, application.name, identifiers?.code, identifiers?.partnerNumber);
  const inserted = await client.query(`INSERT INTO partner_invitation_mail_events(application_id,kind,recipient_email,recipient_name,partner_code,partner_number,subject,text_body,html_body)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (application_id,kind) DO NOTHING RETURNING id`, [application.id, kind, application.email, safeName(application.name), identifiers?.code ?? null, identifiers?.partnerNumber ?? null, c.subject, c.textBody, c.htmlBody]);
  return inserted.rows[0] ? Number(inserted.rows[0].id) : null;
}

async function transport(event: MailEvent): Promise<{ ok: true; providerId?: string } | { ok: false; state: 'failed' | 'unknown'; code: string }> {
  const key = ENV.resendApiKey;
  if (!key) return { ok: false, state: 'failed', code: 'missing_runtime_key' };
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(RESEND_URL, { method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': `partner-invitation/${event.kind}/${event.id}` }, body: JSON.stringify({ from: PARTNER_SUPPORT_CONTACT.from, reply_to: PARTNER_SUPPORT_CONTACT.replyTo, to: [event.recipientEmail], subject: event.subject, text: event.textBody, html: event.htmlBody }) });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      if (typeof body?.id !== 'string' || !body.id.trim() || body.id.length > 200) return { ok: false, state: 'unknown', code: 'invalid_provider_response' };
      return { ok: true, providerId: body.id };
    }
    return { ok: false, state: response.status >= 500 ? 'unknown' : 'failed', code: `http_${response.status}` };
  } catch (error: any) {
    return { ok: false, state: 'unknown', code: error?.name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally { clearTimeout(timer); }
}

let injectedTransport: MailTransport | undefined;
export function setPartnerInvitationMailTransportForTests(value?: MailTransport) {
  if (process.env.NODE_ENV !== 'test') throw Error('Test transport is unavailable.');
  injectedTransport = value;
}

export async function dispatchPartnerInvitationMailEvent(eventId: number): Promise<void> {
  if (!Number.isSafeInteger(eventId) || eventId <= 0) return;
  await ensurePartnerInvitationSchema(); const pool = await getPool(); if (!pool) return;
  const client = await pool.connect(); let event: MailEvent | undefined;
  try {
    await client.query('BEGIN');
    const result = await client.query(`UPDATE partner_invitation_mail_events SET state='claimed', attempts=1, claimed_at=NOW() WHERE state='new' AND id=$1 RETURNING id,application_id AS "applicationId",kind,recipient_email AS "recipientEmail",recipient_name AS "recipientName",partner_code AS "partnerCode",partner_number AS "partnerNumber",subject,text_body AS "textBody",html_body AS "htmlBody"`, [eventId]);
    if (!result.rows[0]) { await client.query('COMMIT'); return; }
    event = result.rows[0]; await client.query('COMMIT');
  } catch { await client.query('ROLLBACK').catch(() => {}); return; } finally { client.release(); }
  let outcome: Awaited<ReturnType<MailTransport>>;
  try { outcome = await (injectedTransport || transport)(event!); }
  catch { outcome = { ok: false, state: 'unknown', code: 'transport_error' }; }
  const finish = await pool.connect();
  try { await finish.query(`UPDATE partner_invitation_mail_events SET state=$2::varchar(16), provider_id=$3, last_error_code=$4, sent_at=CASE WHEN $2::varchar(16)='sent' THEN NOW() ELSE sent_at END WHERE id=$1 AND state='claimed'`, [event!.id, outcome.ok ? 'sent' : outcome.state, outcome.ok ? (outcome.providerId ?? null) : null, outcome.ok ? null : outcome.code]); } catch { /* ledger inspection remains best effort */ } finally { finish.release(); }
}

const pendingDispatches = new Set<Promise<void>>();
/** Only the committed event created by this exact request can be dispatched. No scanning/backfill. */
export function startPartnerInvitationMailDispatch(eventId: number) {
  const pending = dispatchPartnerInvitationMailEvent(eventId).catch(() => {});
  pendingDispatches.add(pending);
  void pending.finally(() => pendingDispatches.delete(pending));
}
export async function waitForPartnerInvitationMailDispatchesForTests() {
  if (process.env.NODE_ENV !== 'test') throw Error('Test drain is unavailable.');
  while (pendingDispatches.size) await Promise.all([...pendingDispatches]);
}

export async function partnerInvitationMailReady() {
  await ensurePartnerInvitationSchema(); const pool = await getPool();
  if (!pool) return { ready: false, activationAt: null, registrationMail: false, approvalMail: false };
  const row = (await pool.query('SELECT activation_at FROM partner_invitation_mail_activation WHERE id=1')).rows[0];
  const ready = Boolean(row?.activation_at && ENV.resendApiKey);
  return { ready, activationAt: row?.activation_at?.toISOString?.() ?? null, registrationMail: ready, approvalMail: ready };
}
