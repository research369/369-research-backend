# Follow-up-Queue: operative Regel

## Auslöser

Ein Follow-up entsteht ausschließlich für eine Bestellung mit Status **`versendet`**.

## Zeitfenster

- Versand liegt mindestens **7 Tage** zurück: Das Follow-up ist fällig.
- Versand liegt höchstens **10 Tage** zurück: Die Bestellung darf neu in die Queue.
- Versand liegt länger als 10 Tage zurück: Es wird **kein rückwirkender Follow-up-Fall** angelegt.

Damit bleiben alte historische Bestellungen nach einem Queue-Reset dauerhaft außerhalb der Follow-up-Ansicht. Der manuelle Button **„Neue prüfen“** arbeitet idempotent: Eine Bestellung kann höchstens einen Follow-up-Datensatz erhalten.

## Bedienung

Ein offener Fall kann im Detail direkt über **„Überspringen“** aus der aktiven Queue entfernt werden. Er bleibt nur im Reiter *Übersprungen* nachvollziehbar und wird nicht erneut automatisch erstellt.

## Angebotscode

Ein Rabattcode wird erst beim expliziten Kundenkontakt erstellt. Bereits erzeugte, aber nicht genutzte Codes werden bei einem administrativen Queue-Reset deaktiviert, damit kein alter Follow-up-Vorteil weiter eingelöst werden kann.
