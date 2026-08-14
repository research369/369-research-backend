# Incident Log

## 2026-08-14 – Bundle-Katalog nicht verfügbar

**Auswirkung:** Die öffentliche Bundle-Seite zeigte „Bundles konnten nicht geladen werden“.

**Ursache:** Der Bundle-Endpoint ging davon aus, dass jede Variantenstruktur ein Feld `label` enthält. Ein Produktdatensatz nutzte stattdessen `name`; der Zugriff auf `label.replace(...)` führte zu einer Ausnahme und brach den gesamten Katalog ab.

**Behebung:** Der Variantenresolver akzeptiert nun `label`, `dosage` oder `name` und verwendet bei unvollständigen Varianten den Bestand des Hauptartikels. Der Endpoint bleibt dadurch auch bei abweichenden Altformaten verfügbar.

**Prävention:** Der Browser speichert den letzten gültigen Katalog als transparenter Fallback. Zusätzlich löst ein echter Endpoint-Fehler eine konfigurierte Alarm-E-Mail aus. Der Empfänger ist zentral über `shop_settings.bundle_monitor_alert_recipient` verwaltet; keine Empfängeradresse ist im Backend-Code fest hinterlegt.

**Verifikation:** Der öffentliche tRPC-Endpunkt `bundle.getAll` lieferte nach dem Fix HTTP 200 mit Bundle-Daten.

## 2026-08-14 – Unbrauchbare tägliche Dublettenprüfung

**Auswirkung:** Die Kundenansicht wurde durch eine sehr lange Liste aus täglichen Gesamtscan-Treffern verdrängt. Die Hinweise zeigten überwiegend nur technische IDs und waren ohne Namen, Kontakt- und Adressdaten nicht prüfbar.

**Ursache:** Die erste Umsetzung prüfte täglich den vollständigen Kundenbestand und stellte alle offenen Treffer unlimitiert oberhalb der Kundenliste dar.

**Behebung:** Der tägliche Gesamtscan wurde entfernt. Neue Hinweise werden ausschließlich nach Anlage eines Kunden oder bei einer Änderung von E-Mail, Telefonnummer oder Lieferadresse erzeugt. Die vorherige offene Warteschlange wird revisionssicher als Altbestand archiviert, nicht gelöscht. Die aktive Oberfläche ist auf zwölf neue Hinweise begrenzt und zeigt beide betroffenen Kunden bzw. Bestellungen mit konkreten Identitätsdaten.

**Prävention:** Es gibt keine automatische Zusammenführung, Löschung, Stornierung oder Bestandsänderung. Die manuelle Vollprüfung verbleibt ausschließlich als geschützter Diagnoseablauf und ist nicht Teil des täglichen WaWi-Workflows.
