# Checkout V2 – Implementierungsbefunde

**Arbeitsbranch:** `feat/checkout-v2-commerce-contract`
**Referenz:** kanonisches Backend `main` zum Zeitpunkt der Branch-Erstellung

## Führende bestehende Verträge

| Bereich | Bestehender Vertrag | V2-Konsequenz |
|---|---|---|
| Produktpreis | Artikel und Varianten werden im Backend geführt; die bestehende Preisauflösung berücksichtigt Produkt, Stärke sowie Plug&Play- und Kitaufschläge | V2 akzeptiert keine Browserpreise |
| Versand | Versandregion und Kühlkettenaufschlag werden serverseitig ermittelt | V2 akzeptiert keine Browserversandkosten |
| Packstation | Hausadresse und Packstation sind getrennte Lieferarten; kühlpflichtige Positionen schließen Packstation aus | V2 prüft die Sperre vor der Bestellanlage erneut |
| Aktionscode | Aktivstatus, Laufzeit, maximale Nutzung, Mindestwert, Restriktionen und Versandvorteil sind zentral geführt | V2 löst den Code serverseitig auf |
| Partner | Partnercode, Erstkaufvorteil, Eigenbestellung und Guthaben haben getrennte bestehende Verträge | V2 berechnet keine Partnerwerte im Browser |
| Kundenwerben-Kunden | Empfehlungslink, Neukundenregel und Guthaben liegen im bestehenden KWK-Vertrag | V2 übergibt nur die Referenz bzw. eine geschützte Sitzung |
| Nasenspray-Kit | Sieben Produktfamilien, 7-€-Aufschlag und eine BAC-Wasser-Einheit je Kit | Semax + Selank ist im V2-Feature-Vertrag als siebte Familie ergänzt |

## Festgestellte V2-Lücken im bestehenden Main

1. Die aktuelle `order.create`-Schnittstelle akzeptiert noch mehrere bereits berechnete Browsergeldwerte. V2 muss davor eine serverseitig erstellte Quote erzwingen und die Werte unmittelbar vor der Bestellanlage erneut berechnen.
2. Aktions- und Partnercodeprüfung sind noch in getrennten öffentlichen Pfaden verteilt. V2 benötigt einen einzelnen, priorisierten Vorteilsresolver mit eindeutigen Kombinationsregeln.
3. Packstations- und Kühlkettenprüfung existiert, muss jedoch vor einer Zahlungs-/Bestellaktion bereits im Quote-Ergebnis sichtbar sein.
4. Guthaben darf im Quote-Ergebnis höchstens nach geschützter bestehender Sitzung angezeigt werden. Buchungen bleiben an den bestehenden zahlungsgebundenen Ledgerpfad gebunden.

## Neuer reiner Quote-Kern

`server/checkoutV2Quote.ts` ist absichtlich zustandslos. Er führt ausschließlich folgende Prüfungen aus:

- Produktreferenz, Stärke, Variante, führender Preis und verfügbare Menge;
- Plug&Play- und Nasenspray-Kitaufschlag;
- BAC-Wasser-Verfügbarkeit pro Nasenspray-Kit;
- Lieferland, Versand und Kühlketten-/Packstationsausschluss;
- Aktionscode, Partner- oder Empfehlungs-/Guthabenvorteile mit klarer Ausschlussregel.

Er erstellt weder eine Bestellung noch eine Zahlungsanforderung, reserviert keinen Bestand, verbraucht keinen Code und bucht kein Guthaben.

## Sichere Verfügbarkeit

Die öffentliche Route `checkoutV2.quote` ist standardmäßig geschlossen. Sie lässt sich nur öffnen, wenn in einer ausdrücklich getrennten Commerce-Staging-Umgebung **beide** Variablen `CHECKOUT_V2_COMMERCE_STAGING=true` und `FEATURE_CHECKOUT_V2_ENABLED=true` gesetzt sind. Auf Live- und gewöhnlichen Staging-Umgebungen antwortet sie vorher mit `FORBIDDEN` und greift nicht auf die Datenbank zu.

## Lokale Tests

Die lokalen Tests `server/checkoutV2Quote.test.ts`, `server/checkoutV2Router.test.ts` und `server/kwkCheckoutPricing.test.ts` bestehen zusammen mit **18 von 18** Fällen. Sie enthalten keine Datenbankverbindung und keine produktive Mutation.
