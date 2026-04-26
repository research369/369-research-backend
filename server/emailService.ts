/**
 * E-Mail Service – Sends order confirmation emails to customers via Resend
 * Uses Resend API (https://resend.com)
 */

const RESEND_API_URL = "https://api.resend.com/emails";

interface OrderEmailData {
  orderId: string;
  customer: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    street: string;
    houseNumber: string;
    zip: string;
    city: string;
    country: string;
    company?: string | null;
  };
  items: {
    name: string;
    dosage?: string | null;
    variant?: string | null;
    price: number;
    quantity: number;
  }[];
  subtotal: number;
  discount: number;
  discountCode?: string | null;
  shipping: number;
  total: number;
  paymentMethod: string;
}

function getPaymentMethodLabel(method: string): string {
  switch (method) {
    case "bunq": return "SEPA-Überweisung (Bunq)";
    case "SEPA": return "SEPA-Überweisung";
    case "creditCard": return "Kreditkarte (Bunq)";
    case "Kreditkarte": return "Kreditkarte";
    case "wise": return "Internationale Überweisung (Wise)";
    case "Bar": return "Barzahlung";
    case "PayPal": return "PayPal";
    case "Crypto": return "Kryptowährung";
    case "Guthaben": return "Partner-Guthaben";
    case "Sonstige": return "Sonstige Zahlungsart";
    default: return method;
  }
}

function getBankDetails(method: string): string {
  if (method === "wise") {
    return `
      <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;">Bank</td><td style="padding:8px 12px;font-size:14px;font-weight:600;">Wise (TransferWise)</td></tr>
      <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;">IBAN</td><td style="padding:8px 12px;font-size:14px;font-weight:600;">BE20 9052 5"; Wird bereitgestellt</td></tr>
    `;
  }
  return `
    <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;">Bank</td><td style="padding:8px 12px;font-size:14px;font-weight:600;">Bunq B.V.</td></tr>
    <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;">IBAN</td><td style="padding:8px 12px;font-size:14px;font-weight:600;">NL40 BUNQ 2114 2"; Wird bereitgestellt</td></tr>
    <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;">BIC</td><td style="padding:8px 12px;font-size:14px;font-weight:600;">BUNQNL2A</td></tr>
  `;
}

function buildOrderConfirmationHtml(data: OrderEmailData): string {
  const itemRows = data.items.map(item => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;font-size:14px;">
        ${item.name}${item.dosage ? ` (${item.dosage})` : ""}${item.variant ? ` – ${item.variant}` : ""}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;font-size:14px;text-align:center;">${item.quantity}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;font-size:14px;text-align:right;">${(item.price * item.quantity).toFixed(2)} €</td>
    </tr>
  `).join("");

  return `
<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:20px;">
    
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#0f172a,#1e293b);border-radius:12px 12px 0 0;padding:32px;text-align:center;">
      <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700;">369 Research</h1>
      <p style="color:#94a3b8;margin:8px 0 0;font-size:14px;">Bestellbestätigung</p>
    </div>

    <!-- Warning Banner -->
    <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:16px 20px;margin:0;">
      <p style="margin:0;font-size:14px;font-weight:600;color:#92400e;">⚠ Wichtiger Hinweis zur Zahlung</p>
      <p style="margin:6px 0 0;font-size:13px;color:#78350f;">Bitte überweise den Betrag eigenständig. Der Versand erfolgt erst nach Zahlungseingang auf unserem Konto.</p>
    </div>

    <!-- Content -->
    <div style="background:#ffffff;padding:24px;border:1px solid #e5e7eb;">
      
      <!-- Order Info -->
      <div style="margin-bottom:24px;">
        <h2 style="font-size:18px;color:#111827;margin:0 0 4px;">Bestellung ${data.orderId}</h2>
        <p style="font-size:13px;color:#6b7280;margin:0;">Vielen Dank für deine Bestellung, ${data.customer.firstName}!</p>
      </div>

      <!-- Items Table -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:10px 12px;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Artikel</th>
            <th style="padding:10px 12px;text-align:center;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Menge</th>
            <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Preis</th>
          </tr>
        </thead>
        <tbody>
          ${itemRows}
        </tbody>
      </table>

      <!-- Totals -->
      <div style="border-top:2px solid #e5e7eb;padding-top:12px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:4px 0;font-size:14px;color:#6b7280;">Zwischensumme</td><td style="padding:4px 0;font-size:14px;text-align:right;">${data.subtotal.toFixed(2)} €</td></tr>
          ${data.discount > 0 ? `<tr><td style="padding:4px 0;font-size:14px;color:#059669;">Rabatt${data.discountCode ? ` (${data.discountCode})` : ""}</td><td style="padding:4px 0;font-size:14px;text-align:right;color:#059669;">-${data.discount.toFixed(2)} €</td></tr>` : ""}
          <tr><td style="padding:4px 0;font-size:14px;color:#6b7280;">Versand</td><td style="padding:4px 0;font-size:14px;text-align:right;">${data.shipping > 0 ? data.shipping.toFixed(2) + " €" : "Kostenlos"}</td></tr>
          <tr><td style="padding:8px 0 0;font-size:18px;font-weight:700;color:#111827;border-top:1px solid #e5e7eb;">Gesamt</td><td style="padding:8px 0 0;font-size:18px;font-weight:700;text-align:right;color:#111827;border-top:1px solid #e5e7eb;">${data.total.toFixed(2)} €</td></tr>
        </table>
      </div>
    </div>

    <!-- Payment Details -->
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-top:none;padding:24px;">
      <h3 style="font-size:16px;color:#1e40af;margin:0 0 12px;">Zahlungsinformationen</h3>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;">Zahlungsart</td><td style="padding:8px 12px;font-size:14px;font-weight:600;">${getPaymentMethodLabel(data.paymentMethod)}</td></tr>
        ${getBankDetails(data.paymentMethod)}
        <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;">Empfänger</td><td style="padding:8px 12px;font-size:14px;font-weight:600;">369 Research</td></tr>
        <tr style="background:#dbeafe;">
          <td style="padding:12px;color:#1e40af;font-size:14px;font-weight:600;">Verwendungszweck</td>
          <td style="padding:12px;font-size:16px;font-weight:700;color:#1e40af;letter-spacing:1px;">${data.orderId}</td>
        </tr>
        <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;">Betrag</td><td style="padding:8px 12px;font-size:14px;font-weight:600;">${data.total.toFixed(2)} €</td></tr>
      </table>
    </div>

    <!-- Shipping Address -->
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;padding:24px;">
      <h3 style="font-size:16px;color:#111827;margin:0 0 8px;">Lieferadresse</h3>
      <p style="font-size:14px;color:#374151;margin:0;line-height:1.6;">
        ${data.customer.firstName} ${data.customer.lastName}${data.customer.company ? `<br>${data.customer.company}` : ""}<br>
        ${data.customer.street} ${data.customer.houseNumber}<br>
        ${data.customer.zip} ${data.customer.city}<br>
        ${data.customer.country}
      </p>
    </div>

    <!-- Next Steps -->
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-top:none;border-radius:0 0 12px 12px;padding:24px;">
      <h3 style="font-size:16px;color:#166534;margin:0 0 12px;">Nächste Schritte</h3>
      <ol style="margin:0;padding:0 0 0 20px;font-size:14px;color:#15803d;line-height:1.8;">
        <li>Überweise <strong>${data.total.toFixed(2)} €</strong> mit dem Verwendungszweck <strong>${data.orderId}</strong></li>
        <li>Nach Zahlungseingang wird deine Bestellung verpackt</li>
        <li>Du erhältst eine Versandbenachrichtigung mit Tracking-Nummer</li>
      </ol>
    </div>

    <!-- Footer -->
    <div style="text-align:center;padding:24px;font-size:12px;color:#9ca3af;">
      <p style="margin:0;">369 Research · Forschungsmaterialien</p>
      <p style="margin:4px 0 0;">Bei Fragen: WhatsApp +4915510063537</p>
    </div>
  </div>
</body>
</html>`;
}

export async function sendOrderConfirmationEmail(data: OrderEmailData): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[Email] RESEND_API_KEY not configured, skipping email");
    return false;
  }

  const html = buildOrderConfirmationHtml(data);

  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "369 Research <noreply@369research.eu>",
        to: [data.customer.email],
        subject: `Bestellbestätigung ${data.orderId} – 369 Research`,
        html,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[Email] Failed to send (${response.status}):`, errorText);
      return false;
    }

    const result = await response.json();
    console.log(`[Email] Order confirmation sent to ${data.customer.email}, id: ${result.id}`);
    return true;
  } catch (error) {
    console.warn("[Email] Error sending order confirmation:", error);
    return false;
  }
}

