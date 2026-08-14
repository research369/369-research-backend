# Incident Log

## 2026-08-14 – Bundle-Katalog nicht verfügbar

**Auswirkung:** Die öffentliche Bundle-Seite zeigte „Bundles konnten nicht geladen werden“.

**Ursache:** Der Bundle-Endpoint ging davon aus, dass jede Variantenstruktur ein Feld `label` enthält. Ein Produktdatensatz nutzte stattdessen `name`; der Zugriff auf `label.replace(...)` führte zu einer Ausnahme und brach den gesamten Katalog ab.

**Behebung:** Der Variantenresolver akzeptiert nun `label`, `dosage` oder `name` und verwendet bei unvollständigen Varianten den Bestand des Hauptartikels. Der Endpoint bleibt dadurch auch bei abweichenden Altformaten verfügbar.

**Prävention:** Der Browser speichert den letzten gültigen Katalog als transparenter Fallback. Zusätzlich löst ein echter Endpoint-Fehler eine konfigurierte Alarm-E-Mail aus. Der Empfänger ist zentral über `shop_settings.bundle_monitor_alert_recipient` verwaltet; keine Empfängeradresse ist im Backend-Code fest hinterlegt.

**Verifikation:** Der öffentliche tRPC-Endpunkt `bundle.getAll` lieferte nach dem Fix HTTP 200 mit Bundle-Daten.
