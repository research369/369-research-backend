import { getPool } from "./db.js";

type SeedTemplate = {
  key: string;
  channel: "email" | "whatsapp";
  language: "de" | "en";
  title: string;
  subject: string | null;
  body: string;
  sortOrder: number;
};

const DE: Array<Omit<SeedTemplate, "channel" | "language">> = [
  {
    key: "order_confirmation",
    title: "Bestellbestätigung",
    subject: "Bestellbestätigung {{orderId}}",
    body: "Hallo {{firstName}},\n\nvielen Dank für deine Bestellung bei 369 Research.\n\nBestellnummer: {{orderId}}\n{{items}}\n\nGesamtbetrag: {{total}}\n\nSobald deine Zahlung eingegangen ist, bereiten wir deine Bestellung für den Versand vor.\n\nBei Fragen erreichst du uns jederzeit unter {{supportEmail}}.\n\nViele Grüße\n369 Research",
    sortOrder: 10,
  },
  {
    key: "payment_received",
    title: "Zahlung eingegangen",
    subject: "Zahlung zu {{orderId}} eingegangen",
    body: "Hallo {{firstName}},\n\ndeine Zahlung für die Bestellung {{orderId}} ist bei uns eingegangen. Vielen Dank.\n\nWir bereiten deine Bestellung jetzt sorgfältig für den Versand vor. Sobald dein Paket bei DHL registriert ist, erhältst du die Versandinformation.\n\nViele Grüße\n369 Research",
    sortOrder: 20,
  },
  {
    key: "packing_registered",
    title: "Paket wird gepackt",
    subject: "Deine Bestellung {{orderId}} wird vorbereitet",
    body: "Hallo {{firstName}},\n\ndeine Bestellung {{orderId}} wird gerade sorgfältig gepackt und für den Versand vorbereitet.\n\nSobald das Paket bei DHL registriert ist, senden wir dir die Sendungsnummer und den Tracking-Link zu.\n\nViele Grüße\n369 Research",
    sortOrder: 30,
  },
  {
    key: "shipping_registered",
    title: "Versandinformation",
    subject: "Deine Sendung {{orderId}} ist bei {{carrier}} registriert",
    body: "Hallo {{firstName}},\n\ndein Paket zu {{orderId}} wurde sorgfältig gepackt und bei {{carrier}} für den Versand registriert. Es wird heute im Laufe des Tages eingeliefert.\n\nSendungsnummer: {{trackingNumber}}\nSendungsverfolgung: {{trackingUrl}}\n\nInfos zu Dosierungen, Mischen und Pen-Einstellungen: {{penCalculatorUrl}}\nSo verwendest du dein Pen-System mit der Plug&Play Patrone: {{plugAndPlayUrl}}\n\nAngebote, Insights und Research-Protokolle erhältst du auch in unserem WhatsApp-Kanal: {{whatsappChannelUrl}}\n\nViele Grüße\n369 Research",
    sortOrder: 40,
  },
  {
    key: "delivery_follow_up",
    title: "Zustell- und Zufriedenheitsnachfrage",
    subject: "Ist deine Bestellung {{orderId}} gut angekommen?",
    body: "Hallo {{firstName}},\n\nwir möchten kurz nachfragen, ob deine Bestellung {{orderId}} gut angekommen ist.\n\nFalls du Fragen hast oder Unterstützung benötigst, antworte einfach auf diese Nachricht.\n\nViele Grüße\n369 Research",
    sortOrder: 50,
  },
  {
    key: "address_clarification",
    title: "Adressrückfrage",
    subject: "Rückfrage zu deiner Lieferadresse für {{orderId}}",
    body: "Hallo {{firstName}},\n\nfür deine Bestellung {{orderId}} benötigen wir noch eine kurze Bestätigung oder Ergänzung deiner Lieferadresse.\n\nBitte antworte direkt auf diese Nachricht mit der vollständigen Adresse inklusive Hausnummer, PLZ und Ort.\n\nVielen Dank\n369 Research",
    sortOrder: 60,
  },
  {
    key: "payment_reminder",
    title: "Freundliche Zahlungserinnerung",
    subject: "Zahlungserinnerung zu {{orderId}}",
    body: "Hallo {{firstName}},\n\nzu deiner Bestellung {{orderId}} über {{total}} ist bei uns noch keine Zahlung eingegangen. Vielleicht ist die Überweisung noch unterwegs.\n\nZahlungsdaten:\n{{paymentDetails}}\n\nBitte verwende {{orderId}} als Verwendungszweck. Bei Fragen helfen wir dir gerne weiter.\n\nViele Grüße\n369 Research",
    sortOrder: 70,
  },
  {
    key: "cancellation_warning",
    title: "Stornierung in 12 Stunden",
    subject: "Wichtige Information zu {{orderId}}",
    body: "Hallo {{firstName}},\n\nfür deine Bestellung {{orderId}} über {{total}} ist bei uns weiterhin keine Zahlung eingegangen. Die Ware ist aktuell für dich reserviert.\n\nWenn wir innerhalb der nächsten 12 Stunden keine Zahlung oder Rückmeldung erhalten, müssen wir die Bestellung stornieren, damit die reservierten Artikel wieder verfügbar werden.\n\nZahlungsdaten:\n{{paymentDetails}}\n\nBitte verwende {{orderId}} als Verwendungszweck. Falls du Unterstützung brauchst, antworte einfach auf diese Nachricht.\n\nViele Grüße\n369 Research",
    sortOrder: 75,
  },
  {
    key: "support_general",
    title: "Freie Supportantwort",
    subject: "Nachricht von 369 Research",
    body: "Hallo {{firstName}},\n\nvielen Dank für deine Nachricht.\n\n[Bitte hier die individuelle Antwort ergänzen.]\n\nBei Fragen erreichst du uns jederzeit unter {{supportEmail}}.\n\nViele Grüße\n369 Research",
    sortOrder: 80,
  },
];

