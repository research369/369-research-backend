# WaWi-Dashboard: Performance- und Betriebsmodell

## Ziel

Das WaWi-Dashboard darf beim ersten Laden **keine vollständigen Bestell-, Artikel- oder Bestandsbewegungshistorien** mehr an den Browser übertragen. Der Shop-Checkout, Packen, DHL, Kunden- und Bestellverwaltung bleiben davon getrennt.

## Datenvertrag

| Browseransicht | Endpoint | Datenform | Auslösung |
|---|---|---|---|
| Umsatz & Bestellungen | `dashboard.overview` | SQL-Aggregate für Zeitraum, Status, Zahlarten, Lager-KPIs und Produktfilterwerte | sofort beim Öffnen / Filterwechsel |
| Produktanalyse | `dashboard.products` | gruppierte Produktumsätze im gewählten Zeitraum | erst beim Öffnen des Tabs |
| Bestandsübersicht | `dashboard.inventoryList` | aktive Artikel ohne Bewegungs- oder Bestellhistorie | erst beim Öffnen des Tabs |
| Warenabgänge | `dashboard.stockMovements` | maximal 500 jüngste Bewegungen im gewählten Zeitraum | erst beim Öffnen des Tabs |
| Bestellexport | bestehendes `order.list` | vollständige operative Liste | ausschließlich nach bewusstem CSV-Klick |

Alle Dashboard-Endpunkte sind `adminProcedure` und read-only. Sie schreiben keine Bestellungen, Bestände, Kunden-, Zahlungs- oder Versanddaten.

## Finanzielle Regeln

* Zeitraum-Umsatz umfasst nur Bestellungen mit `total > 0` und ohne Status `storniert`.
* Bezahlter Gesamtumsatz umfasst `bezahlt`, `gepackt`, `versendet` und `zugestellt`.
* Geschenk- oder Ersatzaufträge mit `0,00 €` bleiben als operative Historie erhalten, erhöhen aber die Dashboard-Umsatzkennzahlen nicht.
* Der Wertebereich bleibt identisch zu den bestehenden kommerziellen Kennzahlen; die Berechnung erfolgt jetzt in PostgreSQL statt im Browser.

## Datenbankabsicherung

Additive Indizes werden idempotent angelegt:

* `order_items_order_id_idx` – Join von Dashboard-Produkten und Bestellungen
* `stock_history_created_at_idx` – zeitliche Bewegungslisten
* `stock_history_article_created_at_idx` – Artikel- und Bewegungsanalysen

Die Indexroutine nutzt `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, `lock_timeout = 3s` und `statement_timeout = 90s`. Wenn eine Datenbanksperre den Lauf verhindern würde, wird der Optimierungsschritt übersprungen; Checkout, Packen, Bestand und Versand bleiben verfügbar.

## Fehlerverhalten im Browser

* Temporäre sichere GET-Abfragen erhalten begrenzte Wiederholungen mit Backoff.
* Ein vorübergehender Fehler beim Dashboard führt zu einer **lokalen Wiederherstellungsanzeige** und einer Schaltfläche „Erneut versuchen“, nicht zu einem Reload der gesamten WaWi.
* Das Dashboard lädt schwere Tabellen nicht versteckt im Hintergrund. Ein Fehler eines Detailtabs blockiert weder das Umsatz-Dashboard noch andere WaWi-Bereiche.

## Release-Prüfungen

Vor einem Release mindestens:

```bash
# Backend
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsx --test server/dashboardRouter.test.ts

# Frontend
pnpm exec tsc --noEmit
pnpm exec vitest run client/src/lib/apiRetry.test.ts client/src/pages/WaWiDashboard.test.ts
pnpm build
```

Danach in Produktion prüfen:

1. Railway-Status für den Backend-Commit ist erfolgreich und `/health/ready` antwortet HTTP 200.
2. Netlify-Deploy des Frontend-Commits ist `ready`.
3. Nach WaWi-Login lädt `/wawi` die Übersicht; Produktanalyse, Bestand und Warenabgänge werden jeweils erst nach Tabwechsel abgerufen.
4. Produkt-, Bestands- und Bestellexport bleiben funktionsfähig.

## Nicht im Dashboard ändern

* Keine Checkout-, Zahlungs-, CRM-, DHL- oder Packlogik in `dashboardRouter.ts` einbauen.
* Keine vollständigen Label-PDFs, Packfotos oder Kundendossiers in Dashboard-Payloads ausliefern.
* Keine Datenbankmigration mit ungebundenem Lock oder einer Tabellenumschreibung im normalen Betriebsfenster ausführen.
