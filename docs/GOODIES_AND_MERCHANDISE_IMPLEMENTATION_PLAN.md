# Goodies & Merchandise – Implementierungsplan

**Status:** Architektur- und Ablaufplan; interne Phase 1 ist am 27. September 2026 umgesetzt. Der präzise Ist-Stand, technische Vertrag und Abgrenzungen stehen in `GOODIES_IMPLEMENTATION_HANDOVER_2026-09-27.md`. Öffentlicher Merchandise-Verkauf und Kundenwahl im Warenkorb bleiben deaktiviert.  
**Erstellt:** 27. September 2026  
**Technische Grundlage:** Quellstand Backend `6b29d515a77d7ed41cb46c45b72c06aacc1221f2`, Frontend `64dafddadb5900e639dd18cd21fceef77b213d15`

---

## 1. Zielbild und verbindliche Entscheidung

369 Research erhält einen eigenen **Goodie-/Merchandise-Bereich in der bestehenden WaWi**.

> Ein Goodie ist **kein Rabatt, keine kostenlose Bestellposition und keine Freitextnotiz**. Es ist ein realer Lagerartikel, dessen Ausgabe beim Packen separat, dauerhaft und revisionssicher an die Bestellung und damit an den Kunden gebunden wird.

Damit sind zwei Dinge gleichzeitig möglich:

1. **Kostenlose Goodie-Ausgabe:** Beim Packen öffnet der Mitarbeiter eine nach Gruppen sortierte Goodie-Liste (z. B. `Textilien → Handtücher → Blau`, `Bekleidung → Damen → M`). Mit einem bewussten Bestätigen wird der konkrete Lagerartikel ausgegeben, Bestand gebucht und die Ausgabe an der Bestellung protokolliert.
2. **Regulär verkaufbares Merchandise:** Derselbe physische Artikel kann später als normaler Shopartikel verkauft werden. Shop-Verkauf und Goodie-Ausgabe greifen auf **dieselbe Lager-SKU und denselben Bestand** zu, ohne Doppelpflege oder Schattenbestand.
3. **Spätere Kundenwahl nach Bestellwert:** Der Shop kann nach aktivierter, konfigurierbarer Prämienregel im Warenkorb zeigen, welcher Betrag noch bis zur nächsten Goodie-Stufe fehlt. Bei erreichtem Anspruch wählt der Kunde selbst ein verfügbares Goodie aus der für seine Stufe freigegebenen Liste.

Die Erweiterung bleibt additiv und muss die vorhandenen Peptid-, Rabatt-, Zahlung-, DHL-, Rechnung-, Checkout-, Kunden- und Variantenabläufe unverändert lassen. Merchandise erhält einen eigenen Katalog-/Merchant- und Content-Pfad; es übernimmt ausdrücklich **nicht** die fachlich falschen Research-/RUO-Regeln.

---

## 2. Was der Ablauf später für die WaWi leisten soll

### 2.1 Anlegen eines Goodies / Merchandise-Artikels

1. In **WaWi → Goodies** startet der Nutzer `Neues Goodie anlegen`.
2. Die schlanke Eingabe enthält nur die realen Fakten, die KI nicht seriös erfinden darf:
   - Arbeitsname;
   - Goodie-Gruppe und -Untergruppe;
   - SKU(s), Farbe, Größe und/oder andere echte Varianten;
   - Zugang / Anfangsbestand pro SKU;
   - Einkaufspreis, Steuerklasse und optional Verkaufspreis;
   - bei Verkauf: tatsächliches Material, Pflegehinweis, Lieferumfang, Marke sowie GTIN/MPN-Entscheidung;
   - mindestens ein echtes Produktfoto oder explizit `Foto folgt`.
3. Die Anlage erzeugt die physischen Lager-SKUs sofort als **interne, aktive und nicht shop-sichtbare** Artikel. Sie können ab diesem Moment als Goodie ausgegeben werden.
4. Ein separater KI-Content-Generator erstellt im Merchandise-Profil Entwürfe für Shoptext, Kurztext, SEO, Merchant-Titel/-Beschreibung, Alt-Texte, FAQ-Entwürfe und Übersetzungen.
5. Die Vorschau prüft Datenqualität, Bild, Varianten, Bestand, SEO und Merchant-Felder. Nur für verkaufbares Merchandise erscheint danach `Shop freischalten`.
6. Erst die sichtbare Freigabe schaltet den Shopartikel und gegebenenfalls die Merchant-Teilnahme frei. Ein rein intern auszugebendes Goodie bleibt immer `shopVisible = 0`.

**Wichtig:** Material, Pflege, Größe, Lieferumfang, GTIN und Markeninhaberschaft werden nie von KI behauptet oder erfunden. Fehlende Produktfakten bleiben als Validierungsblocker sichtbar.

### 2.2 Goodie beim Packen zuordnen

1. Mitarbeiter öffnet eine bestehende Bestellung und startet den Packvorgang.
2. Neben den normalen Bestellpositionen erscheint der Abschnitt **„Goodies für diese Sendung“** mit bisher bereits erfassten Ausgaben.
3. `Goodie hinzufügen` öffnet den Goodie-Picker. Dieser ist durchsuchbar und gruppiert; er zeigt nur aktive, zur Ausgabe freigegebene reale Lager-SKUs inklusive Farbe, Größe, Foto, verfügbarem Bestand und Low-Stock-Warnung.
4. Mitarbeiter wählt ein oder mehrere Goodies und Menge; der Dialog zeigt klar: `kostenlos für den Kunden – wird nicht in Rechnung oder Warenkorb aufgenommen`.
5. Die Bestätigung erzeugt eine Goodie-Ausgabe. Dabei passieren in **einer Datenbanktransaktion**:
   - atomarer Bestandsabzug der realen SKU;
   - Bestandsjournal mit Typ `goodie_ausgabe`;
   - unveränderbarer Ausgabebeleg mit Bestellung, Kunde, Benutzer und Zeit;
   - Snapshot von Produktname, SKU, Variante und Goodie-Gruppe.
6. Nach erfolgreicher Speicherung erscheint das Goodie in der Bestellung und im Packabschnitt. Bei Doppelklick bzw. Netzwerkwiederholung darf derselbe Vorgang nur einmal gebucht werden.
7. Eine Korrektur ist nur als nachvollziehbare **Stornierung** möglich: eigener Stornobeleg, Gegenbuchung `goodie_storno`, kein Löschen und kein stilles Überschreiben.

### 2.3 Kundenhistorie beim nächsten Auftrag

- In Bestellung, Kundenakte und manueller Verkaufserfassung erscheint ein kompakter Bereich **„Bisher erhaltene Goodies“**.
- Er wird serverseitig über die kanonische Kunden-ID geladen, nicht über einen unsicheren Namensabgleich. Bei historischen Aufträgen ohne Kunden-ID greift nur ein definierter, dokumentierter Fallback über eine validierte E-Mail-Adresse.
- Angezeigt werden: Bild/Name, Variante, Anzahl, Ausgabedatum, zugehörige Bestellung und Status (`ausgegeben` / `storniert`).
- Dadurch erkennt der Packer vor dem Versand sofort, ob der Kunde z. B. bereits ein blaues Handtuch oder ein Damen-Shirt in M erhalten hat.

### 2.4 Spätere Kundenwahl im Warenkorb nach Bestellwert

Diese Funktion wird **im Datenmodell und Checkoutvertrag vorbereitet**, bleibt aber bis zu Deiner ausdrücklichen Aktivierung abgeschaltet. Sie ist keine Hintergrundautomatisierung: Jeder Stand wird synchron auf Basis des aktuellen Warenkorbs durch den Server berechnet.