const EN: Array<Omit<SeedTemplate, "channel" | "language">> = [
  {
    key: "order_confirmation",
    title: "Order confirmation",
    subject: "Order confirmation {{orderId}}",
    body: "Hello {{firstName}},\n\nthank you for your order with 369 Research.\n\nOrder number: {{orderId}}\n{{items}}\n\nOrder total: {{total}}\n\nAs soon as your payment has been received, we will prepare your order for dispatch.\n\nFor any questions, please contact us at {{supportEmail}}.\n\nKind regards\n369 Research",
    sortOrder: 10,
  },
  {
    key: "payment_received",
    title: "Payment received",
    subject: "Payment received for {{orderId}}",
    body: "Hello {{firstName}},\n\nwe have received your payment for order {{orderId}}. Thank you.\n\nWe are now carefully preparing your order for dispatch. Once your parcel is registered with DHL, you will receive the shipping update.\n\nKind regards\n369 Research",
    sortOrder: 20,
  },
  {
    key: "packing_registered",
    title: "Parcel is being prepared",
    subject: "Your order {{orderId}} is being prepared",
    body: "Hello {{firstName}},\n\nyour order {{orderId}} is currently being carefully packed and prepared for dispatch.\n\nOnce the parcel is registered with DHL, we will send your tracking number and tracking link.\n\nKind regards\n369 Research",
    sortOrder: 30,
  },
  {
    key: "shipping_registered",
    title: "Shipping update",
    subject: "Your shipment {{orderId}} is registered with {{carrier}}",
    body: "Hello {{firstName}},\n\nyour parcel for order {{orderId}} has been carefully packed and registered with {{carrier}} for dispatch. It will be handed in later today.\n\nTracking number: {{trackingNumber}}\nTrack your parcel: {{trackingUrl}}\n\nInformation on dosing, mixing and pen settings: {{penCalculatorUrl}}\nHow to use your pen system with the Plug&Play cartridge: {{plugAndPlayUrl}}\n\nFor offers, insights and research protocols, join our WhatsApp channel: {{whatsappChannelUrl}}\n\nKind regards\n369 Research",
    sortOrder: 40,
  },
  {
    key: "delivery_follow_up",
    title: "Delivery follow-up",
    subject: "Has your order {{orderId}} arrived safely?",
    body: "Hello {{firstName}},\n\nwe would like to briefly check whether your order {{orderId}} arrived safely.\n\nIf you have any questions or need support, simply reply to this message.\n\nKind regards\n369 Research",
    sortOrder: 50,
  },
  {
    key: "address_clarification",
    title: "Address clarification",
    subject: "Address clarification for {{orderId}}",
    body: "Hello {{firstName}},\n\nfor order {{orderId}}, we need a short confirmation or completion of your delivery address.\n\nPlease reply directly to this message with the complete address, including house number, postcode and city.\n\nThank you\n369 Research",
    sortOrder: 60,
  },
  {
    key: "payment_reminder",
    title: "Friendly payment reminder",
    subject: "Payment reminder for {{orderId}}",
    body: "Hello {{firstName}},\n\nwe have not yet received payment for your order {{orderId}} totalling {{total}}. Your transfer may still be in progress.\n\nPayment details:\n{{paymentDetails}}\n\nPlease use {{orderId}} as the payment reference. We are happy to help if you have any questions.\n\nKind regards\n369 Research",
    sortOrder: 70,
  },
  {
    key: "cancellation_warning",
    title: "Cancellation in 12 hours",
    subject: "Important information about {{orderId}}",
    body: "Hello {{firstName}},\n\nwe have still not received payment for your order {{orderId}} totalling {{total}}. The items are currently reserved for you.\n\nIf we do not receive payment or a reply within the next 12 hours, we will need to cancel the order so that the reserved items can become available again.\n\nPayment details:\n{{paymentDetails}}\n\nPlease use {{orderId}} as the payment reference. If you need support, simply reply to this message.\n\nKind regards\n369 Research",
    sortOrder: 75,
  },
  {
    key: "support_general",
    title: "General support reply",
    subject: "Message from 369 Research",
    body: "Hello {{firstName}},\n\nthank you for your message.\n\n[Please add your individual reply here.]\n\nFor any questions, please contact us at {{supportEmail}}.\n\nKind regards\n369 Research",
    sortOrder: 80,
  },
];

