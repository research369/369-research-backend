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

Nicht in diesem Schritt: produktiver Execute-Adapter, Kundennummern-Migration in gemeinsamen Erzeugungswegen oder Aktivierung neuer Kunden-/Herkunftsspalten. Diese Änderungen brauchen ihren eigenen koordinierbaren Migrationsnachweis und Regressionstest. Solange sie fehlen, bleibt produktives Execute gesperrt. Phase 2/automatische Codes sind ausgeschlossen.

CI: eigener PostgreSQL-17-Dienst mit ausschließlich künstlichen Daten, Node 24, keine Secrets oder Deployment-Schritte.
