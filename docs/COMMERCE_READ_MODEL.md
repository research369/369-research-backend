# Commerce Read Model – Veröffentlichungs- und Freigabevertrag

## Zweck

Der öffentliche 369-Shop, SEO-Artefakte, strukturierte Daten und Commerce-Feeds dürfen keine eigene operative Produktwahrheit besitzen. Die Railway-WaWi bleibt führend für Artikel, SKU, Preis, Bestand, Varianten, Aufträge und Fulfillment.

Dieses Modul ergänzt eine **rein lesende Veröffentlichungssteuerung**. Es ersetzt weder `shop_visible` noch den Checkout und verändert keine Bestand-/Auftragsdaten.

## Datenfluss

```text
WaWi-Artikel / Varianten
  + SEO-/Übersetzungsdaten
  + article_channel_eligibility
  → article.shopCatalogManifest (read-only)
  → Storefront, SEO, Sitemap und Kanal-Feed
```

`article.shopProducts` bleibt unverändert und ist weiterhin kompatibel mit der bestehenden Shopoberfläche. `article.shopCatalogManifest` ist ein additiver Version-`1.0.0`-Vertrag für neue, kanalbewusste Ausgaben.

## Kanal-Freigabe

Jeder Eintrag in `article_channel_eligibility` bezieht sich auf genau eine konkrete `article_id` und einen Scope:

| Feld | Bedeutung |
|---|---|
| `channel` | Zielkanal, beispielsweise `merchant_google`, `web` oder `seo`. |
| `market` | Zielmarkt als ISO-3166-Alpha-2-Code, beispielsweise `DE`. |
| `locale` | Inhaltssprache entsprechend dem bestehenden Übersetzungsmodell, beispielsweise `de`. |
| `status` | `draft`, `review_required`, `approved`, `blocked` oder `archived`. |
| `blocked_reason` | Nachvollziehbarer Sperrgrund, insbesondere bei Plattform-/Channel-Entscheidungen. |
| `reviewed_by`, `reviewed_at` | Auditierbarer Freigabenachweis. |
| `valid_from`, `valid_until` | Optionaler Freigabezeitraum. |

### Fail-closed-Regel

Ein Merchant-Feed darf eine Variante nur enthalten, wenn für den **exakten** Scope aus Artikel, Kanal, Markt und Sprache ein Datensatz mit `status = approved` existiert und der Freigabezeitraum gültig ist. Es gibt keine implizite Freigabe durch `shop_visible`, keinen Produktnamen-Filter und keine fest im Code hinterlegte Ausschlussliste.

Fehlende, ungültige oder gesperrte Daten führen dazu, dass die Variante aus dem betroffenen Kanal ausbleibt. Sie ändern nicht die Sichtbarkeit im Shop.

## Manifest-Vertrag

`article.shopCatalogManifest({ locale, market, channel })` liefert:

- eine explizite `schemaVersion` und `generatedAt`-Zeitmarke,
- die eindeutige Artikel-/Produkt-/SKU-Identität,
- lokalisierte und deutsche Fallback-Inhalte,
- Preis und Verfügbarkeit aus der operativen WaWi-Quelle,
- SEO-Daten einschließlich Slug, Canonical-Information und Indexierungsstatus,
- den aufgelösten Kanalstatus samt Freigabezeitpunkt.

Der Endpunkt ist bewusst lesend. Insbesondere darf er keine Preise, Bestände, Freigaben oder Inhalte schreiben.

## Migrations- und Releasepflichten

1. Vor Deployment dieser Codebasis muss die Migration `0015_commerce_channel_eligibility.sql` in einer kontrollierten Umgebung geprüft und angewendet worden sein.
2. Die Migration ist rein additiv und legt **keine** automatische Merchant-Freigabe an.
3. Erst nach bestandener fachlicher Prüfung dürfen `approved`-Einträge angelegt werden.
4. Der Merchant-Build liest alle Feed-Kontexte aus `MERCHANT_FEED_CONTEXTS`; der deutsche Startkontext lautet `merchant_google` × `DE` × `de`.
5. Der Build darf ohne `RAILWAY_DB_URL`, `PUBLIC_SITE_URL` oder gültige Feed-Konfiguration nicht veröffentlichen. Er übernimmt niemals Feeds eines früheren Deployments.
6. Preis-, Rabatt-, Zugaben- und Versandautorität bleibt ein serverseitiger Checkout-P0. Ein Feed oder ein Manifest darf diese Regeln niemals ersetzen.

## Minimaler Freigabeablauf für den deutschen Startmarkt

1. Artikel-/Varianten- und Übersetzungsdaten in der WaWi vollständig prüfen.
2. Plattform-/Kanalentscheidung dokumentieren.
3. `article_channel_eligibility` nur für freigegebene Varianten in `merchant_google` / `DE` / `de` auf `approved` setzen.
4. Feed bauen und den erzeugten `feed-de.validation.json`-Report prüfen.
5. Produkte mit fehlendem Titel, Beschreibung, Bild, Kategorie, Produkttyp, Marke, Preis, SKU oder Identifier-Status bleiben ausgeschlossen.
6. Feed, sichtbare Produktseite, JSON-LD und Checkout auf Preis-/Verfügbarkeitskonsistenz prüfen.

## Nicht im Scope dieser Erweiterung

Diese Erweiterung führt keinen Merchant-Account-Launch aus, ändert keine Produkt- oder Rechts-/Plattformfreigabe, ändert keine Daten in der WaWi und erzeugt keine Bestellung. Sie liefert die technische Kontrollschicht, auf der diese Entscheidungen sicher abgebildet werden können.