1. Der Warenkorb ruft eine reine Vorschau ab. Sie verwendet ausschließlich die serverautoritative Preis-, Rabatt-, Produkt- und Regelauflösung.
2. Liegt der qualifizierende Warenwert unter der nächsten Stufe, sieht der Kunde z. B. `Noch 23,00 € bis zu Deinem Goodie` – Betrag und Wortlaut stammen aus der aktiven Regel, nicht aus Frontend-Code.
3. Erreicht der Warenkorb eine Stufe, zeigt der Checkout `Du kannst 1 Goodie wählen` und nur die für genau diese Stufe zulässigen, aktuell verfügbaren SKUs samt Farbe, Größe und Bild.
4. Die Auswahl bleibt bis zum erfolgreichen Bestellabschluss eine unverbindliche Warenkorbauswahl. Sie reserviert keinen Bestand, damit kein TTL-Job, keine Schattenreservierung und keine liegengebliebenen Sperren nötig werden.
5. Beim finalen Checkout berechnet der Server den Anspruch noch einmal, löst die konkrete SKU auf, sperrt den Bestand atomar und erzeugt den Goodie-Ausgabebeleg mit Quelle `customer_reward` im **gleichen Transaktionsrahmen** wie die Bestellung.
6. Hat ein anderer Kunde die letzte passende SKU inzwischen erhalten, wird der Kunde vor Abschluss zu einer weiterhin verfügbaren Alternative oder zu einer Bestellung ohne Goodie-Auswahl zurückgeführt. Das System zeigt nie eine nicht belastbare Geschenkzusage.
7. Der Packer sieht die Kundenwahl als bereits zugeordneten Goodie-Ausgabebeleg. Sie wird nicht als bezahlte Position, Rabatt oder Rechnungsartikel dargestellt.

Der Wert kann später je Programm steuerbar auf einen eindeutig definierten qualifizierenden Warenwert bezogen werden. Die initiale Regel bleibt bis zur fachlichen Freigabe deaktiviert; es gibt **keine** implizite Schwelle, keine automatische Produktauswahl und keinen festen Eurobetrag im Code.

---

## 3. Nicht verhandelbare Architekturprinzipien

| Prinzip | Konsequenz |
|---|---|
| **Eine Bestandsquelle** | `articles.stock` bleibt die einzige führende Bestandsquelle. Goodies erhalten keinen zweiten Bestand und keinen lokalen Browserbestand. |
| **Keine Vermischung von Geld und Geschenk** | Goodie-Ausgaben liegen nicht in `order_items`, verändern weder Warenwert, Rabatt, Zahlungszuordnung, Rechnung noch Versandkosten. |
| **Jede tatsächliche Variante ist eine Lager-SKU** | Handtuch Blau und Handtuch Pink, Shirt Damen M und Damen L sind getrennte reale Lagerartikel. Farbe/Größe wird nie in `dosage` oder einen frei interpretierbaren Namen gepresst. |
| **Katalogprofil statt Code-Ifs** | Die fachliche Klasse (Research, Merchandise, internes Goodie usw.) ist Konfigurations-/Datenmodell, nicht `if (category === ...)` im Frontend oder Feed. |
| **Keine Business-Hardcodings** | Pickersortierung, Gruppen, Freigaberegeln, Shopkategorien, Merchant-Profil, Ziele/Labels, Low-Stock-Schwellen und Content-Vorlagen liegen als konfigurierbare Daten vor. |
| **Fakten vor KI** | KI formuliert, übersetzt und strukturiert; reale Produktfakten, Fotoherkunft und Handelskennzeichnungen werden vor der Freischaltung validiert. |
| **Revisionssicherheit** | Ausgabe, Stornierung, Bestand und relevante Produktpublikation werden protokolliert. Historie wird nicht durch Überschreiben verlorengegeben. |
| **Additive Einführung** | Bestehende Peptid-Varianten, Smart Substitution, Cold Shipping, Bundles, Rabatt- und Checkoutregeln werden in Phase 1 nicht umgebaut. |

---

## 4. Abgrenzung: Was **nicht** gebaut wird

1. Keine automatisch aktive Goodie-Regel wie „ab 200 € immer Handtuch“ in der ersten internen Lieferung. Das Datenmodell für die spätere Kundenwahl wird vorbereitet, aber kein Programm wird ohne explizite Aktivierung freigeschaltet.
2. Kein automatischer Goodie-Eintrag in Kunden-E-Mail, Rechnung oder DHL-Label. Eine spätere Warenkorb-Auswahl ist ausschließlich nach aktiver Regel, sichtbarer Kundenwahl und finaler Serverprüfung möglich.
3. Kein nachträgliches Raten/Backfilling alter Goodie-Historien aus Notizen.
4. Kein automatisches Ersetzen von Goodies bei Fehlbestand, kein negativer Goodie-Bestand und kein stiller Bestandsoverride.
5. Keine Änderung der bestehenden Research-Produkttexte, Research-Merchant-Artikel oder Medical-/RUO-Compliance durch diese Erweiterung.
6. Keine neue externe Dauerautomatisierung, kein Scheduler und kein Webhook. Jeder relevante Vorgang ist eine explizite WaWi-Aktion; der Feed entsteht wie heute im Netlify-Build.

---

## 5. Datenmodell

### 5.1 Warum keine Goodie-Spalte in `order_items`

Die aktuelle Bestellposition ist zugleich Zahlungs-, Rabatt-, Rechnungs- und teilweise Bestandskontext. Würde ein Goodie als `price = 0` dort landen, könnten sich Warenwert, Rechnungslogik, Rabattberechnung, E-Mail- und Nachbearbeitungsfunktionen verändern. Eine Notiz wäre umgekehrt nicht strukturierbar, nicht inventarfähig und nicht revisionssicher.

Daher erhält die Goodie-Ausgabe eine eigene Fachdomäne mit referenziellem Bezug auf Bestellung, Kunde und reale Lager-SKU.

### 5.2 Neue Tabellen (Sollmodell)

Die konkrete Migration muss vor Ausführung gegen die Produktions-Metadaten und die aktuelle `schema_migrations`-Historie geprüft werden. Alle Foreign Keys sind mit `RESTRICT` zu setzen; **kein Cascade Delete** für Historien.

