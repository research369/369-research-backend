# Phase 1: isolierter Implementierungs- und Testumfang

Basis: API-Vertrag 1.2, 20.10.2026. Kein Deployment, keine Produktionsmigration, kein Kundenversand und keine echte Bestellung.

Betroffene Backenddateien:
- server/whatsappOrderContract.ts: strikte Version-1-Schemas, nur explicit_code/none, Cent-Beträge, signierte Katalogreferenzen.
- server/whatsappOrderService.ts: serverseitige Quote, bestätigte Kanalnachweise, separate Betreiberfreigabe, persistente Zustände, Ausführungssperre außerhalb der isolierten Testdatenbank.
- server/whatsappOrderRouter.ts: ausschließlich explizit konstruierter Router mit getrennten Schlüsseln; nicht in server/index.ts eingebunden.
- server/whatsappOrderPhase1.integration.ts: isolierte PostgreSQL-Integration, künstlicher Katalog und künstliche Aufträge; keine produktiven Zugangsdaten.
- server/whatsappPhase1Store.ts und server/whatsappPhase1Schema.sql: getrennte Quote-/Receipt-/Approval-/Testorder-Tabellen innerhalb der wegwerfbaren Testdatenbank; kein Eingriff in bestehende WaWi-Tabellen.

Betroffene Botdateien in eigener Arbeitskopie:
- phase1-orders.cjs und phase1-orders.test.cjs: persistente Telegram-Freigabe, unveränderte vier Entwurfsknöpfe plus separate Bestellfreigabe, Revisionen und Outbox. Transport- und Execute-Adapter im Test ausschließlich lokal.
- index.js: Phase-1-Promo-Policy und Schutz gegen den bisherigen direkten Bestellpfad; neue Bestellkomponente nicht ohne geprüften Produktionsadapter aktivieren.

Fortschreibung: Der native Buchungsadapter und die Kundennummern-Migration sind jetzt implementiert und ausschließlich isoliert geprüft. Deployment, produktive Migrationsausführung und Aktivierung bleiben ausgeschlossen. Phase 2/automatische Codes sind ausgeschlossen.

CI: eigener PostgreSQL-17-Dienst mit ausschließlich künstlichen Daten, Node 24, keine Secrets oder Deployment-Schritte.

## Native Buchung und Migration (Folgeauftrag)

Zusätzliche Dateien: `server/whatsappWawiAdapter.ts`, `server/customerNumberService.ts`, `server/whatsappContactIdentity.ts`, `server/whatsappWawiAdapter.integration.ts`, `drizzle/migrations/0030_whatsapp_phase1.sql`. Bestehende Erzeugungswege in customerRouter, orderRouter und legacyCustomerBackfill nutzen den gemeinsamen Sequenz-Helper; Drizzle bildet die additiven Herkunfts-/Lieferpräferenzspalten ab.

Der Adapter nutzt die nativen Tabellen orders, order_items, customers, articles, stock_history und promo_codes. Er verwendet bestehende Checkout-Preis-/Versand-/Rabattfunktionen und applyStockMovement. Der aufrufende Service speichert Freigaben, Receipt und Bestellintention in derselben PostgreSQL-Transaktion. Keine E-Mail-/DHL-/WhatsApp-Aufrufe im Adapter.

Auswahl: ausschließlich explizit serverseitig freigegebene normale Lager-SKUs und eindeutig aufgelöste Varianten. Keine automatische Freigabe von Bundles, Plug&Play, Nasensprays oder anderen Komponentenfällen. Der neue Router bleibt ungemountet und der aktuelle Store auf isolierte Testdatenbanken begrenzt. Die produktive Aktivierung ist damit weiterhin technisch nicht enthalten.

### Kontrollierter Migrationsablauf (noch nicht ausgeführt)

1. Geprüfte Sicherung und aktuelle Bestands-/Kundennummernprüfung durchführen. Alle Kunden-Erzeugungswege einschließlich Wartung/Backfills anhalten; keine Mischphase mit MAX+1-Writern.
2. `0030_whatsapp_phase1.sql` explizit ausführen. Sie setzt lock_timeout 5s, sperrt Kunden-Schreibzugriffe während der Initialisierung, prüft die Eindeutigkeit, initialisiert die Sequenz oberhalb Bestand und bisherigem Sequenzstand und ergänzt nur nullable Metadaten sowie getrennte Herkunftsnachweise. Vorhandene Kunden/Orders werden nicht umnummeriert oder umklassifiziert. Fehler brechen ab; keine automatische Dublettenbereinigung.
3. Alle aktualisierten Erzeugungswege gemeinsam starten. Ohne Migration scheitert der neue Helper ausdrücklich; es gibt keinen MAX+1-Fallback. Sequenzlücken durch Rollbacks sind gewollt.
4. Erst nach eigener Live-Freigabe und separater Prüfung von Kanaladaptern/Secrets den Bestellservice aktivieren. Dieser Folgeauftrag enthält keine solche Aktivierung.
5. Rücknahme: zuerst neue Erzeugungen stoppen. Sequenz, Nummern, Aufträge und Receipts bleiben erhalten. Kein Rollback auf konkurrierende MAX+1-Wege; der Sequenz-Helper muss beim Software-Rollback erhalten bleiben. Nullable additive Spalten und Herkunftsnachweise werden nicht gelöscht.

Isolierte Tests exportieren das aktuelle Drizzle-Schema in `whatsapp_phase1_test_native` auf lokalem PostgreSQL 17 (Port 55439), wenden nur dort die Migration an und erzeugen ausschließlich künstliche Kunden und Testaufträge. Verbindungsdaten enthalten keine Produktionsadresse oder Produktions-Secrets.

### Nachweise des Folgeauftrags

- Zwölf neue Integrationsfälle gegen das echte Drizzle-Schema: native Tabellen und Stock-History, zwei gleiche Execute-Aufrufe, Rollback nach absichtlich fehlgeschlagenem Herkunftsinsert, 32 parallele Nummernvergaben, wiederholbare Migration, Sequenzlücken nach Rollback, PG/Drizzle-Kompatibilität, normalisierte Kontakte und Konflikte, zwei parallele Erstkontakte, Packstation, SKU-Allowlist, Code-Limit, Preis-/Kundenzieländerung und Sale/Dauerrabatt/Code über mehrere Positionen.
- 162 vorhandene Tests unter der CI-Zeitzone UTC erfolgreich; elf bestehende, separat aktivierbare Integrationsfälle in diesem lokalen Lauf übersprungen. Der PR startet zusätzlich die vorhandenen Operations-/Jarvy-CI-Rehearsals.
- Acht unveränderte Bot-Tests erfolgreich. Zusätzlich lokaler End-to-End-Durchlauf von privater Telegram-Testfreigabe über native WaWi-Testtabellen bis zum separaten simulierten Senden; kein externer Transport.
- Betriebsgrenzen bleiben bestehen: nur isolierter Store, kein Router-Mount, kein Merge/Deploy, keine produktive Migration, keine echten Aufträge oder Kundennachrichten. Kein automatisches Profil-Update, kein automatischer Promo-Code und keine pauschale Sonderartikel-Freischaltung.
