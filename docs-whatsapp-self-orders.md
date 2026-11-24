# WhatsApp-Selbstchat für Screenshot-Bestellungen

Vorbereitet, standardmäßig deaktiviert. Kein Produktionsversand und keine echte Bestellung im Test.

Nur die bestehende Botnummer 4915510063537 darf im eigenen Chat arbeiten. `fromMe`, verifizierte Socket-Identität und Ziel-PN/LID müssen zusammenpassen. Zusätzliche Nummern sind noch nicht implementiert/freigegeben. Historische Eigenchatnachrichten, normale Notizen und Bot-Antworten lösen keine Erfassung aus.

Ablauf: Screenshot oder `Bestellung <Text>` → unverbindliche Erkennung → `Kunde KENNUNG ID` → gegebenenfalls `Artikel KENNUNG POSITION SKU FORM` / `Ändern KENNUNG TEXT` → `Prüfen KENNUNG` → aktuelle WaWi-Vorschau → `Anlegen KENNUNG BESTÄTIGUNGSCODE`. Jede neue Vorschau erhält einen neuen Bestätigungscode. Nach unklarem Buchungsausgang nur `Status KENNUNG`, kein automatischer Neuversuch. `Verwerfen KENNUNG` sperrt die Vorschau. Ein vorhandener Kunde muss immer ausdrücklich ausgewählt werden. Bei abweichender Lieferadresse, neuem Kunden, manuellem Sonderrabatt oder ungeklärter Artikelauswahl bleibt der mobile Erfassungsweg zuständig; keine geratenen Stammdaten oder stillschweigende Adressübernahme.

Die Brücke verwendet die bestehenden screenshotOrder-Funktionen des neuen Bestelltools (23./24.11.2026), nicht den alten Bot-Bestellweg. Es wird keine automatische Kundenbestätigung verschickt; execute verwendet weiterhin den bestehenden sendOrderConfirmation:false-Pfad. Allgemeine Beratung, Telegram-Knöpfe und Kundenfreigaben werden nicht geändert.

## Aktivierungsvoraussetzungen (noch nicht ausgeführt)

Backend: eigenständiger mindestens 40 Zeichen langer WHATSAPP_SCREENSHOT_KEY, ausdrücklich zugeordnete bestehende Admin-ID WHATSAPP_SCREENSHOT_ACTOR_ID, WHATSAPP_SCREENSHOT_ENABLED=on. Der Schlüssel darf keinem bestehenden PepGPT-Lese-/Jarvy-Schlüssel gleichen. WHATSAPP_SCREENSHOT_EXECUTE bleibt für den ersten Live-Eigenchat-Test aus. Erst nach dessen Abnahme gesondert on.
Bot: WHATSAPP_SELF_ORDERS=on, WHATSAPP_SCREENSHOT_BASE=https://<bestehendes-backend>/api/whatsapp-screenshot und derselbe ausschließlich für diese Brücke bestimmte WHATSAPP_SCREENSHOT_KEY. Keine Schlüssel oder Admin-Cookies in Chat/Repo. Noch keine Variablen gesetzt, keine Secrets erzeugt/rotiert und kein Deployment ausgelöst.

Bereits vorhandene Nutzer-/Zugriffsrechte müssen vor einer Aktivierung geprüft und die Zuordnung bestätigt werden. Keine pauschale Admin-/Chatgruppenfreigabe. Für einen tatsächlichen Test muss die bestehende WhatsApp-Sitzung funktionieren; ein bestandener isolierter Test belegt keine aktuelle WhatsApp-Zustellung.

## Speicherung und Grenzen

`wa_self_order_v1` auf dem bestehenden persistenten Bot-Datenträger speichert Erkennungsvorschlag, ausgewählten Kunden, Angebotsfreigabe und Ergebnis. Originalbild wird nach Erkennung nicht gespeichert; nur Bildhash verhindert erneute Erfassung desselben Screenshots. Eigene gesendete Antworten werden vor dem Relay in bestehender Versandablage gespeichert, um Rückkopplung zu vermeiden. Bei Neustart wird eine laufende Buchung nicht automatisch wiederholt. Aufbewahrung und berechtigte Datenzugriffe folgen vor Aktivierung dem bestehenden internen Betrieb; keine externen Kundenprotokolle/Schlüssel in Logs.

Isoliert getestet: Selbstchat-Authentisierung, PN/LID, Sperre zusätzlicher Nummern, historische Nachrichten, doppelte Eingänge, alte Bestätigung nach neuer Vorschau, unsicherer Buchungsausgang, Adresskonflikt, Kundenwahl, HTTPS ohne Redirect, serverseitiger Actor und separate Execute-Sperre. Tests verwenden synthetische Daten und austauschbare Backend-/Transportadapter.

## Korrektur der projektweiten Prüfungen

Die fehlgeschlagenen Basisprüfungen waren nicht durch einen nachgewiesenen WhatsApp-/Meta-Ausfall verursacht. Der Kundendaten-Schutztest hatte eine veraltete Quelltextgrenze; die richtige manuelle Aktualisierungsfunktion war weiterhin vorhanden. Die WhatsApp-Integrationstests benötigen eine echte frische Unix-Socket-Testdatenbank und eine ausdrücklich auf diese Datenbank gebundene Helper-Verbindung. Die Jarvy-Probe hatte die inzwischen nötige priority_order_tasks-Tabelle nicht eingerichtet; mit dem produktionsgleichen Schema-Initializer besteht sie wieder.

Lokale Nachprüfung ohne Produktionszugriff: 580 Unit-Tests gefunden, 512 bestanden und 68 ausdrücklich an andere Fixture-/Opt-in-Läufe gebunden; 68 WhatsApp-Integrationstests bestanden; Jarvy-Echtpipeline in einer neuen Wegwerf-Datenbank einschließlich Parallel-/Replay-/Preisdifferenz-/Adminwiderrufstest bestanden, external_requests=0. Datenbankspezifische Dateien wurden nicht entfernt, sondern festen separaten CI-Jobs zugeordnet. Modul-Mock-Tests erhalten die notwendige Node-Option. Keine Änderung an produktiven Bestell-/Adress-/Zahlungsregeln, keine Migration oder Aktivierung auf Produktionssystemen.

Die zusätzlich explizit eingeplanten Datenbanktests deckten zwei weitere Fixture-Probleme auf: ein altes Konten-Testskript war fest auf einen nicht vorhandenen PostgreSQL-16-Pfad gebunden; es ermittelt die installierten Werkzeuge jetzt wie die anderen Runner. Die Operations-Simulation teilte Einstellungen mit Kampagnen-/Inseltests, und ihr als kühlpflichtiger Spray gedachtes Testprodukt war fälschlich als Zubehör angelegt. Die erwartete Adressprüfung wird nun ausdrücklich in der Fixture aktiviert, der Test-Spray korrekt kategorisiert; Kampagnen-/Inseltests laufen in einer eigenen Wegwerf-Datenbank. Keine produktiven Kategorie-, Versandpreis- oder Adressregeln geändert.