| Tabelle | Kernfelder | Zweck / Regeln |
|---|---|---|
| `catalog_profiles` | `id`, `key` (eindeutig), `display_name`, `content_template_key`, `merchant_profile_key`, `allow_shop_sale`, `allow_goodie_issue`, `active` | Datengetriebene fachliche Klasse. Der bestehende Research-Pfad bleibt zunächst kompatibel über Legacy-Auflösung; neue Merchandise-Artikel verwenden ein eigenes Profil. |
| `article_catalog_profile` | `article_id` (PK/FK), `catalog_profile_id`, `role` (`shop_parent`, `inventory_sku`, `standalone`), `created_at`, `updated_at` | Ordnet Artikel genau einem Profil und einer Rolle zu. Keine Bestandskopie. |
| `catalog_variant_definitions` | `id`, `parent_article_id`, `inventory_article_id`, `display_label`, `attributes JSONB`, `sort_order`, `active` | Generischer, profilneutraler Variantenvertrag für neue Merchandise-Familien. `attributes` enthält z. B. `{ "color": "Blau", "size": "M" }`. Die vorhandene Peptid-JSON-Variante wird nicht migriert oder beschädigt. |
| `goodie_groups` | `id`, `parent_id`, `key`, `display_name`, `sort_order`, `active`, `icon_key` | Konfigurierbarer Picker-Baum, z. B. Textilien → Handtücher. Kein Array/Label im Frontend. |
| `goodie_article_settings` | `article_id` (PK/FK), `goodie_group_id`, `issuable`, `low_stock_threshold`, `default_issue_limit`, `active` | Legt fest, welche reale SKU als Goodie ausgegeben werden darf; ist vom Shopstatus getrennt. |
| `goodie_reward_programs` | `id`, `key` (eindeutig), `display_name`, `status`, `priority`, `valid_from`, `valid_until`, `store_scope JSONB`, `country_scope JSONB`, `qualifying_amount_policy JSONB`, `progress_copy JSONB`, `active` | Vollständig datengetriebene Goodie-Prämienprogramme. Legt fest, welche Warenkorbwerte zählen, für welche Stores/Länder die Regel gilt und ob sie sichtbar/aktiv ist. Kein Eurobetrag oder Rabattverhalten im Client. |
| `goodie_reward_tiers` | `id`, `program_id`, `threshold_amount`, `selection_count`, `display_name`, `sort_order`, `active` | Staffelung, z. B. ab einem konfigurierten Warenwert ein Goodie, ab einer höheren Stufe mehrere oder höherwertige Optionen. Die Reihenfolge und Anspruchslogik bleiben datengetrieben. |
| `goodie_reward_tier_articles` | `tier_id`, `article_id`, `active`, `sort_order`, `variant_constraints JSONB` | Explizite Freigabeliste der realen Goodie-SKUs je Stufe. Das verhindert, dass jeder ausgabefähige Lagerartikel automatisch im Kundenpicker auftaucht. |
| `goodie_issues` | `id`, `order_id`, `customer_id`, `issue_status`, `source` (`manual` / `customer_reward`), `idempotency_key` (eindeutig), `reward_program_snapshot JSONB`, `issued_at`, `issued_by_user_id` (bei Kundenwahl `NULL`), `voided_at`, `voided_by_user_id`, `void_reason`, `created_at` | Kopfbeleg einer Goodie-Ausgabe. Status: `issued` oder `voided`; Ursprung, Regel- und Anspruchskontext bleiben immer erhalten. |
| `goodie_issue_items` | `id`, `goodie_issue_id`, `article_id`, `quantity`, `sku_snapshot`, `name_snapshot`, `variant_snapshot JSONB`, `group_snapshot`, `stock_history_id` | Unveränderbare Positionen und Beweis, was tatsächlich gegeben wurde – auch wenn Name/Gruppe später umbenannt werden. |
| `catalog_assets` (falls vorhandene Asset-Struktur nicht erweitert werden kann) | `id`, `article_id`, `purpose`, `source_type`, `original_url`, `rendition_url`, `width`, `height`, `content_hash`, `ai_generated`, `metadata_preserved`, `created_at` | Asset-Provenance: Original bleibt erhalten, Verwendungszweck (Hero, Gallery, Merchant etc.) ist explizit. Diese Tabelle nur einführen, wenn die existierenden Bildfelder die notwendigen Nachweise nicht sauber tragen können. |

#### Bestehende Tabellen: additive Erweiterungen

| Bestehende Tabelle | Erweiterung | Begründung |
|---|---|---|
| `article_merchant` | Profil-/Variantendaten: `merchant_profile_key`, `brand`, `gtin`, `mpn`, `identifier_exists`, `condition`, `item_group_id`, `color`, `size`, `material`, `gender`, `age_group`, `merchant_enabled`, `custom_labels JSONB` | Merchant-Felder sind je verkaufbarer SKU, nicht pauschal pro Feed. Nicht alle Felder gelten für jedes Profil. |
| `stock_history` | Erweiterung des Change-Type-Vertrags um `goodie_ausgabe` und `goodie_storno`; Referenz auf Goodie-Position, falls migrationssicher möglich | Jede Goodie-Bewegung ist mit Ausgabebeleg und Bestellung nachweisbar. |
| `articles` | **Keine neue Bestands- oder Geschenkspalte.** Nutzung der bestehenden führenden Artikel-, Preis-, Steuer-, Sichtbarkeits- und Bestandsfelder. | Verhindert Parallelmodelle. |
| `categories` / `category_translations` | Merchandise-/Zubehör-Kategorie als Datenrecord anlegen, nicht als neue String-Map im Client. | Shop-Navigation, SEO und Übersetzungen werden datengetrieben. |

### 5.3 Daten- und Löschregeln

- Die reale Artikel-ID und SKU einer ausgegebenen Goodie-Position sind nach Ausgabe nicht mehr umwidmbar.
- Artikel mit Goodie-Historie werden deaktiviert/archiviert, nie durch einen anderen Gegenstand ersetzt oder gelöscht.
- Ein Auftrag mit ausgegebenen Goodies darf durch die bisherigen Löschrouten nicht still gelöscht werden. Die UI und API müssen zuerst eine Stornierung der Goodie-Ausgabe verlangen oder den Auftrag als historische Referenz erhalten.
- `delete` und `deleteNoRestock` erhalten eine explizite Goodie-Schutzprüfung. Die bisherige Bestelllöschung darf nicht über neue Fremdschlüssel oder Bestandsbewegungen hinwegsehen.
- Goodie-Stornierung bucht nur die tatsächlich stornierte Menge zurück; sie ändert keine regulären Bestellpositionen und keine Rechnung.

### 5.4 Fachliche Zustände

| Artikelzustand | `isActive` | `shopVisible` | `issuable` | Wirkung |
|---|---:|---:|---:|---|
| Internes Goodie, verfügbar | 1 | 0 | 1 | Im Goodie-Picker und Lager aktiv; nicht im Shop. |
| Goodie, noch nicht auf Lager | 1 | 0 | 1 | Im Picker mit `nicht verfügbar`; keine Ausgabe ohne Bestand. |
| Verkaufbares Merchandise + Goodie | 1 | 1 | 1 | Ein gemeinsamer Bestand für Shopverkauf und kostenlose Ausgabe. |
| Nur verkaufbares Merchandise | 1 | 1 | 0 | Normaler Shopartikel, nie im Goodie-Picker. |
| Auslaufartikel mit Historie | 0 | 0 | 0 | Nicht auswählbar; historische Goodie-Ausgaben bleiben lesbar. |

### 5.5 Prämienanspruch und Auswahlzustand

Der Warenkorb ist kein dauerhafter Reservierungsdatensatz. Deshalb gibt es keine unbereinigten `pending`-Datensätze und keine Hintergrund-Cleanup-Aufgabe. Die Zustände sind bewusst getrennt:

| Zustand | Speicherort | Bedeutung |
|---|---|---|
| `not_eligible` / `progressing` | reine serverseitige Vorschauantwort | Der Warenwert erreicht noch keine Stufe; die Antwort enthält nur den Betrag bis zur nächsten aktiven Stufe. |
| `eligible_unselected` | reine serverseitige Vorschauantwort | Der Kunde darf wählen, hat aber noch keine SKU im Warenkorb gewählt. |
| `selected_in_cart` | Warenkorb im Browser | Unverbindliche Auswahl; kein Bestand ist reserviert oder abgebucht. |
| `issued` | `goodie_issues` + `goodie_issue_items` | Der Checkout war erfolgreich, die konkrete SKU ist atomar abgebucht und dauerhaft der Bestellung zugeordnet. |
| `voided` | derselbe Beleg + Gegenbuchung | Korrektur nach dem bestehenden Goodie-Stornoprozess. |

`qualifying_amount_policy` beschreibt explizit, ob z. B. nur Warenwerte, rabattierte Warenwerte, bestimmte Produktprofile oder nur bestimmte Länder/Stores zählen. Versandkosten, Steuern, Gutscheine, Sale-Artikel und nicht berechtigte Kategorien werden nie implizit interpretiert; ihre Behandlung wird je aktiviertem Programm in der Vorschau transparent erklärt und beim Checkout identisch berechnet.

---

## 6. Sicherer Buchungsablauf

### 6.1 Goodie-Ausgabe (Transaktion)

