# Kombinierbare Partner- und Aktionscodes

## Zweck

Ein **öffentlicher Partner-/Creator-Code** und **ein allgemeiner Aktionscode** sind zwei getrennte Rabattquellen. Sie können in einer Shop-Bestellung gleichzeitig verwendet werden – auch bei Waren, deren Shoppreis bereits reduziert ist, etwa bei Bundles.

> Ein bereits reduzierter Shoppreis sperrt weder den Aktionscode noch den Partner-/Creator-Code.

Das gilt nur für gültige, aktive Codes. Es bleibt bei **einem** allgemeinen Aktionscode und **einem** öffentlichen Partner-/Creator-Code pro Bestellung.

## Explizit ausgenommen

- **Versand und Kühlversand** werden durch diese Codes nicht reduziert.
- **KWK** bleibt zu jeder Partnerzuordnung ausgeschlossen; dessen eigene Regeln und Missbrauchsschutz bleiben unverändert.
- Eine **Partner-Eigenbestellung** ist kein öffentlicher Partnercode-Fall. Sie bleibt an den Partner-Login gebunden und hat ihre eigene Rabatt- und Guthabenlogik.

## Preisreihenfolge

Die geltende, serverautoritativ berechnete Reihenfolge lautet:

```text
aktueller Shoppreis (einschließlich Bundlepreis)
→ globaler automatischer Rabatt, falls aktiv
→ allgemeiner Aktionscode
→ öffentlicher Partner-/Creator-Code
→ gegebenenfalls zulässiges Guthaben
→ Versand
```

Beispiel bei einem Bundle zu 100,00 €:

| Stufe | Rechnung | Betrag |
|---|---:|---:|
| Aktueller Bundlepreis | – | 100,00 € |
| Aktionscode 10 % | −10,00 € | 90,00 € |
| Creator-Code 15 % | −13,50 € | 76,50 € |
| Versand | getrennt, unverändert | +8,00 € |

Der Partner-/Creator-Rabatt wird somit auf den nach allgemeinen Shoprabatten verbleibenden Warenwert berechnet. Die konkrete Codezeile liefert dabei immer den eigenen Rabatt- und Provisionssatz.

## Autorität und Audit

Der Browser zeigt nur eine Vorschau und übermittelt die verwendeten Codezeichen. `server/orderRouter.ts` löst beide Codes neu aus der Datenbank auf, prüft Laufzeit/Nutzung/Produktregeln und berechnet Rabatt, Order-Total, Code-Snapshots und Provisionsbasis erneut.

In der gespeicherten Rabattaufschlüsselung werden Browser-Vorschauen für serverautoritativ aufgelöste Aktions- und Partnercodes verworfen und exakt einmal mit den serverseitig berechneten Werten neu aufgebaut. Damit bleiben Checkout, Bestellung, Ledger und Abrechnung idempotent und revisionssicher.

## Relevante Dateien

| Datei | Verantwortung |
|---|---|
| `server/orderRouter.ts` | serverautoritatives Auflösen, Berechnen und Speichern |
| `server/partnerProgramService.ts` | codegenaue Partner-/Creator-Konditionen |
| `server/partnerCreditService.ts` | zahlungsgebundene, idempotente Provision |
| `client/src/contexts/CartContext.tsx` | getrennte Client-Vorschau für Aktions- und Partnercode |
| `client/src/pages/Checkout.tsx` | getrennte Eingaben und transparente Preiszeilen |
| `client/src/components/CartDrawer.tsx` | Warenkorbhinweis für beide Codearten |

## Regressionstests

```bash
# Backend
./node_modules/.bin/tsx --test \
  server/partnerProgramService.test.ts \
  server/discountBreakdownRules.test.ts \
  server/partnerCreditService.test.ts \
  server/kwkCheckoutPricing.test.ts

# Frontend
./node_modules/.bin/tsc --noEmit
pnpm build
```
