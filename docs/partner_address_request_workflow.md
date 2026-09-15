# Partnerportal: Adressänderungsanträge

## Zweck

Partner können ihre Lieferadresse im Partnerportal **nicht direkt überschreiben**. Stattdessen erzeugt das Backend einen revisionssicheren Antrag. Nur ein WaWi-Administrator kann die beantragte Adresse ausdrücklich freigeben; erst dann wird der kanonische Partnerdatensatz aktualisiert.

## Datenmodell

Die Tabelle `partner_address_requests` speichert für jeden Antrag die Partnerreferenz, einen Snapshot von Partnername/-nummer/-E-Mail, alte und beantragte Adresse, den Bearbeitungsstatus, den Benachrichtigungsstatus sowie Zeitpunkte und Bearbeiter der Entscheidung.

| Status | Bedeutung |
|---|---|
| `open` | Antrag wartet auf WaWi-Prüfung. |
| `approved` | WaWi hat die Adresse übernommen. |
| `rejected` | WaWi hat den Antrag abgelehnt; die bestehende Adresse bleibt unverändert. |

Gleiche offene Adressdaten werden über einen SHA-256-Fingerprint zusammengeführt. Aktualisiert ein Partner einen noch offenen Antrag auf eine andere Adresse, wird dieser Antrag aktualisiert statt ein weiterer Antrag angelegt.

## API- und UI-Ablauf

1. Das Partnerportal ruft `partner.portalRequestAddressChange` nur mit einem gültigen Partner-JWT auf.
2. Das Backend validiert und speichert den Antrag.
3. Das Partnerportal zeigt den offenen Antrag deutlich als **„Adressänderung wird geprüft“** an.
4. Die WaWi-Seite **Partner / Affiliates** lädt `partner.addressRequests` und zeigt offene Anträge mit alter und beantragter Adresse an.
5. Nur `partner.reviewAddressRequest` darf die Partneradresse übernehmen oder den Antrag ablehnen.

Die frühere Netlify-Funktion `partner-address-request.js` wurde entfernt. Sie war wegen eines CommonJS/ESM-Konflikts nicht lauffähig und führte zu HTTP 502, bevor irgendein Antrag gespeichert werden konnte.

## Interne Benachrichtigung

Die Empfänger werden zentral aus `shop_settings` gelesen und sind **nicht im Router hardcodiert**:

| Schlüssel | Funktion |
|---|---|
| `partner_address_request_notification_recipients` | Durch Semikolon, Komma oder Zeilenumbruch getrennte interne Empfänger. |
| `partner_address_request_notification_enabled` | `true` aktiviert, `false` deaktiviert den zusätzlichen Mailhinweis. |

Die WaWi-Aufgabe ist immer die primäre Nachverfolgung: Auch bei einem Mailfehler bleibt der Antrag in der offenen WaWi-Liste sichtbar und trägt den entsprechenden Versandstatus.

## Datenbankbereitstellung

`drizzle/migrations/0017_partner_address_requests.sql` ist die versionierte Migration. Zusätzlich ruft der Backend-Start `ensurePartnerAddressRequestSchema()` idempotent auf, damit die additive Tabelle und Einstellungen vor Routennutzung vorhanden sind.

## Sicherheitsregeln

* Portalpartner können nur Anträge für den eigenen, tokengebundenen Partnerdatensatz einreichen.
* Freigabe oder Ablehnung verlangt WaWi-Administratorrechte.
* Alte und neue Adresse bleiben beim Antrag erhalten; es gibt keinen unprotokollierten Direkt-Overwrite.
* Die Maildarstellung escaped alle eingegebenen Adress- und Partnerwerte.
