# Backend-Integration: lokale Quelle, kein Launch

**5. November 2026 · Integration `integration/checkout-prep-2026-11-05` · Feature `7e5e1bc` + main `2e707fd`**

Die separat in `97a4bd4` veröffentlichten Parent-Quality-Korrekturen wurden selektiv integriert, nicht als ältere Routerdateien über die neuen main-Dateien kopiert. Die historische `CHECKOUT_CONTRACT_RELEASE.md` und `CHECKOUT_CONTRACT_LOCAL_BASELINE` dokumentieren ausdrücklich den **vorherigen Feature-Stand**, nicht diese Integration. Der reine Evidence-Checker bleibt unverbunden: `connected=false`, `releaseApproved=false`.

## Tatsächlich erhaltene aktuelle main-Verträge

`customerDataChange.previewCheckoutChange` bleibt registriert; `order.create` akzeptiert den Kundenänderungstoken und konsumiert ihn unter Kundensperre innerhalb der Auftragstransaktion. Matching, Sperren, TTL und Einmalverbrauch wurden nicht ersetzt. Preview kann einen Token persistieren und darf ohne isolierte Abnahme nicht aufgerufen werden.

`getReleasedBankTransferInstructions()` bleibt gemeinsame Wise-Quelle der Auftragsantwort und Bestellmail. Keine fest eingebauten Bankkonten wurden restauriert. Fehlende/uneindeutige Konfiguration ist weiterhin fail-closed. Die erneute Abfrage **nach Persistenz** bleibt ein E2E-Blocker, weil ein Fehler dort einen bereits angelegten Auftrag als fehlgeschlagen erscheinen lassen könnte.

Main-Admin-/WaWi-, Partnerauth-/Programm-, Jarvy-, Kundenblock-/Identitäts-, Varianten-/Lagerregeln, aktuelle KPI-/Kontaktregeln und manuelle Versandfreigabe bleiben vorhanden. Die zentrale Kommunikationstemplate-Datei und Partnerrouter sind bytegleich zu main. Produktpreis-Aufpreise bleiben 15 € Plug&Play und 7 € DIY-Nasal; dies ist kein Kühlversandpreis.

## 369 versus P4P und WaWi

Der neue Server-Scope benutzt `storeKey` und authentifizierten manuellen WaWi-Kontext. Ein `sourceShop`-Feld existiert hier nicht. Der Store-Marker wird weiter durch `withStoreSourceMarker` persistiert; P4P-Marker und Kundenreferenz bleiben unverändert. Neue 369-Regeln werden **nicht** global auf gemeinsame Helpers gelegt.

- Öffentlicher 369-/staging-V2-Checkout: kein Kühlversand, DE/EN-Bestellmail nennt Versand innerhalb 48 Stunden Mo–Fr nach Zahlungseingang, Wochenenden/Feiertage ausgeschlossen; dies ist keine Lieferzeitgarantie.
- P4P und authentifizierte manuelle WaWi: bestehender main-Kühlversand/Gratisversand, Zahlungsarten, Mailtemplate-/Profil-/Referenzpfad unverändert. P4P akzeptiert wie zuvor keinen `quantity_discount`-Quellentyp.
- Das breite Zahlungsarten-Enum bleibt unverändert. Wise-only betrifft die neue 369-Kundenpräsentation, nicht Admin/P4P oder die gesamte öffentliche API.
- V2 bleibt hinter `CHECKOUT_V2_COMMERCE_STAGING=true` **und** `FEATURE_CHECKOUT_V2_ENABLED=true`. Der Legacy-Eingang akzeptiert keine von außen gesetzte V2-Quelle. Keine V2-Umschaltung vorgenommen.

## Mengenrabatt: harter Release-Blocker und sichere Input-Kompatibilität

Das Legacy-Schema akzeptiert jetzt `discountBreakdown[].source="quantity_discount"` für 369. Das bedeutet **nicht**, dass ein vom Client gelieferter Rabattbetrag vertrauenswürdig ist. Dieser Quellentyp wird niemals aus dem Browser-Breakdown in den kanonischen Audit-Breakdown übernommen.

Ein 369-Shop-/V2-Request mit diesem Rabatt wird zusätzlich durch `assertLegacyQuantityPricingReady` **vor `getDb()`** verweigert: `LEGACY_QUANTITY_PRICING_NOT_APPROVED`. Dies ist ein bewusster fail-closed Release-Guard, nicht ein grüner Checkout. Er gilt unabhängig von Rabattbetrag oder Umgebungsflag; ein Flag kann fehlende Preisparität nicht autorisieren. P4P und der authentisierte manuelle WaWi-Preisprozess bleiben außerhalb dieses Guards; P4P hat bereits die Schemaablehnung.

