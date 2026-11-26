# Vollständige DHL-Empfänger und gezielte Bestellkorrektur – 26.11.2026

Pakko hat die bestätigte Lücke zwischen CRM-Kundenprofil, WaWi-Neuverkäufen und gespeicherter Bestelladresse zur Behebung freigegeben. Finn-Ole Kummers Auftrag 369-11384 ist betroffen: hinterlegte Packstation172, PLZ18528, Bergen auf Rügen, aber fehlende Auftrags-Postnummer und Lieferart `home`. Auftrag ist bezahlt, ohne Versandlabel. CRM-Kundennummer1247 ist nicht die DB-ID; der Auftrag verknüpft Kunden-ID44.

## Umfang und Schutz bestehender Abläufe

Neue manuelle Verkäufe übernehmen vollständige DHL-Abholortdaten aus dem eindeutig ausgewählten Kundenprofil. Neue DHL-Abholortbestellungen werden vor Schreibzugriffen auf konsistente Lieferart, persönliche Postnummer, positive Standortnummer sowie deutsche PLZ/Land geprüft. Gewöhnliche Hausadressen behalten ihren bestehenden Vertrag. Produkt-/Preis-/Rabatt-/Partner-/KWK-/Bestandslogik wird nicht ersetzt.

CRM-Speichern ändert weiterhin keine historischen Lieferadressen automatisch. Die irreführende Erfolgsmeldung wird korrigiert. Unversendete Bestellungen erhalten eine gezielte Administratorfunktion: aktuelle gespeicherte Kundendaten als vollständige Empfängeradresse ansehen, Vorher/Nachher vergleichen und ausdrücklich übernehmen. Vorschautoken sind kurzlebig, unterschrieben, an Administrator/Bestellung/aktuelle Datensatzstände gebunden und werden beim Speichern erneut geprüft. Versand-, Label-, Storno- und Konfliktzustände werden unter Transaktionssperre erneut geprüft. Länder-/Postleitgebietwechsel mit möglichen Auswirkungen auf Versandkosten oder Kühlzulässigkeit benötigen gesonderte Prüfung statt stiller Preis-/Versandänderung.

Ein separates unveränderliches `order_recipient_corrections`-Protokoll dokumentiert bestätigte Änderungen. Kontaktkanäle, Zahlungsstatus, Rechnungen, Produkte, Rabatte, Bestand, Provision, Guthaben und historische Finanzsnapshots werden nicht verändert. Vorhandene oder ungeklärte Labels sperren Empfängeränderungen; kein Label wird automatisch erzeugt oder storniert. Es werden keine E-Mails oder WhatsApp-Nachrichten ausgelöst. Neue API-Schreibrechte bleiben Administratoren vorbehalten; keine Erweiterung des Operations-/Produktmanagerzugangs.

## Finns einmalige autorisierte Reparatur

`repairFinnPickupOrder` läuft ausschließlich beim normalen Backend-Deploy, nicht beim CRM-Speichern und nicht in einer lesenden API. Es prüft Auftrag369-11384, Kundenzuordnung44, Empfängername und bisherige Packstationadresse. Die zugehörige aktuelle Kundendatenbank muss die persönliche DHL-Postnummer1116683275 und passende vollständige Abholortadresse enthalten. Ohne diese Belege wird nichts geraten oder geschrieben. Unter Auftragssperre werden ausschließlich `delivery_type=packstation` und die fehlende `dhl_post_number` ergänzt. Ein stabiler Audit-Schlüssel verhindert erneute Ausführung. Vorhandener Versand, Labelzustand oder abweichende Kundendaten führen zur vollständigen Rücknahme dieser Reparatur, nicht zum Ausfall des Shops.

## Speicherung, Release und Prüfung

Quellcode und Dokumentation werden in den vorhandenen privaten `research369`-Repositories gespeichert. Produktivbereitstellung erfolgt über bestehende GitHub-main/Railway- bzw. Netlify-Pipelines. Keine interne Manus-Produktivbereitstellung. Testdaten und synthetische UIprüfungen greifen weder auf echte Kundendaten noch auf produktive Bestellungen oder Versand-/Nachrichtenanbieter zu. Abschlussnachweis verlangt den tatsächlich ausgelieferten Release, korrigierte Liveauftragsfelder und einen Vergleich aller nicht adressbezogenen Auftrags-/Positionsdaten mit der vorab gesicherten Version.
