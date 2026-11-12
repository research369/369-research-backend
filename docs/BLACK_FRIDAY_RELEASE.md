# Wiederverwendbare Black-Friday-Aktion – 12.11.2026

## Freigegebene Aktion

Dauerhaft auswählbare Vorlage `black-friday-36-9`, getrennt von der laufenden Shopkonfiguration. Vorgabe: 36,9 % Warenrabatt, kostenloser Basisversand ab 150 € Warenwert vor Rabatt, 15 € Kühlgebühr pro Sendung unabhängig von DE/EU/CH. Werte, Name, Start und Ende sind in der WaWi editierbar. Die Vorlage aktiviert nichts von selbst. Standardzeitraum im Entwurf: 13.11.2026 00:00 bis exklusiv 14.11.2026 00:00, Europe/Berlin.

Aktive exklusive Aktion: kein anderer Aktions-/persönlicher-/Partner-/Creator-Code, kein KWK-Rabatt, keine Guthabeneinlösung, keine zusätzliche Provision/Referral-Belohnung. Login und vorhandene Guthaben bleiben erhalten. Bei Ende oder Abschalten greifen normale Regeln wieder. Keine bestehenden Aufträge werden neu berechnet.

Pro bezahltem, katalogbestätigtem Vial eine Gratis-BAC-3-ml-Beigabe während der Aktion, auch unter der regulären 50-€-Schwelle. Keine zusätzliche Beigabe zu Kosmetik, Nasalspray/DIY, fertiger Plug-&-Play-Patrone oder anderen Gratispositionen. Gratispositionen werden serverseitig autorisiert: beliebige Browserflags gewähren keinen kostenlosen Artikel. Bestehende Mehrkaufregeln bleiben außerhalb der exklusiven Aktion unterstützt, innerhalb gibt es keine zusätzliche Mehrkaufbeigabe.

Freiversand erlässt ausschließlich den Basisversand, niemals die Kühlgebühr. Kühlgebühr genau einmal pro Sendung; der separate Produktaufpreis für Aufbereitung bleibt davon getrennt. Authentifizierte manuelle Abholung bleibt versandkostenfrei. Öffentliche Requests können Abholung oder freien Basisversand nicht durch Kennungsmanipulation erlangen.

## Wichtige offene Anforderung: alle Inseln

Die vollständige weltweite Inseladressprüfung ist **nicht fertig und nicht aktiviert**. Der getestete Offline-Geodatenansatz würde auch bekannte Festlandziele in Deutschland, Österreich, Frankreich und der Schweiz ablehnen. Diese umfassende Postleitzahlrichtlinie wird ausdrücklich nicht als globale Checkout-Sperre veröffentlicht.

Produktiv vorgesehen ist nur die verlässliche Teilregel für vollständig auf Inseln liegende Staaten/Gebiete, mit `policyMode: island-territories-only`. Andere Ziele erhalten keine Behauptung einer bewiesenen Festlandlage; `status: unknown` erhält hier die bisherige Verfügbarkeit. Das ist **kein vollständiger Ausschluss aller Inseln**: Inseladressen innerhalb z. B. Deutschlands, Spaniens, Frankreichs, Italiens oder Griechenlands sind durch diese Teilregel nicht vollständig abgedeckt.

Die umfassende Richtlinie und ihre Geodaten verbleiben im isolierten Arbeitsbaum und werden nicht in diesen Produktionsrelease aufgenommen. Nächster nötiger Schritt: genaue serverseitig verifizierte Lieferpunkte beziehungsweise ausreichend vollständige Adress-/Gebietsflächen und belastbare Gewässerdaten. Keine heimliche Verringerung der Sicherheitsabstände, keine automatische Aktivierung eines externen Geocoders und keine Blockade bestehender Festlandabwicklung zur Kaschierung der Datenlücke.

## Abnahme

Getrennte reine Preis-/Aktions-/Autorisierungstests, reale isolierte PostgreSQL-Prüfung des tatsächlichen `order.create`-Handlers über dessen Nur-Lese-Vorschau, gemockter UI-Klicktest der Vorlagenauswahl und getrennten Aktivierungsbestätigung. Keine Produktions-Testbestellung, keine Nachricht und kein DHL-Label. Vor Release: vollständige Typchecks, enge Versand-/Schweiz-/DHL-Regressionen, Build und Diffprüfung. Nach Release: exakter Railway-Commit samt Bereitschaft, Byte-Abgleich ausgelieferter WaWi-/Checkout-Bundles und rein lesende Verfügbarkeitsabfragen. Der externe Prüfbericht hält tatsächliche Deploystände und verbleibende Grenzen fest.
