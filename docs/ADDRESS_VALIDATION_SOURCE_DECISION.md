# Deutsche Adressprüfung: Quellen- und Architekturentscheidung

## Ziel

Die WaWi und der Checkout prüfen deutsche Lieferadressen vor der Speicherung auf die Plausibilität von **PLZ, Ort, Straße und Hausnummer**. Eine negative Plausibilitätsprüfung blockiert nicht endgültig: Der Nutzer kann sie bewusst bestätigen. Diese Bestätigung wird revisionssicher zusammen mit einem unveränderbaren visuellen Nachweis gespeichert.

## Ausgewählte Datenquelle für den Live-Abgleich

Die Standardquelle ist die **OpenPLZ API**:

- `GET https://openplzapi.org/de/Localities?postalCode={PLZ}&name={ORT}` für die Kombination aus PLZ und Ort.
- `GET https://openplzapi.org/de/Streets?name={STRASSE}&postalCode={PLZ}&locality={ORT}` für die Kombination aus Straße, PLZ und Ort.

OpenPLZ stellt ein öffentliches Straßen- und Postleitzahlverzeichnis für Deutschland bereit. Die Dokumentation beschreibt explizit die Datenfelder Straße, Postleitzahl und Ort sowie die genannten Suchendpunkte. Der Datenquellenname und die Basis-URL werden beim Start als konfigurierbare Einstellungen in `shop_settings` angelegt. Dadurch können Quelle, Endpunkte, Zeitlimits und Prüfregeln ohne Frontend-Hardcoding ersetzt oder angepasst werden.

## Hausnummern-Prüfung

OpenPLZ veröffentlicht Straßen-, PLZ- und Ortsdaten, aber keinen belastbaren vollständigen Hausnummernbestand. Die Hausnummer wird daher in Stufe A wie folgt behandelt:

1. **Strukturelle Plausibilität:** Hausnummer muss einem zentral konfigurierbaren deutschen Format entsprechen, etwa `12`, `12a`, `12-14` oder `12/14`.
2. **Kontextprüfung:** Die Straße muss für genau die eingegebene PLZ und den eingegebenen Ort in der aktuellen Quelle existieren.
3. **Transparente Einordnung:** Ein negatives Ergebnis wird als *Plausibilitätswarnung* und nicht als absolute Behauptung ausgegeben. Ein manuell bestätigtes Abweichen wird vollständig protokolliert.

Der offizielle BKG-Geokodierungsdienst wurde als spätere, austauschbare Präzisionsquelle geprüft. Die Dokumentation bestätigt, dass der Dienst auf Amtlichen Hauskoordinaten Deutschlands (HK-DE) basiert und strukturierte Adresssuche inklusive Trefferqualität unterstützt. Der öffentliche Testzugang hat zum Prüfzeitpunkt jedoch mit `NOACCESS_SERVICE` geantwortet. Deshalb wird er **nicht** als unzuverlässige Laufzeitabhängigkeit eingebaut. Die Providerstruktur bleibt absichtlich austauschbar, sodass bei einem bereitgestellten BKG-Zugang ein Hausnummern-Abgleich mit amtlichen Hauskoordinaten ergänzt werden kann, ohne Checkout oder WaWi umzubauen.

## Datenschutz und Aufbewahrung

Die Prüfung erfolgt ausschließlich serverseitig. Der Nachweis speichert nicht die Antwortdaten des Drittanbieters als Wahrheit, sondern:

- die vom Nutzer eingegebene Adresse,
- Zeitpunkt und Quelle der Prüfung,
- die konkreten Plausibilitätswarnungen,
- die explizite Weiter-Bestätigung,
- einen kryptografischen Inhaltsnachweis und
- einen unveränderbaren SVG-Schnappschuss, der im Datensatz wie ein Foto geöffnet werden kann.

Damit sind die Daten dauerhaft nachvollziehbar, ohne sich auf die Speicherung fremder Geocoding-Ergebnisse zu stützen.

## Quellen

1. [OpenPLZ API – Germany: PLZ-, Orts- und Straßenendpunkte](https://www.openplzapi.org/en/germany/)
2. [OpenPLZ API – öffentliche Datenquelle und API-Übersicht](https://www.openplzapi.org/en/)
3. [BKG – Geokodierungsdienst für Adressen und Geonamen, Dokumentation 1.8](https://sg.geodatenzentrum.de/web_public/gdz/dokumentation/deu/geokodierungsdienst.pdf)
4. [EU-Datenkatalog – BKG-Geokodierungsdienst auf Basis amtlicher Hauskoordinaten](https://data.europa.eu/data/datasets/2c1452dd-76b2-4540-98dd-1ef37969e360?locale=en)

## Laufzeitprüfung der Quellen am 17.08.2026

- Der OpenPLZ-Endpunkt für `Localities` lieferte für `04105 / Leipzig` erfolgreich eine exakte Orts-PLZ-Kombination.
- Die dokumentierte OpenPLZ-Straßensuche lieferte im selben Lauf für dokumentierte Referenzanfragen keine Straßenantwort. Sie wird daher im Produktivcode **nicht** als harte Negativentscheidung verwendet. Ein nicht gefundener Straßenabgleich darf niemals behaupten, eine Adresse sei definitiv falsch.
- Der BKG-Geokodierungsdienst dokumentiert strukturierte Hausnummernsuche und Amtliche Hauskoordinaten, antwortete beim öffentlichen Lauf jedoch mit `NOACCESS_SERVICE`. Er bleibt als konfigurierbarer, später aktivierbarer Präzisionsprovider vorbereitet, aber nicht als aktive Abhängigkeit.

**Produktive Sicherheitsregel:** Bis ein verlässlich verfügbarer Hausnummernprovider konfiguriert ist, erhalten Kunden nur bei eindeutig ungültigen Formaten oder eindeutig ungültiger PLZ-Ort-Kombination eine rote Korrekturwarnung. Ein nicht verfügbarer Straßen-/Hausnummernabgleich wird als neutrale Prüfhinweis-Information dokumentiert, nicht als falsche Behauptung über die Adresse.
