# Sendcloud-Audit — 31. August 2026

## Verifizierte Befunde

Die vollständige Textsuche im aktuellen WaWi-Backend und -Frontend ergab keine ausführbaren Sendcloud-Integrationsmodule, keine Sendcloud-Umgebungsvariablen und keine aktiven Sendcloud-Aufrufe. Die einzige verbliebene Fundstelle ist ein historischer Hinweis in der Backend-README auf optionale, nicht verwendete Schlüsselnamen.

Die aktuelle Versandlogik liegt in den DHL-Modulen (`dhlExpressRouter.ts`, `dhlProfiles.ts`, `dhlService.ts`). Der historische Hinweis in der Bestellansicht für Auftrag `369-10176` ist daher als gespeicherte Alt-Notiz beziehungsweise Fehlerhistorie zu behandeln, nicht als Nachweis einer laufenden Sendcloud-Anbindung.

## Nächster Prüfschritt

Der Auftrag `369-10176` wird über die angemeldete WaWi ausschließlich lesend gesucht. Erst nach der genauen Identifikation der gespeicherten Notiz wird diese gezielt entfernt, ohne Bestell-, Zahlungs-, Rechnungs- oder DHL-Daten zu verändern.

## Durchgeführte Bereinigung und Verifikation

Der gespeicherte Inhalt der internen Notiz bestand ausschließlich aus sechs fehlgeschlagenen historischen Sendcloud-v2-Aufrufen vom 25. Mai 2026. Die Notiz wurde deshalb über die bestehende geschützte WaWi-Notizmutation auf einen leeren Wert gesetzt. Es wurden keine Status-, Zahlungs-, Rechnungs-, Tracking- oder Versandfelder geändert.

Die anschließende lesende Prüfung bestätigte den Status `versendet`, den Versanddienstleister `DHL` und ein weiterhin vorhandenes Versandlabel. Die interne Notiz ist leer. Damit ist die irreführende Sendcloud-Fehlerhistorie aus der Bestellansicht entfernt, während die reale DHL-Versandhistorie unverändert erhalten bleibt.