export async function sendShippingNotificationEmail(data: {
  orderId: string;
  customerEmail: string;
  customerName: string;
  trackingNumber?: string;
  trackingCarrier?: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[Email] RESEND_API_KEY not configured, skipping email");
    return false;
  }

  const trackingInfo = data.trackingNumber
    ? `<p style="font-size:16px;margin:12px 0;"><strong>Tracking-Nummer:</strong> ${data.trackingNumber}</p>
       ${data.trackingCarrier === "DHL" ? `<p style="margin:8px 0;"><a href="https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${data.trackingNumber}" style="background:#fbbf24;color:#111827;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">Sendung verfolgen</a></p>` : ""}`
    : "";

  const html = `
<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:20px;">
    <div style="background:linear-gradient(135deg,#0f172a,#1e293b);border-radius:12px 12px 0 0;padding:32px;text-align:center;">
      <h1 style="color:#ffffff;margin:0;font-size:24px;">369 Research</h1>
      <p style="color:#94a3b8;margin:8px 0 0;font-size:14px;">Versandbenachrichtigung</p>
    </div>
    <div style="background:#ffffff;padding:24px;border:1px solid #e5e7eb;border-radius:0 0 12px 12px;">
      <h2 style="font-size:18px;color:#111827;margin:0 0 12px;">Deine Bestellung ${data.orderId} wurde versendet! 📦</h2>
      <p style="font-size:14px;color:#374151;line-height:1.6;">Hallo ${data.customerName},<br><br>deine Bestellung ist auf dem Weg zu dir!</p>
      ${trackingInfo}
      <p style="font-size:13px;color:#6b7280;margin-top:20px;">Bei Fragen: WhatsApp +4915510063537</p>
    </div>
    <div style="text-align:center;padding:16px;font-size:12px;color:#9ca3af;">369 Research · Forschungsmaterialien</div>
  </div>
</body>
</html>`;

  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "369 Research <noreply@369research.eu>",
        to: [data.customerEmail],
        subject: `Deine Bestellung ${data.orderId} wurde versendet! – 369 Research`,
        html,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[Email] Failed to send shipping notification (${response.status}):`, errorText);
      return false;
    }

    console.log(`[Email] Shipping notification sent to ${data.customerEmail}`);
    return true;
  } catch (error) {
    console.warn("[Email] Error sending shipping notification:", error);
    return false;
  }
}
