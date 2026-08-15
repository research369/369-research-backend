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

## 2026-08-14 – Checkout-Fehler Mössmer P 105649 / 557,00 €

**Auswirkung:** Der Checkout für `oliver.wildner@outlook.com` wurde nicht als Bestellung angelegt. Der Kunde erhielt zunächst keine Bestellbestätigung. Der Fehlerdatensatz wurde jedoch vollständig in `failed_orders` gespeichert und per Admin-Alert gemeldet.

**Ursache:** Tesamorelin 10 mg hatte einen Bestand von 0. Die reguläre Bestandsprüfung blockierte den Checkout mit HTTP 500, weil für diese Variante keine Smart-Substitution verfügbar war.

**Behebung:** Nach ausdrücklicher Freigabe wurde die Bestellung als `369-10556` mit dem geschützten Master-Admin-Bestandsoverride angelegt. Der Fehlbestand bei Tesamorelin ist in der internen Bestellnotiz dokumentiert; die Bestellung bleibt offen. Verfügbarer Bestand wurde ausschließlich bei BPC-157 10 mg (-1), TB-500 10 mg (-2) und Ipamorelin 10 mg (-2) gebucht. Für Tesamorelin wurde kein Negativbestand erzeugt.

**Kommunikation:** Die Bestellbestätigung wurde an `oliver.wildner@outlook.com` über Resend angenommen und in `customer_communications` als `sent` mit einer providerseitigen E-Mail-ID archiviert. Absender: `noreply@coreversand.de`; Antwortadresse: `support@369research.eu`.

**Zusatzbefund:** Während der Wiederherstellung war der Railway-Backend-HTTPS-Endpunkt nicht erreichbar (TLS-Verbindungsfehler). Die Wiederherstellung wurde deshalb transaktional gegen die Produktionsdatenbank vorgenommen, mit Duplikatschutz, Bestandsjournal und CRM-Archivierung. Der Notfallablauf war auf diesen einzelnen gespeicherten Checkout-Backupdatensatz begrenzt.

## 2026-08-15 – Aktive Bestellungen in der WaWi nicht direkt sichtbar

**Auswirkung:** In der Bestellansicht erschien standardmäßig nur der Tab „Neu“. Bestellungen mit Status `bezahlt`, `gepackt` oder `zu_versenden` waren dadurch nicht in der ersten Ansicht sichtbar. Der Leerzustand „Keine neuen Bestellungen“ konnte fälschlich den Eindruck erzeugen, es gebe keine aktiven Bestellungen, obwohl diese im Bestand vorhanden waren.

**Ursache:** Der Standardtab filterte ausschließlich auf `offen`; eine sichtbare aktive Gesamtübersicht fehlte. Zudem wurde ein Fehler beim Datenabruf nur als flüchtige Meldung gezeigt und konnte wie ein echter Leerbestand wirken.

**Behebung:** Die WaWi startet nun mit einer sichtbaren Gesamtübersicht „Aktiv“, die alle nicht abgeschlossenen Bestellungen zeigt. Der bestehende Workflow bleibt über die Tabs Neu, Packen, Labels und Fertig erhalten. Ein fehlerhafter Datenabruf wird als klarer Hinweis mit Aktualisierungsbutton dargestellt; es wird kein irreführender Leerzustand angezeigt.