```text
WaWi-Goodie-Picker
  → adminProcedure goodie.issue(orderId, [articleId, quantity], idempotencyKey)
  → Bestellung + kanonische customerId laden und Status prüfen
  → Artikel-Profil + issuable + reale SKU + Bestand prüfen
  → atomarer Bestandsabzug pro SKU (nur bei ausreichend Bestand)
  → stock_history: goodie_ausgabe
  → goodie_issues + goodie_issue_items mit Snapshots
  → Commit
  → UI lädt Goodies der Bestellung und Kundenhistorie neu
```

**Pflichtdetails:**

- Der Request nimmt nie einen vom Browser behaupteten Preis, Produktnamen, Bestand oder Kundenbezug als Wahrheit an.
- Der Bestandsabzug erfolgt per DB-Sperre oder bedingtem `UPDATE … WHERE stock >= quantity RETURNING`, nicht mit „Bestand im Browser geprüft, danach speichern“.
- Der Idempotency Key wird pro Bestätigungsaktion erzeugt und serverseitig unique erzwungen.
- Goodie-Ausgabe ist nur für bearbeitbare Auftragsstatus konfigurierbar. Standard: `offen`, `bezahlt`, `gepackt`; `versendet`, `zugestellt`, `abgeholt`, `storniert` sind im Normalweg gesperrt.
- Keine Smart Substitution, keine Cold-Shipping-Pflicht, keine Rabattregel und kein Mindestwarenkorb greifen auf Goodies.

### 6.2 Storno (kompensierender Beleg)

```text
Nur autorisierter WaWi-Admin
  → goodie.void(issueId, reason)
  → Ausgabe mit Zeilensperre laden
  → nur bei Status issued fortfahren
  → Bestand rückbuchen + stock_history: goodie_storno
  → issue_status = voided, Audit / Begründung speichern
  → Commit
```

Das System löscht niemals den ursprünglichen Ausgabebeleg und macht eine fehlerhafte Ausgabe nicht „unsichtbar“.

### 6.3 Kundenwahl im Checkout (späterer, aktivierbarer Buchungsweg)

```text
Warenkorb  →  public goodieReward.preview(cart snapshot)
            →  serverautoritär: aktive Programme, qualifizierender Wert,
                nächste Stufe, verfügbare Auswahl-SKUs, unverbindliche Auswahl

Finaler Checkout  →  serverautoritär alles erneut berechnen
                   →  Bestellung und normale Artikelbestandprüfung
                   →  Anspruch, Auswahlanzahl, SKU-Profil, Variante und Bestand prüfen
                   →  Goodie-Bestand atomar abziehen
                   →  Bestellung + Goodie-Ausgabebeleg mit source=customer_reward schreiben
                   →  Commit oder vollständiger Rollback
```

**Verbindliche Schutzregeln:**

- Die Browser-Antwort `eligible` ist nie ausreichend für eine Ausgabe; nur der finale Serverabgleich entscheidet.
- Ein Kunden-Goodie hat den Preis `0` für die Kundenerfahrung, aber wird **nicht** als `price = 0` in `order_items` gespeichert und verändert keine finanzielle Summenformel.
- Die Goodie-Ausgabe wird weder an Merchant Center noch als regulärer kostenloser Shopartikel exportiert.
- Scheitert die Goodie-Validierung, darf keine Teilbuchung entstehen. Die normale Bestellung wird nur dann fortgesetzt, wenn der Kunde nach der klaren Rückmeldung eine gültige Alternative auswählt oder die Auswahl bewusst entfernt.
- Eine spätere Bestellstornierung folgt der bestehenden Bestandssemantik: Sie stellt nicht stillschweigend neue Goodie-Logik über die aktuelle Kernbestandslogik. Vor Packabschluss ist eine explizite Goodie-Stornierung mit Gegenbuchung erforderlich; bei einer bestehenden Bestelllöschung mit Rückbuchung muss die Goodie-Rückbuchung zwingend mitgeprüft werden.

---

## 7. Katalog-, KI- und Medienablauf

### 7.1 Eigenes Merchandise-Profil, kein Peptid-Prompt

Die aktuelle Beschreibungsgenerierung in `articleRouter.generateDescription` ist ausdrücklich auf Forschungspeptide, Wirkmechanismen, Risiken, Dosierungen und Research-Only ausgerichtet. Sie darf für Handtücher, Bekleidung oder Zubehör **nicht** wiederverwendet werden.

Stattdessen erhält der Katalog eine zentrale, versionierte Profildefinition. Beispiel für das künftige Profil `merchandise_physical`:

```json
{
  "contentTemplateKey": "merchandise_physical_v1",
  "requiredFacts": ["material", "deliveryScope", "variantAttributes"],
  "forbiddenClaims": ["medical", "therapeutic", "research_only", "dosage"],
  "generate": ["shopCopy", "shortCopy", "seo", "merchantCopy", "altTexts", "translations", "faqDraft"],
  "merchantProfileKey": "physical_retail_de_eu"
}
```

Dieses JSON ist **Konfigurationsinhalt**, nicht eine UI- oder Router-If-Abfrage. Der Generator liefert strukturiertes JSON gegen ein Zod-/JSON-Schema. Ungültige oder fehlende Angaben erzeugen einen Entwurf mit klaren Lücken statt Falschaussagen.

### 7.2 KI-Ausgabe

Für eine reale Ware mit belastbaren Fakten erstellt KI:

- Produktname und Kurzbeschreibung;
- ausführlichen, sachlichen Shoptext;
- Highlights, Pflegehinweis-Entwurf und Lieferumfangstext auf Basis der gelieferten Fakten;
- SEO-Titel, Meta Description, Slug und OpenGraph-Texte;
- Merchant-Titel/-Beschreibung;
- Alt-Texte je Bild;
- FAQ-Entwürfe ohne medizinische, Research- oder Heilversprechen;
- Übersetzungsentwürfe für die vorhandenen Shopsprachen.

Die Persistierung erfolgt erst nach Preview/Validierung. Wie bei der bestehenden Produktverwaltung werden Änderungen mit `product_audit_log` oder einer gleichwertigen, erweiterten Audit-Schnittstelle dokumentiert.

### 7.3 Bilder und Produktdarstellung

1. Originaldatei und Herkunft werden unverändert gesichert.
2. Es werden klar getrennte Verwendungen gepflegt: Produkt-Hero, Variantenbild, Galerie, Merchant-Hauptbild, OpenGraph.
3. Ein Merchant-Bild muss das echte Produkt zeigen; Platzhalter, Wasserzeichen, Angebots-Overlays und generische Bilder sind nicht zulässig.
4. Generierte Visuals werden eindeutig als KI-generiert geführt; vorhandene IPTC-/Provenance-Metadaten dürfen nicht beim Optimieren entfernt werden.
5. Vor Veröffentlichung prüft der Validator Auflösung, Format, erreichbare URL, Bildzuordnung und tatsächlichen Variantengehalt.

---

## 8. Shop, Varianten, Checkout und Bestandsvertrag

### 8.1 Varianten

Die aktuelle Peptidvarianten-Architektur verwendet `articles.variants` mit Dosierung. Das darf für Shirtgrößen oder Handtuchfarben nicht zweckentfremdet werden.

- **Peptide bleiben unverändert** auf dem bestehenden Variantenvertrag.
- **Neues Merchandise** nutzt `catalog_variant_definitions` als generischen Vertrag.
- Jede kaufbare Merchandise-Variante verweist auf eine reale `inventory_article_id` und trägt strukturierte Attribute (Farbe, Größe, Material usw.).
- Der Shop zeigt nur gültige Attribute und echten Verfügbarkeitsstatus der passenden SKU.
- Der Warenkorb überträgt eine serverauflösbare Variantenkennung, nicht nur einen frei formulierten Text.

### 8.2 Checkout erst in der zweiten Ausbaustufe

