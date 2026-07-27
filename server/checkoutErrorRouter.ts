/**
 * checkoutErrorRouter.ts – Checkout-Fehler Backup
 *
 * Empfängt Checkout-Fehler vom Frontend wenn beide Versuche fehlschlagen.
 * Speichert die Bestelldaten in der failed_orders-Tabelle und sendet
 * sofort eine Admin-E-Mail an 369rebackup@gmail.com.
 *
 * Endpunkt: POST /api/checkout-error
 * Auth: keine (öffentlich – Fehler müssen immer gespeichert werden)
 * Additiv: keine Änderungen an bestehenden Routen
 */

import { Router, type Request, type Response } from "express";
import { ENV } from "./env.js";
import { getPool } from "./db.js";

export const checkoutErrorRouter = Router();

checkoutErrorRouter.post("/api/checkout-error", async (req: Request, res: Response) => {
  const data = req.body;

  // Sofort 200 zurückgeben damit der Client nicht wartet
  res.json({ success: true });

  const customer = data.customer || {};
  const items = data.items || [];
  const orderId = data.orderId || `FEHLER-${Date.now()}`;
  const total = data.total || 0;
  const errorMsg = data.error || "Unbekannter Fehler";

  console.log(`[checkout-error] Fehler-Bestellung empfangen: ${orderId} | ${customer.firstName} ${customer.lastName} | ${total}€`);

  // In failed_orders Tabelle speichern
  try {
    const pool = await getPool();
    if (pool) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS failed_orders (
          id SERIAL PRIMARY KEY,
          attempted_order_id VARCHAR(50),
          customer_name VARCHAR(200),
          customer_email VARCHAR(320),
          customer_phone VARCHAR(50),
          total DECIMAL(10,2),
          items_json TEXT,
          input_json TEXT,
          error_message TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await pool.query(
        `INSERT INTO failed_orders (attempted_order_id, customer_name, customer_email, customer_phone, total, items_json, input_json, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          orderId,
          `${customer.firstName || ''} ${customer.lastName || ''}`.trim(),
          customer.email || '',
          customer.phone || '',
          total,
          JSON.stringify(items),
          JSON.stringify(data),
          errorMsg,
        ]
      );
      console.log(`[checkout-error] Gespeichert in failed_orders: ${orderId}`);
    }
  } catch (dbErr: any) {
    console.error('[checkout-error] DB-Fehler:', dbErr?.message);
  }

  // Admin-E-Mail über Resend
  try {
    if (ENV.resendApiKey) {
      const itemsList = items.map((i: any) => `${i.quantity}x ${i.name} ${i.dosage || ''}`).join(', ');
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ENV.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'noreply@369research.eu',
          to: ['369rebackup@gmail.com'],
          subject: `⚠️ CHECKOUT FEHLER: ${customer.firstName} ${customer.lastName} | ${total}€`,
          html: `
            <h2 style="color:#cc0000">⚠️ Checkout-Fehler – Bestellung nicht gespeichert</h2>
            <table style="border-collapse:collapse;width:100%">
              <tr><td style="padding:8px;font-weight:bold">Bestellnummer</td><td style="padding:8px">${orderId}</td></tr>
              <tr><td style="padding:8px;font-weight:bold">Kunde</td><td style="padding:8px">${customer.firstName} ${customer.lastName}</td></tr>
              <tr><td style="padding:8px;font-weight:bold">E-Mail</td><td style="padding:8px">${customer.email}</td></tr>
              <tr><td style="padding:8px;font-weight:bold">Telefon</td><td style="padding:8px">${customer.phone}</td></tr>
              <tr><td style="padding:8px;font-weight:bold">Adresse</td><td style="padding:8px">${customer.street} ${customer.houseNumber}, ${customer.zip} ${customer.city}</td></tr>
              <tr><td style="padding:8px;font-weight:bold">Betrag</td><td style="padding:8px;font-size:18px;color:#0040C1"><strong>${total}€</strong></td></tr>
              <tr><td style="padding:8px;font-weight:bold">Artikel</td><td style="padding:8px">${itemsList}</td></tr>
              <tr><td style="padding:8px;font-weight:bold">Zahlungsmethode</td><td style="padding:8px">${data.paymentMethod || '?'}</td></tr>
              <tr><td style="padding:8px;font-weight:bold">Fehler</td><td style="padding:8px;color:#cc0000">${errorMsg}</td></tr>
              <tr><td style="padding:8px;font-weight:bold">Zeitstempel</td><td style="padding:8px">${data.timestamp || new Date().toISOString()}</td></tr>
            </table>
            <p style="margin-top:20px;padding:12px;background:#fff3cd;border:1px solid #ffc107;border-radius:4px">
              <strong>Aktion erforderlich:</strong> Bitte Bestellung manuell in der WaWi anlegen und Kunden kontaktieren.
            </p>
          `,
        }),
      });
      if (response.ok) {
        console.log(`[checkout-error] Admin-E-Mail gesendet für ${orderId}`);
      } else {
        console.error(`[checkout-error] E-Mail-Fehler: ${response.status}`);
      }
    }
  } catch (emailErr: any) {
    console.error('[checkout-error] E-Mail-Fehler:', emailErr?.message);
  }
});