`calculateCheckoutV2QuantityDiscount` implementiert die Staffel 4/8/13/20/36 → 10/20/25/30/35 %. Seine Grundrechnung ist wiederverwendbar, aber **keine vollständig kanonische Legacy-Preisparität**: Legacy hat Katalog/Sale → global → Promo → Partner/KWK/Guthaben; FE verlangt Menge → global → Promo → Partner; V2 kennt Menge → Promo/Partner/KWK und andere Guthaben-/Code-/Beigabenregeln. Bundle-Identitäten, Sale-Varianten, globale Mindest-/Stackingbasis, KWK, Guthaben und Rundung müssen gemeinsam entschieden und negativ getestet werden. Deshalb keine unautorisierte komplette Legacy-Neuberechnung oder Übernahme des Browserbetrags. Auch ein Checkout ohne Mengen-Breakdown ist kein Nachweis vollständiger kommerzieller Parität.

## Gratis-BAC: kanonische neue 369-Grundregel, E2E weiter offen

Für 369 werden Katalogpreise zuerst über den bestehenden main-Repricinghelper ermittelt. Danach berechtigt ein kategoriensicherer, tatsächlich im Katalog gefundener Peptid-Vial unabhängig vom Preis zur Gratis-BAC-Position. Fehlende Referenz/Kategorien, Kosmetik, Zubehör, Nasal, Patronen und andere Nicht-Vialformen berechtigen nicht. Kostenpflichtige BAC-Positionen bleiben erhalten. Die neue Gratisposition wird auch auf Bestand geprüft und gebucht. Nicht-Vialbundle- und konkrete Bestandidentitätsfälle bleiben gesonderte Abnahme.

P4P und bisherige zweiparametrige Helper-Aufrufe behalten die alte 50-€-Einzelvialregel und Bundleausnahme sowie bisherige Ausführungsreihenfolge. Ein `variant: Bundle:*` ist keine neue pauschale Kosmetik-/Zubehörfreigabe.

## Weitere Release-Blocker

1. **Verbindliche Preise E2E**: Menge/global/promo/Partner/KWK, Gutscheine, Guthaben, Bundlepreis-/Variantenauswahl, Gratis-BAC, EU/CH, Rundung und Manipulation.
2. **Legacy-Doppelauftragsschutz**: Neuer 369-Frontend-Legacy-Checkout hat weiterhin keinen nachgewiesenen stabilen Abschluss-Schlüssel. V2/P4P-Idempotenz ist kein Ersatz.
3. **Bestätigungsevidenz**: Alle Checkboxwerte, angezeigten Texte, Versionen und Zeitpunkt sind für Legacy nicht dauerhaft nachgewiesen. Keine rechtliche Freigabe.
4. **Wise-Konfiguration und After-commit-Fehler**: freigegebenes Konto, persistierter Auftrag, Zahlungsreferenz, Mailzustellung/-fehler, Zahlungseingang, Status und Versand gemeinsam isoliert abnehmen.
5. **V2 Quote/Complete**: Legacy rekonstruiert Preise erneut; kanonische Summen können abweichen. Mengenrequests sind absichtlich blockiert. Keine Releasebehauptung.
6. **Root `railway.json`** enthält weiterhin Feature-Commerce-Staging-predeploy. Für Produktionsrelease muss der freigegebene Deploy-Dateisatz getrennt beschlossen werden; Script nicht ausgeführt.
7. **DB-Tests** bleiben ohne explizite Isolationsfreigabe übersprungen. Lokale Loopback-HTTP-Tests im netzisolierten Namespace sind keine externe API-/Produktionsabnahme.

## Typ-/Testdisziplin

Keine neue `any`-Umgehung, Procedure-Casts, deaktivierte Deklarationen oder Compiler-/Paket-/Lockdateianpassungen. Öffentliche Express-`Router`-Annotationen auch für sechs neuere main-Exporte, inferenzerhaltende öffentliche tRPC-Typen mit den aktuellen Audit-/Maintenance-/Goodie-/Stock-Middlewares. Echte Deklarationsemission und Compile-time-Assertions prüfen Inputs/Outputs, Nicht-null-Nutzer, Transformer und ErrorShape. Neue echte Schema-Tests parsen Eingaben, rufen **keinen** Auftrags-/Preview-Handler auf.

Zwei von main übernommene Mailtests erwarteten ältere Kartenfallbacktexte, die in `2e707fd` nicht mehr existieren. Die Assertions wurden zur aktuellen Wise-main-Copy abgeglichen; die veraltete Copy wurde ausdrücklich nicht restauriert. Neue Feature-Versandtests prüfen 369-Output und WaWi-Gegenprobe, statt pauschal jede Kühlcopy im Shared-Sourcecode zu verbieten.

Finale Zahlen, Logs, Quellschutz und Merge-Commit stehen im externen Bericht `/home/ubuntu/369_BACKEND_INTEGRATION_RESULT_2026-11-05.md`.