Die aktuelle Bestellanlage reduziert Bestand nur für `item.type === 'peptide'`. Daher darf Merchandise nicht einfach mit einem neuen Type-String in den heutigen Checkout eingehängt werden.

Vor dem ersten Merchandise-Verkauf ist ein generischer, serverautoritärer Inventory Resolver nötig:

1. Der Server löst `shopProductId + ausgewählte Variantenkennung` auf die konkrete `inventory_article_id` auf.
2. Der Server prüft Profil, Aktivität, Shopfreigabe, Preis und Bestand der aufgelösten SKU.
3. Der Bestandsabzug erfolgt für diese SKU im gleichen Sicherheitsniveau wie heute für Peptide.
4. Die Bestellposition wird als regulär bezahlte Ware mit echter SKU und Varianten-Snapshot gespeichert.
5. Peptid-spezifische Funktionen (Smart Substitution, DIY nasal, Plug&Play, Cold Chain) bleiben strikt auf das Research-Profil begrenzt.

**Folge für den Rollout:** Goodie-Ausgabe kann zuerst produktiv gehen. Shopverkauf von Merchandise wird erst freigeschaltet, wenn dieser generische Checkout- und Variantenvertrag getestet ist.

### 8.3 Navigation und Shopkategorie

- Standard-Start: Kategorie **„Merchandise“** als Datenrecord; alternativ kann der Admin die Shopzuordnung später auf `Zubehör` ändern.
- Kategorie, Sortierung, Übersetzungen, SEO und Slug werden aus der zentralen Kategoriekonfiguration geliefert.
- Es wird kein neuer Sonderbanner, keine feste Kategorie-String-Map und keine Frontend-Sonderroute eingebaut.
- Die bestehende dynamische Kategorieabfrage muss für die neue Kategorie funktionieren, inklusive Sprachroute, statischer SEO-Seite und Sitemap.

### 8.4 Warenkorb- und Checkout-Erlebnis für die spätere Prämienwahl

Der öffentliche Bereich wird erst mit dem generischen Merchandise-Checkout aktiviert und bleibt bis dahin per Programmstatus unsichtbar.

- **Noch nicht qualifiziert:** Eine kompakte Fortschrittskarte zeigt die nächste erreichbare Stufe und den vom Server gelieferten fehlenden Betrag, z. B. „Noch 23,00 € bis zu Deinem Goodie“. Sie verspricht keinen konkreten Artikel.
- **Qualifiziert:** Der Kunde öffnet einen Goodie-Picker mit nur den für seine erreichte Stufe freigegebenen, lagernden Varianten. Farbe/Größe werden wie bei Merchandise serverauflösbar gewählt.
- **Auswahl getroffen:** Die Karte zeigt Bild, Variantenlabel, Menge und `Gratis-Goodie zu dieser Bestellung`; Entfernen oder Wechseln ist bis zum Abschluss möglich.
- **Verfügbarkeit:** Die Oberfläche erklärt sachlich, dass die finale Verfügbarkeit beim Bestellabschluss geprüft wird. Sie blockiert den Abschluss nicht mit einem versteckten Automatismus.
- **Keine Preiswirkung:** Der Warenkorb, die Rabattaufstellung und die Checkout-Gesamtsumme unterscheiden sichtbar zwischen bezahlten Positionen und einem separat ausgewiesenen, nicht monetären Goodie-Anspruch.

---

## 9. Google Merchant Center und SEO/GEO

### 9.1 Aktueller Befund

`369-research-frontend/scripts/generate-feed.mjs` legt derzeit für **alle** shop-sichtbaren Artikel pauschal Research-spezifische Werte fest, u. a.:

- Research-Standardkategorie;
- `custom_label_0 = Research Use Only`;
- generiertes MPN sowie `identifier_exists = yes`;
- konstante Marke;
- `item_group_id = shop_product_id`.

Das wäre für Merchandise falsch und kann Produkte in Merchant Center fehlerhaft darstellen. Auch die statischen Produktseiten generieren derzeit Research-orientierte Schema-/Fallbackwerte.

### 9.2 Zielvertrag für Merchandise

Der Feed wird zu einer **profilbasierten Projektion**. Die bestehende Research-Ausgabe bleibt als bestehendes Profil erhalten; ein Merchandise-Profil wird getrennt validiert und ausgegeben.

| Feld | Merchandise-Regel |
|---|---|
| ID | Stabil und je verkaufbarer SKU eindeutig. |
| Titel/Beschreibung | Genaue, variantenspezifische Shopdaten ohne Werbeversprechen, RUO- oder medizinische Inhalte. |
| Link / Bild | Öffentliche kaufbare Varianten-URL und echtes, crawlbares Varianten-/Produktbild. Beide stimmen mit Landingpage und Checkout überein. |
| Preis / Verfügbarkeit | Ausschließlich aus derselben aufgelösten SKU und `articles.stock` wie Shop/Checkout. |
| Marke | Tatsächlich zugelassene Marke; zentral im Merchant-Profil bzw. Artikel gepflegt. |
| GTIN / MPN | GTIN ausschließlich, wenn vom Hersteller/Markeninhaber wirklich vergeben und validiert. Nie erzeugen oder raten. Gibt es keinen GTIN, greift der explizit validierte MPN-/Identifier-Exists-Pfad. |
| Varianten | Jede Farbe/Größe ist ein eigenes Feed-Item. Gemeinsame Familie mit stabilem `item_group_id`; `color`, `size`, `material`, `gender`, `age_group` nur soweit real zutreffend. |
| Google Product Category / Product Type | Produkt- und profilbezogen gepflegt, nicht aus der Research-Defaultkonstante abgeleitet. |
| RUO / Custom Labels | Für Merchandise nicht vorhanden, außer ein explizit konfiguriertes, zulässiges Label. |

Die Merchant-Validierung blockiert die Merchant-Freigabe eines Merchandise-Artikels bei fehlendem Bild, fehlendem Preis, fehlender Verfügbarkeitssynchronität, unklarer Kennzeichnung oder unvollständigen Variantenfeldern. Shopfreigabe und Merchant-Freigabe bleiben getrennte Schalter.

### 9.3 SEO-/GEO-Generierung

Der Produktseiten-, Sitemap- und Feed-Build erhält einen gemeinsamen Profilresolver. Dieser liefert pro Profil die korrekten Schema.org-Typen, Breadcrumb-Kategorie, Marken-, SKU- und Offer-Daten. Er darf keine Peptid-/CAS-/RUO-Fallbacks auf Merchandise anwenden.

---

## 10. API- und Berechtigungskonzept

### 10.1 Neue bzw. erweiterte tRPC-Verträge

| Bereich | Endpunkte (Soll) | Berechtigung |
|---|---|---|
| Goodie-Picker | `goodie.listAvailable`, `goodie.groups`, `goodie.forOrder` | WaWi-Admin |
| Ausgabe / Korrektur | `goodie.issue`, `goodie.void` | WaWi-Admin; Storno ggf. separate Berechtigung |
| Kundenkontext | `goodie.historyForCustomer`, `goodie.historyForOrder` | WaWi-Admin |
| Goodie-Katalog | `goodie.createDraft`, `goodie.updateSettings`, `goodie.setGroup`, `goodie.lowStock` | Produktmanager/Admin für Katalog; Ausgabe bleibt ausgeschlossen |
| Prämienprogramme | `goodieReward.listPrograms`, `goodieReward.saveProgram`, `goodieReward.saveTier`, `goodieReward.setTierArticles`, `goodieReward.activateProgram` | Admin; jede Aktivierung auditierbar und von Katalogpflege getrennt |
| Content/Produktfreigabe | Profilfähige Erweiterung der bestehenden Product-Admin-API: `generateProfileContent`, `validateProduct`, `setShopVisible`, `setMerchantEnabled` | Produktmanager/Admin |
| Shop/Checkout (Stufe 2) | Profilfähige Produkt- und Variantenauflösung, `goodieReward.preview`, nicht öffentlich schreibbare Bestandsroute | Öffentliche Lesepfade, serverautoritärer Checkout |

