# Adress-Snapshot-Schutz – DHL-Fall vom 05.11.2026

## Belegter Codefehler

`customerRouter.update` hat bisher beim Kundenprofil-Update alle verknüpften Bestellungen durchlaufen und dort leere Firmen-, Namens-, Straßen-, Hausnummer-, PLZ-, Stadt-, Länder- und DHL-Postnummerfelder aus den neuen Kundendaten nachgefüllt. Ein leeres optionales Firmenfeld gehört jedoch zur ursprünglichen Auftragsadresse. Das Nachfüllen kann eine deutsche historische Adresse mit einem spanischen Zusatz aus einem späteren Profil verbinden. `dhlExpressRouter` stellt einen vorhandenen Firmenwert als erste Empfängerzeile vor den Personennamen. Die Kombination erklärt eine mögliche zusätzliche spanische Zeile im DHL-PDF.

Der Fix entfernt das Nachfüllen sämtlicher auftragsgebundener Namens- und Adressfelder. Nur bisher fehlende E-Mail-/Telefon-Kontaktkanäle behalten ihre etablierte Ergänzung, mit atomarer WHERE-Bedingung statt Read-then-Write. Bestehende Auftragsdaten werden nicht rückwirkend bereinigt.

Auch die Checkout-Änderungsbestätigung und manuelle Profilübernahme haben bislang leere Firmen-/DHL-Zusätze aus der vorigen Adresse übernommen. Ein explizit leerer Zusatz bleibt jetzt leer. Nur wirklich nicht übermittelte Legacy-Felder bei unveränderter Adresse dürfen erhalten bleiben; ein Adresswechsel übernimmt niemals fehlende Zusätze aus dem alten Profil. Bestätigungsablauf und immutable Kundendatenhistorie bleiben aktiv.

## Konkreter Elvis-Datensatz

Die konkrete Bestellung, ihr ursprünglicher Snapshot, das PDF und die Änderungsereignisse sind bisher **nicht gelesen und nicht verändert**. Der gespeicherte PostgreSQL-Zugang wurde am 05.11.2026 mit Authentisierungsfehler zurückgewiesen. Die vorhandene persönliche WaWi-Sitzung wurde auf die Loginseite umgeleitet (401). Der Railway-API-Zugang wurde lesend mit `Not Authorized` zurückgewiesen. Daher ist der beschriebene Codefehler belegt, sein tatsächlicher Ablauf bei Elvis aber noch nicht bestätigt. Keine Namen, Adressen, Trackingnummern oder Geheimnisse sind in dieser Notiz enthalten.

Es wurde kein DHL-Label storniert, kein Ersatzlabel gebucht und keine Kundenmitteilung erzeugt. Das vom Benutzer genannte Portal-Storno muss erst am eindeutig ausgewählten Auftrag ausdrücklich bestätigt werden; ein nicht gefundener DHL-Auftrag ist keine technische Stornobestätigung.

## Regressionstests

`customerDataChangeService.test.ts` prüft explizit leere Werte, tatsächlich ausgelassene Legacy-Felder, unveränderte Adressen und den Wechsel Spanien → Deutschland ohne Zusatzübernahme. `customerOrderSnapshotProtection.test.ts` verhindert erneute historische Adressnachfüllung im CRM-Mutationspfad. Die bestehenden Bestellbestätigungs- und Kommunikationsnummerntests bleiben unverändert grün.

## Quelle

DHL erlaubt `DELETE /orders` nur vor Manifestierung/Tagesabschluss. Danach ist eine reguläre Korrektur über diesen Stornoweg nicht möglich: https://developer.dhl.com/api-reference/parcel-de-shipping-post-parcel-germany-v2?language_content_entity=en
