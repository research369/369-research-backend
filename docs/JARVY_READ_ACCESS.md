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