### 10.2 Strikte Grenzen

- `product_manager` darf Goodie-/Merchandise-Katalogdaten, Texte und Bilder pflegen, aber **keine** Goodies für reale Kunden ausgeben, stornieren, Bestellungen ändern, Zahlungen berühren oder Migrationen anstoßen.
- Goodie-Ausgabe ist `adminProcedure` und liest den Kunden aus der bestehenden Bestellung serverseitig.
- Öffentliche Shop-Requests erhalten nie Goodie-Ausgabe-Endpunkte, Bestands-Overrides oder interne Kundenhistorie.
- Es gibt keine browserseitig vertraute Preissetzung, Identifier-Setzung oder Bestandsschreibung.
- Die öffentliche Prämienvorschau ist read-only, rate-limitiert und verarbeitet keine Kundendaten. Die finale Auswahl gelangt ausschließlich als untrusted Wunsch in den Checkout und wird dort vollständig neu aufgelöst.

---

## 11. UI-Plan

### 11.1 Neuer WaWi-Bereich „Goodies“

Tabs / Teilbereiche:

1. **Übersicht:** Bestand, Ausgaben heute/30 Tage, Low-Stock, zuletzt ausgegeben.
2. **Katalog:** Goodie-Gruppen, aktive/archivierte Artikel, Foto, SKU, Varianten, Bestände, Ausgabe- und Shopfreigabe.
3. **Neues Goodie:** Minimal-Faktenformular → KI-Entwurf → Vorschau/Validierung → interne Aktivierung / Shopfreigabe.
4. **Ausgabehistorie:** Filter auf Auftrag, Kunde, SKU, Gruppe, Zeitraum, Benutzer, aktiv/storniert.

### 11.2 Bestellung und Packen

- Übersichtlich abgegrenzter Goodie-Abschnitt, kein Platz in der geldrelevanten Bestellartikel-Tabelle.
- Picker mit Gruppen-Navigation, Suche, Bild, Variantenchips, Bestand und Low-Stock-Hinweis.
- Auswahl und Bestätigung in einem kleinen dialogbasierten Schritt; die Buchung erfolgt sofort, nicht erst beim späteren Statuswechsel.
- Bereits gebuchte Goodies sind mit Ausgabezeit und Benutzer sichtbar; `stornieren` fordert Begründung und zeigt die Folgen vor der Aktion.

### 11.3 Kundenansicht und manueller Verkauf

- Kunden-Kontextpanel erhält die kompakte Goodie-Historie.
- In der manuellen Bestellung wird die Historie nach echter Kundenauswahl geladen; sie hilft der Entscheidung, verändert aber keine Preise, Warenkörbe oder Auslieferung automatisch.

### 11.4 Späterer Warenkorb-Reward-Bereich

- Kleine, klar abgegrenzte Fortschrittskarte in Warenkorb und Checkout; kein Popup und keine Platzierung zwischen regulären Artikeln.
- Goodie-Picker öffnet erst bei erreichtem Anspruch und zeigt nur zulässige Varianten mit Echtbestand.
- Eine Admin-Preview kann dieselbe Berechnung gegen einen simulierten Warenkorb darstellen, ohne echte Bestellung oder Bestandsbewegung auszulösen.
- Bis ein Programm aktiv ist, wird weder Karte noch API-Antwort im öffentlichen Shop sichtbar ausgeliefert.

---

## 12. Konfiguration statt Hardcoding

| Konfiguration | Speicherort | Beispiele |
|---|---|---|
| Goodie-Gruppen / Reihenfolge | `goodie_groups` | Textilien → Handtücher; Bekleidung → Damen / Herren |
| Ausgabeparameter | `goodie_article_settings`, optional `shop_settings.goodie_fulfillment_config` | ausgabefähig, Low-Stock-Schwelle, Mengenlimit |
| Kunden-Prämienregeln | `goodie_reward_programs`, `goodie_reward_tiers`, `goodie_reward_tier_articles` | programmbezogener Warenwert, berechtigte Waren/Stores/Länder, Stufen, Anzahl, Goodie-Auswahlliste, Zeitraum, sichtbarer Fortschrittstext |
| Katalog- und Contentprofile | `catalog_profiles` / Profile-Konfiguration | research legacy, merchandise physical, internal goodie |
| Shopkategorien und Übersetzungen | `categories`, `category_translations` | Merchandise, Zubehör |
| Merchant-Regeln | Merchant-Profil und `article_merchant` je SKU | GTIN-/MPN-Policy, Brand, Kategorie, Custom Labels |
| Standort/Brand/URLs | bestehende zentrale Store-/Deployment-Konfiguration | Keine neue Base-URL- oder Marken-Konstante im Feed |
| Rechte | bestehende Rollen + explizite Procedure-Grenzen | product_manager vs. admin |

Ein initialer Default ist als **Seed-Datensatz** zulässig, niemals als später nur durch Source-Code änderbares Verhalten. Jede Konfigurationsänderung muss validiert und auditierbar sein.

---

## 13. Umsetzung in risikoarmen Phasen

### Phase 0 – Preflight und technische Baseline

**Ziel:** Keine Annahme über produktive Migrationsstände.

- Branches von den oben dokumentierten Revisionen erzeugen.
- Produktionsschema nur lesend gegen `information_schema`, Constraints, Enums, vorhandene `schema_migrations`, Tabellen- und Feldnamen abgleichen.
- Bestehende Verträge aus `INVENTORY_VARIANT_ARCHITECTURE.md`, `PACKING_AUTOMATION.md`, `CUSTOMER_DOSSIER.md` und dem Manual-Sale-Summenvertrag als Regression-Baseline festlegen.
- Migrationsdatei mit sauberer Vorwärtsmigration, Prüfung und klarer Rollback-/Kompensationsstrategie vorbereiten. Keine automatische Zurücksetzung und keine Datenlöschung.

**Lieferobjekte:** ADR/Plan-Update, DDL-Entwurf, Testfälle, keine Produktionsänderung.

### Phase 1 – Datenmodell, Goodie-Ausgabe und Historie (intern)

**Ziel:** Sofort nutzbare Goodie-Verwaltung im Packen, ohne Shop-Verkauf anzufassen.

- Neue Tabellen, Indizes, Constraints und eindeutige Idempotency-Regel.
- `goodieService` mit atomarer Ausgabe/Storno sowie Bestandsjournal.
- Goodie-Katalog, Gruppen, Zugänge und Low-Stock in WaWi.
- Goodie-Picker in Bestellung/Packen und Goodie-Historie in Kundenkontext.
- Guards für Bestelllöschung.
- Prämienprogramm-, Staffel- und Freigabetabellen werden als **deaktivierte Vorbereitung** mitmigriert; kein öffentliches Programm und keine Checkoutanzeige werden in dieser Phase aktiviert.
- Feature Flag zunächst nur für interne WaWi-Rollen aktivieren.

**Deployment-Gate:** nur nach erfolgreichen Datenmodell-, Bestand-, Storno-, Doppelklick-, Historien- und Regressionstests.

### Phase 2 – Merchandise-Content und interne Shop-Vorschau

**Ziel:** Der Nutzer kann aus echtem Produktinput einen verkaufsfähigen Merchandise-Entwurf mit KI erzeugen, aber noch nicht live verkaufen.

