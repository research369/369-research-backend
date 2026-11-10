# 369 – serververbindlicher Checkout-Abgleich

Stand: 10.11.2026. Branch `feature/server-checkout-parity-2026-11-10`. Implementierung ausschließlich im isolierten Integrationsbranch; kein Merge nach main, kein Deploy, keine Produktionsbestellung oder Produktionsdatenbankänderung.

## Ergebnis und Freigabegrenze

Der reguläre 369-Kundencheckout verwendet jetzt eine gemeinsame serverseitige Preisberechnung für `order.quote` und `order.create`. Eine Quote allein ist keine Bestellung. Der Server bestimmt Artikelidentität, konkrete Variante, zulässiges Format, Preis, Angebote, Rabatte, Versand und Gratisbeigaben. Browserpreise und manuelle Rabattzeilen sind keine Preisautorität.

**Keine Launchfreigabe:** Die öffentliche Shop-Herkunft am gemeinsamen Legacy-Endpunkt ist weiterhin nicht serververifizierbar. Eine vom Browser gewählte `storeKey`-Angabe ist kein Herkunftsnachweis. Der separate Peps4pets-Vertrag wurde bewusst nicht umgeschrieben oder gesperrt. Außerdem ist die vollständige Positionsparität für vorhandene Nasal-/DIY-Kit-Komponenten noch vor Veröffentlichung abzunehmen. Die Implementierung darf deshalb nicht als vollständig freigegebener Ersatz der bestehenden Produktion ausgerollt werden.

## Aufrufvertrag

1. `order.quote` erhält den ursprünglichen Checkoutpayload. Legacy-Pflichtfelder bleiben vorhanden, sind aber keine Preisautorität. Die Route ist eine tRPC-Mutation für den Transport, wird intern jedoch in einem READ-ONLY-Datenbankkontext ausgeführt. Sie erzeugt weder Bestellung noch Bestellnummer, Stockbewegung, Guthabenbuchung, Receipt, Mail oder Paymenttask.
2. Die Antwort enthält `quote.version`, `quote.hash`, kanonische `quote.items`, `subtotal`, `discount`, strukturierten `discountBreakdown`, `shipping`, `shippingCountry`, `total` sowie die bestehenden Partner-/KWK-Werte.
3. `order.create` erhält denselben ursprünglichen Payload, den bestätigten `expectedQuoteHash` und einen stabilen 64-stelligen Hex-`checkoutIdempotencyKey`. Rabattierte Quote-Komponenten dürfen nicht als neuer Ursprungswarenkorb zurückgeschickt werden.
4. Reguläre 369-Aufträge ohne gültigen Intentkey scheitern vor Datenbankreads mit `CHECKOUT_INTENT_KEY_REQUIRED` bzw. `CHECKOUT_INTENT_KEY_INVALID`. Fehlende oder geänderte Quote scheitert mit `CHECKOUT_QUOTE_REQUIRED` bzw. `CHECKOUT_QUOTE_CHANGED`.
5. Ein bereits gespeichertes Receipt wird vor erneuter Preisprüfung wiedergegeben. Andere Ware, Lieferadresse, Codes oder monetäre Absicht unter demselben Key führen zum Konflikt. Kurzfristige Bestätigungsproofs, Tokenrefresh, Datum und neuer Quotehash dürfen keine zweite Bestellung erzeugen.

## Geschäftsregeln