const SETTINGS: Array<[string, string]> = [
  ["communication_pen_calculator_url", "https://www.369research.eu/penrechner"],
  ["communication_plug_and_play_url", "https://www.369research.eu/plug-and-play"],
  ["communication_whatsapp_channel_url", "https://whatsapp.com/channel/0029VbCjCg73rZZbFb5d8A11"],
  ["communication_support_email", "support@369research.eu"],
  ["communication_payment_iban", "DE81 3701 9000 1011 3936 89"],
  ["communication_payment_bic", "BUNQDE82"],
  ["communication_payment_recipient", "369 Research"],
];

/**
 * Additive and idempotent CRM template library. Templates are persisted in PostgreSQL
 * and can be maintained through the WaWi without future code changes.
 */
export async function ensureCommunicationTemplateSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für Kommunikationsvorlagen nicht verfügbar");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS communication_templates (
      id SERIAL PRIMARY KEY,
      template_key VARCHAR(100) NOT NULL,
      channel VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'whatsapp')),
      language VARCHAR(5) NOT NULL CHECK (language IN ('de', 'en')),
      title VARCHAR(200) NOT NULL,
      subject_template TEXT,
      body_template TEXT NOT NULL,
      is_active SMALLINT NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT communication_templates_key_channel_language_unique UNIQUE (template_key, channel, language)
    );

    CREATE INDEX IF NOT EXISTS communication_templates_lookup_idx
      ON communication_templates (channel, language, is_active, sort_order);

    CREATE TABLE IF NOT EXISTS communication_template_audit (
      id SERIAL PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES communication_templates(id) ON DELETE CASCADE,
      action VARCHAR(30) NOT NULL,
      previous_value JSONB,
      next_value JSONB,
      changed_by VARCHAR(100) NOT NULL DEFAULT 'admin',
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS communication_template_audit_template_idx
      ON communication_template_audit (template_id, created_at DESC);
  `);

  for (const [key, value] of SETTINGS) {
    await pool.query(
      `INSERT INTO shop_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value],
    );
  }

  const seedTemplates: SeedTemplate[] = [
    ...DE.flatMap((template) => ([
      { ...template, channel: "email" as const, language: "de" as const },
      { ...template, channel: "whatsapp" as const, language: "de" as const, subject: null },
    ])),
    ...EN.flatMap((template) => ([
      { ...template, channel: "email" as const, language: "en" as const },
      { ...template, channel: "whatsapp" as const, language: "en" as const, subject: null },
    ])),
  ];

  for (const template of seedTemplates) {
    await pool.query(
      `INSERT INTO communication_templates
        (template_key, channel, language, title, subject_template, body_template, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
       ON CONFLICT (template_key, channel, language) DO NOTHING`,
      [template.key, template.channel, template.language, template.title, template.subject, template.body, template.sortOrder],
    );
  }

  console.log("[CRM] Zweisprachige Kommunikationsvorlagen bereit");
}