- Profile, Merchandise-spezifischer Content-Generator und Product-Admin-Validierung.
- Asset-Provenance und Bildvalidierung.
- Generische Variantenanzeige im internen Katalog und Shop-Preview.
- Datengetriebene Kategoriepflege und Lokalisierung.
- Merchant-Datenmodell / Preview, aber Merchant-Upload noch gesperrt.

**Deployment-Gate:** Preview, Audit Log, fehlende Fakten, Bild-/Identifier- und Variantenvalidierung vollständig geprüft.

### Phase 3A – Generischer Merchandise-Checkout

**Ziel:** Erst jetzt werden Merchandise-SKUs regulär verkaufbar.

- Serverseitiger Variante-zu-Inventar-Resolver.
- Checkout-/Warenkorbvertrag für generische physische Varianten.
- Stock-, Preis- und Bestellpositionsauflösung für Merchandise.
- Strikte Trennung von Research-spezifischer Substitution/Cold Chain und Merchandise.
- E2E-Tests für Varianten, Bestand, Preis, Storno und parallele Goodie-Ausgabe.

**Deployment-Gate:** Testkauf in Staging/isoliertem Datensatz; keine Abweichung bei Peptid-Checkout, Rechnungen, DHL oder Rabatten.

### Phase 3B – Warenkorb-Prämienwahl (vorbereitet, erst nach Test aktivieren)

**Ziel:** Der Kunde sieht seinen Fortschritt und kann nach erreichter Stufe selbst ein Goodie wählen, ohne eine finanzielle Position oder unzuverlässige Lagerreservierung zu erzeugen.

- `goodieReward.preview` mit gemeinsamer serverseitiger Preis-/Regelauflösung.
- Warenkorb-/Checkoutkarte und kundenfähiger Variantenpicker.
- Finaler Checkout-Commit für Bestellung und `customer_reward`-Goodie-Ausgabe.
- Administrative Regelverwaltung mit standardmäßig deaktivierten Programmen und Audit Trail.
- Last-/Nebenläufigkeits-, Rabatt-, Stufenwechsel- und Fehlbestands-Tests.

**Deployment-Gate:** Test mit einem deaktivierten Programm, anschließender vollständig isolierter Testkauf und ausdrückliche Freigabe von Pakko für die erste aktive Prämienregel.

### Phase 4 – Merchant, SEO und kontrollierte Live-Freigabe

**Ziel:** Nur geprüfte Merchandise-Artikel erscheinen im Shop und Merchant Feed.

- Feed-Projektion nach Profil ausbauen; vorhandene Research-Items als Snapshot testen.
- Merchant Feed XML, statische Produktseiten, JSON-LD, Sitemap und hreflang validieren.
- Erst einen einzelnen geprüften Artikel freigeben; danach kontrollierter Rollout.
- Merchant Center Diagnostics prüfen, erst danach weitere Produkte freischalten.

---

## 14. Konkrete Modulkarte für die Umsetzung

Die nachfolgenden Pfade sind Planungsvorschläge für eine saubere Übergabe. Vor Codeänderung muss der aktuelle Branch erneut geprüft werden.

| Repository | Vorgesehene Dateien / Module | Verantwortung |
|---|---|---|
| Backend | `drizzle/schema.ts`, neue versionierte Migration unter `drizzle/migrations/`, ggf. `drizzle/relations.ts` | Additives Schema, FK/Indizes/Enums inklusive deaktivierter Reward-Programmtabellen |
| Backend | `server/goodieService.ts`, `server/goodieRouter.ts`, `server/goodieRewardService.ts`, `server/goodieRewardRouter.ts`, `server/catalogProfileService.ts`, `server/catalogProfileRouter.ts` | Transaktion, Policy, Anspruchsvorschau, API und Konfiguration |
| Backend | `server/orderRouter.ts`, `server/customerRouter.ts` / Customer-Context-Router, `server/routers.ts` | Read-Model, Löschschutz, finaler Reward-Commit und Router-Registrierung; kein Vermischen in Geldlogik |
| Backend | `server/productAdminRouter.ts`, separater `server/catalogContentService.ts` | Profile-fähiger Content-/Validierungsweg, Audit |
| Backend | `server/goodieService.test.ts`, `server/catalogProfile.test.ts`, Erweiterung der Order-/Stock-Tests | Unit-/Contract-Tests |
| Backend | `docs/GOODIES_AND_MERCHANDISE_IMPLEMENTATION_PLAN.md`, später `docs/GOODIES_OPERATING_GUIDE.md` | Architektur und Bedienvertrag |
| Frontend | `client/src/pages/WaWiGoodies.tsx`, `client/src/components/GoodiePickerDialog.tsx`, `client/src/components/GoodieHistoryPanel.tsx` | Interne Goodie-Verwaltung, Picker, Historie |
| Frontend | `client/src/pages/WaWiOrders.tsx`, `client/src/components/CustomerContextPanel.tsx`, WaWi-Navigation | Einbindung in Pack- und Kundenworkflow |
| Frontend | `client/src/lib/railwayApi.ts` | Strenge Typen für Goodie-/Profil-/Reward-API; keine `any`-Payloads |
| Frontend | generischer Varianten-Adapter, Warenkorb/Checkout (Phase 3A) sowie Reward-Progress-/Picker-Komponenten (Phase 3B) | Merchandise-Varianten und Kundenwahl ohne Peptid-Dosierungs-Überladung |
| Frontend | `scripts/generate-feed.mjs`, `scripts/generate-product-pages.mjs`, `scripts/generate-sitemap.mjs` | Profilbasierter Merchant/SEO-Build, keine Research-Fallbacks für Merch |
| Frontend | `client/src/lib/*.test.ts`, Shop-/Checkout-Tests | Regression und E2E-orientierte Verträge |

**Nicht zulässig:** Goodie-Logik als verstreute Namensprüfung in `WaWiOrders.tsx`, Kategorie-Hardcoding in `LanguageContext.tsx`, direkte SQL-Schreibzugriffe aus dem Client, oder eine weitere statische Produktliste als Bestandsfallback.

---

## 15. Abnahme- und Regressionstestmatrix

