# Globaler automatischer Dauerrabatt

## Zweck

Der **globale automatische Dauerrabatt** ist eine zentrale, codefreie und zeitlich begrenzte Rabattaktion für alle regulären Shoppositionen. Administriert wird sie ausschließlich im bestehenden WaWi-Bereich **Aktionscodes**. Sie wird nie über eine Umgebungsvariable, eine Produktliste oder im Frontend hart codiert aktiviert.

Die Konfiguration ist nach einer Auslieferung standardmäßig **deaktiviert**. Sie darf ausschließlich durch einen Administrator mit Prozentsatz und exaktem Endzeitpunkt aktiviert werden.

## Persistenz und Konfiguration

Die Konfiguration liegt als JSON in `shop_settings` unter dem Schlüssel:

```text
global_automatic_discount
```

```ts
{
  enabled: boolean,
  percentage: number,                 // 0 bis 100
  expiresAt: string | null,           // ISO-8601, für enabled verpflichtend
  stackWithPromotionCodes: boolean,   // standardmäßig true
  labelDe: string,
  labelEn: string
}
```

`server/globalAutomaticDiscountConfig.ts` ist die einzige fachliche Quelle für Parsing, Fallback, Aktivitätsprüfung und Speicherung. Fehlende oder ungültige Daten werden defensiv als **deaktiviert** behandelt. Der Endzeitpunkt gilt exakt: Ab `expiresAt` ist die Aktion nicht mehr aktiv.

## Schnittstellen

| Route | Zugriff | Zweck |
|---|---|---|
| `shopSettings.getGlobalAutomaticDiscount` | öffentlich | Liefert ausschließlich die aktuell aktive Aktion oder `null` für Shopanzeige und Warenkorb. |
| `shopSettings.getGlobalAutomaticDiscountAdmin` | Admin | Liefert die vollständige Konfiguration für die WaWi-Verwaltung. |
| `shopSettings.setGlobalAutomaticDiscount` | Admin | Validiert Prozentwert und zwingend einen zukünftigen Endzeitpunkt bei Aktivierung, dann speichert zentral. |

Die Autorisierung erfolgt serverseitig über `adminProcedure`. Der öffentliche Vertrag enthält keine Bearbeitungsfunktion und gibt bei inaktiver oder abgelaufener Aktion kein konfigurierbares Rabattobjekt zurück.

## Verbindliche Preisreihenfolge

> Warenwert → globaler Dauerrabatt → Aktionscode → Partner-/KWK-Rabatt → Guthabeneinlösung → Versand

Der Dauerrabatt betrifft ausschließlich bezahlte Warenpositionen. Gratispositionen haben den Preis `0` und können damit keinen Rabatt erzeugen. Versand und Kühlversand sind ausdrücklich ausgeschlossen.

| Stufe | Grundlage | Besonderheit |
|---|---|---|
| Dauerrabatt | Bruttowarenwert | Prozentwert aus der aktuell gültigen Datenbankkonfiguration. |
| Aktionscode | Nach Dauerrabatt verbleibender berechtigter Warenwert | Bei Produktrestriktionen wird nur der verbleibende Wert der berechtigten Positionen verwendet. Feste Beträge sind daran gedeckelt. |
| Partner-/KWK-Rabatt | Nach Dauerrabatt und Aktionscode verbleibender Warenwert | Versand bleibt unberührt. Partner- und KWK-Wege bleiben gegenseitig ausgeschlossen. |
| Guthaben | Verbleibender zulässiger Warenwert | Guthaben ist ein Zahlungsmittel und führt nicht zu neuem Partnerguthaben. |

Bei aktivem Dauerrabatt rekonstruiert `orderRouter.create` Artikelpreise und Warenwert aus dem Warenkatalog. Der Browser kann weder Prozentsatz noch Dauerrabattbetrag vorgeben. Er übermittelt für eine aktuelle Bestellung lediglich die sichtbare Herkunftszeile; stimmt sie nicht mit der serverseitigen Konfiguration überein, wird der Auftrag abgewiesen und der Warenkorb muss aktualisiert werden.

## Provenienz in Bestellungen

Die Rabattaufschlüsselung verwendet die eindeutige Quelle:

```text
automatic_global_percent
```

Der Server ersetzt jede vom Browser gesendete Zeile dieser Quelle durch die serverseitig neu berechnete Zeile. Damit werden Dauerrabatt, Aktionscode, Partner-/KWK-Rabatt und Guthaben in Auftrag, WaWi und Auswertungen getrennt nachvollziehbar.

## Relevante Dateien

| Datei | Verantwortung |
|---|---|
| `server/globalAutomaticDiscountConfig.ts` | zentrale DB-Konfiguration und Aktivitätsprüfung |
| `server/kwkCheckoutPricing.ts` | reine, testbare gestaffelte Preisberechnung |
| `server/orderRouter.ts` | autoritative Rekonstruktion und Persistenz der Rabattprovenienz |
| `client/src/contexts/CartContext.tsx` | öffentliche Anzeige, regelmäßiges Nachladen und Client-Vorschau |
| `client/src/pages/Checkout.tsx` | transparente Preiszeilen und Übergabe der Einzelquellen |
| `client/src/components/CartDrawer.tsx` | transparente Warenkorb-Preiszeile |
| `client/src/pages/WaWiPromoCodes.tsx` | admin-exklusive Steuerung im bestehenden Codebereich |

## Regressionstests

`tests/globalAutomaticDiscountPricing.test.ts` deckt Parser-Fallbacks, exakten Ablaufzeitpunkt, 100%-Grenzen, Prozent- und Festbetrags-Codes, Partnerguthabenbasis, KWK/Guthaben sowie den unveränderten Versand ab.

Ausführen:

```bash
./node_modules/.bin/tsx tests/globalAutomaticDiscountPricing.test.ts
```
