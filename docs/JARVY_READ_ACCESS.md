# Jarvy: persönlicher WaWi-Lesezugang

Stand 05.10.2026: implementiert und lokal geprüft, **nicht produktiv aktiviert**.
Eigentümerauftrag: Jarvy soll aus der selbst entwickelten 369 Research WaWi
Bestellungen, Einkaufswerte, Kunden- und Bestelldetails beantworten können.

## Schnittstelle

POST `/api/jarvy-read/query`, Bearer `JARVY_READ_KEY` (separater zufälliger Schlüssel,
mindestens 40 Zeichen). Ohne konfigurierten Schlüssel gesperrt. Der Schlüssel ist
kein WaWi-Login und wird von bestehenden Admin-/Schreibwegen nicht akzeptiert.
Feste Operationen: orders, order (order_id), customers (Suchbegriff), customer
(numerische ID), sales_summary (from/until), purchases, purchase (numerische ID).
Keine Mutation, SQL-/URL-Eingabe oder pauschaler Datenexport. Maximal 30 Zeilen
pro Seite, Detailpositionen maximal 200, Kennzeichnung von Kürzungen.
Datenabfragen in PostgreSQL READ ONLY/REPEATABLE READ, fünf Sekunden Zeitlimit,
60 Anfragen/Minute. Keine Kundeninhalte oder Schlüssel im Anwendungslog.

Bestellwerte werden in EUR ausgegeben. Nicht stornierte positive Bestellwerte
enthalten offene Bestellungen. Die separate Summe nach Bezahlstatus ist kein
Nachweis tatsächlicher Bankeingänge oder von Erstattungen bereinigter Umsatz.
Kunden werden nur über customer_id zugeordnet. Lieferanteneinkäufe bleiben in
USD; gespeicherte EUR-Stückkosten und Wechselkurse sind separate Felder.
Datumfilter: order_date, inklusive from, exklusive until, lokale Berliner Tage.

## Aktivierung und Prüfung

1. Backend-PR prüfen, Tests/Typecheck, aktuellen Produktionscommit abgleichen.
2. Eigenen Schlüssel geschützt bereitstellen: Railway JARVY_READ_KEY und
   Control `/srv/control/secrets/jarvy-wawi/config.json` mit key,
   organization_id, principal_id. Kein Benutzerpasswort verwenden.
3. Backend und Jarvy-Connector gemeinsam über die jeweiligen geprüften
   Releasewege freigeben. Vorhandene Railway-Änderungen nicht mitveröffentlichen.
4. Ohne Schlüssel 401; DELETE 405; unbekannte Operation 400 prüfen.
5. Autorisierte Kunden-/Bestellabfrage und vollständige SQL-Summe mit WaWi
   vergleichen. Keine Testbestellung, Nachricht oder Kundenänderung erzeugen.
6. Jarvy-Sprachabfrage persönlich abnehmen; Google-Kontenstandard BEDO bleibt.

Widerruf: JARVY_READ_KEY entfernen/rotieren oder Jarvy-Datei entfernen.
Kein Schemaeingriff; alter Backendstand sperrt den neuen Endpoint durch 404.
Jarvy darf bei fehlendem Zugang keine erfundenen Ergebnisse liefern.

## Nachweise

Sechs Tests: Auth, Parametergrenzen, SQL-Parameterbindung, Aggregationsumfang,
exakte Kundenzuordnung, HTTP-Verweigerung. TypeScript-Prüfung bestanden.
Reale Kundenabfrage und Produktionsfreigabe noch offen.

## Customer order extension — 2026-10-08, prepared, not deployed

The owner requested customer orders in the WaWi. Supplier purchases belong in
email/WhatsApp, not this endpoint. `/api/jarvy-orders` uses a separate
`JARVY_WRITE_KEY` (minimum 40 characters, must differ from the read key) and an
existing admin selected by `JARVY_WAWI_ACTOR_ID`, or by the existing
`ADMIN_USERNAME` when no ID is configured. Revoking the admin role blocks writes.

`POST /preview` accepts an existing customer ID, exact inventory SKUs/quantities,
payment method, optional internal note and explicit confirmation-email flag.
The actual order pipeline validates and prices the draft without allocating an
order number or changing stock. Customer profile changes, substitution, stock
bypass, partner/credit terms and ambiguous variants are excluded. Incomplete or
Packstation addresses must first be corrected through the WaWi. This is not a
supplier purchase endpoint and does not initiate payment.

`POST /execute` requires a UUID receipt, the original request and the exact
preview hash. BEDO Control supplies these only after personal approval of the
bound draft (click or voice). Actor, customer and article changes are checked
again. Receipt, order and stock commit atomically; an uncertain outcome cannot
be retried under the same ID. `/status` can inspect that receipt. The additive
receipt table from migration 0024 is initialized after authenticated admin access.
No write key means the entire endpoint remains disabled.

Validation: 16 focused tests, TypeScript check and a fresh isolated PostgreSQL
rehearsal of the real pipeline passed locally. Preview made no order/stock write;
one execution made one order and stock deduction; replay/concurrent execution,
price drift and actor revocation were checked. No external requests. The CI
workflow runs this rehearsal against a disposable PostgreSQL service.
Production activation and real customer acceptance remain open.

Products with implicit nasal-set components or Plug-and-Play fulfilment stay in
the native WaWi until every component/service can be included in the approved
Jarvy preview. The integration rehearsal rejects that path without an order.