| Bereich | Muss nachweislich funktionieren |
|---|---|
| Migration | Leere und produktionsähnliche Datenbank; Migration einmalig/idempotent; keine Löschung/Umwidmung bestehender Artikel, Varianten, Kunden oder Bestellungen. |
| Bestands-Single-Source | Zugang, Shopverkauf und Goodie-Ausgabe verändern nur die echte `articles.stock`-SKU; kein JSON- oder Clientbestand wird führend. |
| Atomarität | Zwei parallele Ausgaben des letzten Goodies führen nie zu negativem Bestand und nie zu doppelter Historie. |
| Wiederholung | Doppelter Klick/Retry mit gleichem Idempotency Key bucht genau einmal. |
| Storno | Ein Storno erzeugt Gegenbewegung und sichtbaren History-Status, löscht aber keine Ausgabe. Zweites Storno wird blockiert. |
| Bestellschutz | Auftrag mit Goodie-Ausgabe kann nicht unbemerkt über `delete`/`deleteNoRestock` entfernt werden. |
| Kundenhistorie | Der nächste Auftrag desselben Kunden zeigt die richtigen ausgegebenen Goodies, ausgeblendet/markiert bei Storno; fremde Kunden erhalten niemals Einsicht. |
| Reward-Vorschau | Beträge, Stufen und zulässige Artikel stammen ausschließlich aus serverseitiger Regel-/Preisauflösung; eine deaktivierte Regel ist öffentlich nicht sichtbar. |
| Reward-Grenzwerte | Unterhalb, exakt auf und oberhalb jeder Stufe; mehrere Stufen, Auswahlanzahl, ausgeschlossene Kategorien, Rabatte, Sale-Artikel, Versand, Länder und Stores werden gemäß der jeweiligen Regel nachvollziehbar getestet. |
| Reward-Checkout | Manipulierte Auswahl, falsche Stufe, falsche Variante, Doppelrequest und letzter Bestand werden abgewiesen bzw. idempotent behandelt; Bestellung und Goodie werden nie nur teilweise gebucht. |
| Reward-Fehlbestand | Eine beim Abschluss vergriffene Auswahl zeigt Alternativen oder bewusstes Entfernen, ohne negative Bestände, leere Goodie-Zusage oder versteckte Preisänderung. |
| Rechnung/Geld | Goodies ändern weder `subtotal`, `discount`, `shipping`, `total`, Zahlung, Rabattaufteilung noch reguläre Rechnungspositionen. |
| Packing/DHL | Packfoto, Chargen, DHL-Label, Versandstatus und WhatsApp-Workflow bleiben in der bestehenden Reihenfolge unverändert; Goodie-Ausgabe ist kein stiller Packabschluss. |
| Peptid-Regression | Varianten, Smart Substitution, Cold Shipping, Plug&Play, Nasenspray, manuelle Verkäufe und bestehende Lagerbewegungen bleiben identisch. |
| Merchandise-Variante | Farbe/Größe wird korrekt auf reale SKU aufgelöst, im Shop und Feed gleich dargestellt und bei Bestand 0 gesperrt. |
| KI-Content | Merchandise-Prompt produziert keine Research-/Dosierungs-/Heilversprechen; fehlende Fakten werden als fehlend angezeigt. |
| Bilder | Echte Bilder, erreichbare URLs, richtige Variante, keine Platzhalter/Overlays, Provenance-Metadaten für KI-Bilder erhalten. |
| Merchant | Je Merchandise-SKU ein valides Item; korrekte Gruppen-ID/Attribute; kein RUO-Label; echte Identifikatorentscheidung; Preis/Bestand/URL/Bild deckungsgleich mit Shop. |
| Bestehender Feed | Snapshot-Vergleich bestätigt, dass Research-Produkte nach Feed-Refactor keine unbeabsichtigten Feldänderungen erhalten. |
| SEO | Produktseite, Canonical, hreflang, JSON-LD, Kategorie und Sitemap funktionieren für Merchandise ohne Research-Fallbackwerte. |
| Build/Typen | Backend-Typcheck/Tests, Frontend `pnpm run check`, gezielte Tests und `pnpm run build` sind grün. |

---

## 16. Betriebs- und Freigaberegeln

1. **Interne Goodies zuerst:** Erst wenn Ausgabe, Storno und Historie stabil laufen, wird der Shopteil angefasst.
2. **Shop und Merchant getrennt:** Ein Artikel kann intern aktiv, shop-sichtbar aber Merchant-deaktiviert sein. Merchant schaltet nur nach eigener Validierung frei.
3. **Kein Retro-Import:** Frühere Geschenke bleiben außerhalb der strukturierten Historie, solange sie nicht manuell und ausdrücklich als historische Erfassung nachgetragen werden.
4. **Niedriger Bestand ist Warnung, nicht Preis- oder Versandlogik:** Kein automatisches Geschenk, kein Ersatz, kein Override.
5. **Datenqualität vor Optik:** Ohne Fotos kann intern ausgegeben werden, aber keine öffentliche Produkt-/Merchant-Freigabe erfolgen.
6. **Operative Korrektur:** Falsche Ausgabe wird zeitnah mit Begründung storniert; der Packer bucht nicht durch Bearbeiten eines Namens oder manuellen Bestandseingriff zurück.
7. **Kundenwahl ist opt-in innerhalb eines aktiven Programms:** Ohne Auswahl entsteht kein erzwungenes Goodie. Eine nachträglich nicht verfügbare SKU wird nie automatisch durch einen anderen Artikel ersetzt.
8. **Aktivierung erst nach Test:** Ein Prämienprogramm bleibt bis zur expliziten Aktivierung deaktiviert; Schwelle, Warenwertbasis, Auswahlmenge, zulässige Goodies, Zeitraum und Texte müssen vor dem Start in der WaWi sichtbar geprüft werden.

---

## 17. Entscheidungslog für die spätere Umsetzung

Die folgenden Entscheidungen sind im Plan bewusst getroffen und müssen nicht pro Agent neu erfunden werden:

| Entscheidung | Begründung |
|---|---|
| Goodie-Ausgabe als eigene Tabelle statt `order_items` | Schutz von Geld, Rechnung und regulärem Checkout. |
| Reale SKU pro physischer Variante | Korrekte Bestände, Historie und Merchant-Varianten. |
| Kein Peptid-Prompt / keine Peptid-Variante für Merchandise | Verhindert fachlich falsche Claims und Dosierungsüberladung. |
| Goodies und Merchandise dürfen denselben Artikelbestand nutzen | Kein Doppelbestand und keine Synchronisationsfehler. |
| Shopverkauf nach Goodie-Rollout | Reduziert Risiko; der aktuelle Checkout ist nur für Peptide inventarisch vollständig. |
| Kundenwahl als spätere, konfigurierbare Reward-Stufe | Der Anspruch wird serverseitig aus dem aktuellen Warenkorb berechnet; Auswahl bleibt bis Checkout unverbindlich und wird final atomar gebucht. |
| Merchant als profilbasierte Projektion | Verhindert harte RUO-/Kategorie-/Identifier-Fallbacks bei physischer Ware. |
| Historie ist unveränderbar, Korrektur kompensierend | Nachvollziehbarkeit für Kundenservice, Lager und spätere Automatisierung. |
| Keine aktive Automatikregel in V1 | Erst belastbare, manuelle Ausgabe-Historie schaffen; Reward-Datenmodell wird vorbereitet und erst nach Test per Konfiguration aktiviert. |

---

## 18. Quellen und geprüfte Referenzen

### Interne technische Referenzen

- `docs/INVENTORY_VARIANT_ARCHITECTURE.md` – führender Bestands- und Peptidvariantenvertrag.
- `docs/PACKING_AUTOMATION.md` – Packabschluss-/DHL-Sequenz und Invarianten.
- `docs/CUSTOMER_DOSSIER.md` und `docs/CUSTOMER_INTEGRITY_AND_WHATSAPP.md` – Kundenkontext und revisionssichere Darstellung.
- `server/orderRouter.ts` – aktuelle Bestell-, Bestands- und Löschpfade.
- `server/articleRouter.ts` – bestehender, Research-spezifischer KI-Beschreibungsgenerator.
- `server/productAdminRouter.ts` – bestehende Produkt-Audit-/Publish-Grenzen.
- `369-research-frontend/scripts/generate-feed.mjs` – aktuell globale Research-Merchant-Fallbacks.
- `369-research-frontend/scripts/generate-product-pages.mjs` und `scripts/generate-sitemap.mjs` – statische SEO-Generierung.

### Externe Merchant-Referenzen

- [Google Merchant Center – Product data specification](https://support.google.com/merchants/answer/7052112?hl=en-IE)
- [Google Merchant Center – Item group ID](https://support.google.com/merchants/answer/6324507?hl=en)
- [Google Merchant Center – GTIN](https://support.google.com/merchants/answer/6324461?hl=en)

Eine komprimierte Auswertung der Merchant-Anforderungen liegt zusätzlich unter `EXTERNAL_MERCHANT_RESEARCH_2026-09-27.md` im Planungs-Workspace.

---

## 19. Nächster autorisierter Schritt

Bei späterer Umsetzung beginnt der ausführende Agent mit **Phase 0**: Quellstand und Produktionsmetadaten erneut lesen, Migrationsentwurf erstellen, die Testmatrix in konkrete automatisierte Tests übersetzen und erst danach additive Implementierungs-Commits vorbereiten. Es wird keine bestehende Bestellung, kein Bestand und keine Shop-/Merchant-Freigabe ohne expliziten Release-Schritt verändert.