- Aktive, öffentlich sichtbare Produktfamilie und exakt belegte Lager-SKU/Variante; eine versteckte Lager-Untervariante ist nur über ihre aktive öffentliche Familie und tatsächliche Zuordnung zulässig. Keine erfundenen SKU-, Lager- oder Preisfallbacks.
- Ein Sale der 5-mg-Variante darf nicht den Preis einer gewählten 10-mg-Variante ersetzen. Preisauflösung erfolgt innerhalb der konkreten Variantenidentität.
- Plug&Play-Aufpreis bleibt **15 EUR**. Eine Änderung auf hypothetische 10 EUR wurde nicht beauftragt. DIY-Aufpreis bleibt **7 EUR** gemäß vorhandener zentraler Konfiguration.
- Mengenstaffel: 4 / 8 / 13 / 20 / 36 rabattfähige Produkte → 10 / 20 / 25 / 30 / 35 Prozent. BAC und Zubehör sind ausgeschlossen; der kanonische 369 PEN zählt mit.
- Echte aktive WaWi-Bundles werden anhand `bundleId`, stabiler `bundleGroup` und exakter Definition geprüft. Ein bereits rabattiertes Angebot zählt je gekaufter Kopie als eine Staffeleinheit, erhält aber keinen zweiten Mengenrabatt. Ein freier Textmarker `Bundle:` autorisiert kein Angebot.
- Reihenfolge: kanonischer Varianten-/Formatpreis, echtes Bundleangebot, Mengenrabatt, bestehende Global-Stackpolicy, gültiger Aktionscode auf dem tatsächlich verbleibenden berechtigten Warenwert, bestehende Partner-/KWK-Regeln und authentifizierte Guthaben.
- Codebeschränkungen matchen die kanonische Familie oder die exakte SKU/Variantenidentität; kein umgekehrtes Präfixmatching, das eine einzelne Variante auf die ganze Familie erweitert.
- Genau eine Gratis-BAC-3-ml-Beigabe je berechtigtem Peptid-Vial, unabhängig vom Preis. Keine solche Beigabe für Plug&Play, PEN, DIY, Nasal, Tabletten/Kapseln, Kosmetik oder sonstiges Zubehör. Gekauftes und kostenloses BAC derselben SKU werden für den Lagerbedarf zusammengeführt.
- Vorhandene 2-für-3-Aktion wird aus bestehenden Einstellungen abgeleitet; Browser-Geschenkbehauptungen erzeugen keine Gratisartikel. Abgelaufene/inaktive Aktionen erzeugen keine Geschenke.
- Nur regulärer 369-Weg: Standardversand DE 8 EUR, EU 15 EUR, CH 18 EUR; bestehende Mindestwert-/Gratisversand-/Stackregeln bleiben erhalten. Versand wird nicht durch Browserbetrag oder Browserregion autorisiert. Guthaben finanziert nur Warenwert, nicht Versand.

## Transaktionssicherungen

Quote und Create prüfen zulässiges Format und aggregierten Lagerbedarf. Create sperrt ausgewählte Katalog-/Angebots-/Aktionszeilen und prüft den bestätigten Snapshot erneut innerhalb der Transaktion, bevor Bestellnummer und bestätigte Kundendaten geschrieben werden. Order, Positionen, Lagerbewegung, Receipt und bestehende Guthabenledger werden gemeinsam verarbeitet; Fehler vor Commit müssen zurückrollen. Postcommit-Aufgaben bleiben dauerhaft nachvollziehbar; ein Mail-/Taskfehler darf keine zweite Bestellung auslösen.

Die vorhandene Receiptberechtigung ist die bestehende starke Key-/Fingerprintlogik; es wird hier keine neue allgemeine Kundenloginpflicht oder zusätzliche serverprincipalgebundene Receipt-Autorisierung behauptet. Sperren ausgewählter bestehender Zeilen beweisen nicht sämtliche möglichen Phantom-Inserts, neue Varianten-/Bundledefinitionen oder Partner-/KWK-Policyraces.

## Geprüfte und noch offene Grenzen

Ausführbare Abnahme umfasst den echten tRPC-/Zod-/Preis-/Create-Handler an einer hermetischen SQL-Treibergrenze und zusätzlich wegwerfbare PostgreSQL-Datenbanken ohne Produktivnetz. Darin werden unter anderem konkrete SKU-Stockbewegung, doppelte Requests, Rollback, Kundenbestätigung, Partner-/KWK-Guthaben, Konkurrenz und Storno-/Ledgerverhalten geprüft. Testzusammenfassungen und finaler Commitbezug stehen im übergeordneten Abschlussbericht.

Vor Livefreigabe erforderlich:

1. Einen abgestimmten, serververifizierbaren Shopvertrag schaffen. Kein Origin-/Refererheader als scheinbarer Sicherheitsnachweis und keine ungefragte Veränderung des Peps4pets-Shops.
2. Vorhandene Nasal-/DIY-Kit- und BAC-10-ml-Zusatzpositionen vollständig zwischen Quote, Create, Receipt, Warenkorb und Fulfillment abgleichen. Bestand wird bereits geprüft; vollständige Positionsdarstellung ist damit noch nicht bewiesen.
3. Staging-Service mit ausschließlich isolierter Datenbank, Test-Mail-/Payment-Zielen und passender Frontend-API-Konfiguration bereitstellen; echte HTTP-/Browser-/Auth-End-to-End-Abnahme durchführen.
4. Bestehende aktuelle WaWi-/Partner-/KWK-Verträge, Kampagnen, Shipping und Mailzustellung in diesem Stagingdienst abnehmen; anschließend separat Merge-/Deployfreigabe einholen.

Keine Produktivprovider, echte Zahlung, Versandlabel, Produktionsmail oder produktive Guthabenbuchung wurden in diesem Arbeitsschritt ausgeführt.
