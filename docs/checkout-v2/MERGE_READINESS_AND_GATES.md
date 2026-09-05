# Checkout V2 – Merge-Readiness und harte Gates

**Stand:** 5. September 2026
**Gesamtstatus:** Technisch vorbereiteter Entwurf. **Kein Merge, kein Deploy, keine reale Bestellung und kein Payment-Start zulässig.**

## Zweck

Dieser Stand ermöglicht einen kontrollierten Commerce-Staging-Test von Checkout V2, sobald ein vollständig separates Zielsystem existiert. Der neue Checkout darf weder die aktuelle Staging-Referenz noch den historischen Checkout, die produktive WaWi oder einen realen Zahlungsweg berühren.

> Lokale Vertragsprüfungen belegen nur Quellcodeverhalten. Sie ersetzen keine integrierte Prüfung mit separater Datenbank, getrenntem Backend-Service und Test-Payment-Adapter.

## Aktuell geprüfter Stand

| Prüfung | Ergebnis | Grenze |
|---|---|---|
| Backend-Quote und Abschluss | 31/31 lokale Vertrags- und Negativtests bestanden | Keine Datenbank, keine WaWi-Schreibaktion |
| Frontend-Transport | 4/4 lokale Antworttests bestanden | Simulierte Antworthüllen, kein HTTP-Aufruf |
| Backend-Typecheck | Keine Diagnosen in Checkout-V2- bzw. geänderten Kern-Dateien | Bekannte Alt-Diagnosen außerhalb des Umfangs bleiben getrennt |
| Frontend-Typecheck | Bestanden | Keine Commerce-Staging-URL gesetzt |
| Frontend-Produktionsbuild | Bestanden | Erzeugte SEO-Artefakte bleiben unversioniert |
| Backend-Contract-CI | Rein testend; kein Deploypfad | Keine externe Zielumgebung |
| Frontend-Contract-CI | Rein testend; kein Deploypfad | Commerce-Staging-URL bleibt leer |
| Commerce-Staging-Workflow | Manuell, branchgebunden und fail-closed | Noch nicht ausgelöst |

## Gesperrte Pull Requests

| Komponente | Pull Request | Branch | Regeln |
|---|---|---|---|
| Backend-Vertrag | [#12](https://github.com/research369/369-research-backend/pull/12) | `feat/checkout-v2-commerce-contract` | Draft; nicht mergen, nicht deployen |
| Frontend-Integration | [#13](https://github.com/research369/369-research-frontend/pull/13) | `feat/checkout-v2-commerce-ui` | Draft; nicht mergen, nicht deployen |

Die PRs dokumentieren ausschließlich isolierte Änderungen. Sie dürfen erst nach bestandener Commerce-Staging-Abnahme aus dem Draft-Status genommen werden.

## Vorbedingungen für Commerce-Staging

| Gate | Muss vor dem ersten manuellen Testdeploy erfüllt sein |
|---|---|
| Eigenes Backend-Ziel | Separater Service, der ausdrücklich nicht auf die produktive Backend-URL zeigt |
| Eigene Datenbank | Leere oder ausschließlich synthetische Testdaten; keine produktive WaWi-Kopie ohne dokumentierte Datenfreigabe |
| GitHub Environment | Werte ausschließlich unter `checkout-v2-commerce-staging`, nie als Repository- oder Produktionswerte |
| Staging-Freigaben | `CHECKOUT_V2_COMMERCE_STAGING=true`, `FEATURE_CHECKOUT_V2_ENABLED=true` und `CHECKOUT_V2_TEST_MODE=true` ausschließlich im Testziel |
| Ausgehende Systeme | Kein Bunq, kein realer Payment-Provider, keine operative E-Mail, kein Versandlabel, keine DHL-/Fulfillment-Integration |
| Frontend-Ziel | Eigene Staging-URL in `VITE_CHECKOUT_V2_API_BASE`; keine Produktionsfallback-URL |
| Manueller Start | Nur der vorhandene GitHub-Workflow mit bestätigtem Wert `COMMERCE_STAGING_ONLY` |

## Pflichtfälle in Commerce-Staging

Die folgenden Fälle müssen auf echter, aber isolierter Infrastruktur mit synthetischen Daten bestanden werden. Jeder Fall endet vor einer realen Zahlung.

| Gruppe | Mindestfälle |
|---|---|
| Warenkorb und Quote | Sichtbares Produkt, ausgeblendetes Produkt, falsche Variante, fehlender Bestand, parallele Mengen derselben Variante |
| Vorteile | Aktionscode, ungültiger Code, Partnercode, Partner-Eigenbestellung, KWK-Link, KWK-Guthaben, Partner-plus-KWK-Sperre, Selbstwerbung, bestehender Kunde |
| Automatik | 2-für-3 Include/Exclude, abgelaufene Aktion, Gratis-BAC, fehlende Gratis-BAC-Verfügbarkeit, gratis und bezahlt gleiche Variante |
| Lieferung | Privat, Firma/Institution, DHL Packstation, DHL Postfiliale, Nicht-DE-Abholadresse, Abholadresse bei Kühlversand |
| Abschluss | Quote-Neuberechnung, manipulierte Browserpreise, wiederverwendeter Abschluss-Schlüssel, paralleler Abschluss, Abbruch vor Test-Payment |
| Nebenwirkungen | Keine reale E-Mail, keine Versandlabel, keine echte Zahlungsanforderung, keine Produktionstabelle, keine produktive WaWi-Verbindung |
| Rückfall | `/checkout` bleibt ohne Änderung erreichbar; Deaktivierung von V2 sperrt V2 ohne Nebeneffekt |

## Reihenfolge nach bestandenem Commerce-Staging

Nach dokumentiert bestandenen Tests wird ein eigener Testadapter für den später von Pakko gewählten Payment-Anbieter angebunden. Erst wenn der adapterseitige Status, signierte Webhooks, Wiederholung und Abbruch in der isolierten Umgebung geprüft sind, darf eine separate Merge-/Liveentscheidung vorbereitet werden.

Ein späterer Produktivschritt benötigt immer eine neue, ausdrückliche Freigabe. Merchant, Produktfeeds und Such-/Tracking-Tags gehören nicht in diesen Checkout-Merge.

## Rückfall

Der historische Checkout unter `/checkout` bleibt der operative Rückfall. Checkout V2 bleibt bis zu einem separaten Live-Release ausschließlich unter `/checkout-v2` und ohne richtige Commerce-Staging-URL geschlossen. Der vorhandene Staging-Shop, Main, Preise, Lager, Codes, Partner, KWK, WaWi und Payment bleiben unverändert.
