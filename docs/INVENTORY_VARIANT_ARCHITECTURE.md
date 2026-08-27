# Varianten-, Lager- und Shopverfügbarkeitsarchitektur

**Gültig ab:** 26. August 2026  
**Verantwortliche Komponenten:** `server/articleRouter.ts`, `server/orderRouter.ts`, `server/substitutionService.ts`, `drizzle/schema.ts`, WaWi-Artikelansicht und Shop-Produktdatenhook.

Dieses Dokument ist die verbindliche technische Referenz für Produktfamilien mit Dosierungs-, Größen- oder Volumenvarianten. Es ermöglicht Entwicklern und Agenten, Varianten zu erweitern oder zu reparieren, ohne doppelte Shopprodukte, falsche Bestände oder nicht bewegbare Lagerzeilen zu erzeugen.

## 1. Grundsatz: eine Produktionsdatenbank als Bestandsquelle

> **Der Bestands-Single-Source-of-Truth ist ausschließlich die Spalte `articles.stock` der aktuellen Railway-Produktionsdatenbank.**

Das Backend bezieht die Datenbankverbindung nur über `ENV.databaseUrl`, also über die nicht versionierte Railway-Umgebungsvariable `DATABASE_URL` (`server/db.ts`). Es gibt keine zweite aktive Produkt-, Varianten- oder Bestandsdatenbank im Anwendungscode.

| Quelle | Rolle | Darf Bestand führen? |
|---|---|---|
| Railway PostgreSQL, Tabelle `articles` | Operativer Bestand, Artikel- und Variantenmetadaten | **Ja – ausschließlich diese Quelle** |
| `articles.variants` (JSON) | Vertrag für Dosierung, Verkaufspreis, SKU und Referenz auf Lagerzeile | Nein – enthält keinen führenden Bestand |
| `client/src/lib/products.ts` | Statische Typen, Entwicklungs-/Darstellungsdaten | Nein – wird vom Produktionshook nicht als Shop-Fallback verwendet |
| `shopProducts` / `shopAvailability` API | Lesende Projektion der Produktionsdaten | Nein |
| `backupService.ts` | Backup derselben `DATABASE_URL` | Nein – keine zweite Datenquelle |

Der Shop lädt seine Produkte über `useShopProducts` aus `article.shopProducts`. Wenn die API nicht erreichbar ist, wird kein lokaler Produkt- oder Bestandsfallback verwendet. Die statische Frontenddatei `products.ts` darf deshalb nie als alternative Bestandsquelle erweitert werden.

## 2. Datenmodell

Die Tabelle `articles` enthält sowohl den sichtbaren Familienartikel als auch die physischen Lagerzeilen.

| Feld | Bedeutung | Schreibregel |
|---|---|---|
| `id` | Unveränderliche primäre Artikel-ID | Nie für eine andere physische Ware wiederverwenden |
| `sku` | Eindeutige Lager-SKU | Je Dosierung/Variante eindeutig |
| `shop_product_id` | Gemeinsame Produktfamilie, z. B. `bpc-157` | Für Familienartikel und alle zugehörigen Lagerzeilen identisch |
| `stock` | Tatsächlicher verfügbarer Bestand dieser konkreten Lagerzeile | Nur WaWi-Bestandsbewegung bzw. Bestellfluss ändert diesen Wert |
| `selling_price` | Preis der konkreten Lagerzeile | Darf als Preisfallback dienen, aber nicht als Bestand |
| `is_active` | Operativ aktiv für Lager, Bestellung und Smart Sub | Familienartikel und operative Variantenlagerzeilen sind aktiv |
| `shop_visible` | Als eigenständige Shopquelle sichtbar | Nur der kanonische Familienartikel hat den Wert `1` |
| `variants` | Persistierter Variantenvertrag auf dem Familienartikel | Nur auf dem kanonischen Familienartikel pflegen |

## 3. Verbindlicher Variantenvertrag

Bei einer Produktfamilie mit Varianten gibt es **genau einen** kanonischen Familienartikel: `is_active = 1`, `shop_visible = 1`, `variants` ist ein Array.

Jede kaufbare Variante muss exakt diese Felder besitzen:

```json
{
  "name": "10 mg",
  "dosage": "10 mg",
  "label": "10 mg",
  "price": 39,
  "sku": "BPC-157-10MG",
  "inventoryArticleId": 2,
  "isActive": true
}
```

| Variantenfeld | Pflicht | Funktion |
|---|---:|---|
| `dosage` | Ja | Einheitliche Auswahl und Auflösung, z. B. `10 mg` |
| `label` | Ja | Sichtbarer Text in Shop und WaWi |
| `price` | Ja | Verkaufspreis der Variante; 0 oder `null` ist keine gültige Verkaufspreis-Konfiguration |
| `sku` | Ja | Erwartete Lager-SKU, lesbar für Menschen und Integrationen |
| `inventoryArticleId` | Ja | Verbindliche Referenz zur realen Lagerzeile |
| `isActive` | Ja | Steuert Variantenverfügbarkeit, ohne die Lagerhistorie zu löschen |
| `hidden` | Nur für nicht verkäufliche Varianten | Muss `true` sein, wenn keine reale Lager-SKU existiert |

**Die Variante darf keinen führenden `stock`-Wert enthalten.** Der öffentliche Bestand wird anhand von `inventoryArticleId` aus `articles.stock` gelesen. Ein alter JSON-Bestandswert kann als Übergangsdatenfeld existieren, wird bei einer expliziten Lager-ID aber ignoriert und anschließend entfernt.

## 4. Sichtbarkeits- und Betriebsregeln

| Objekt | `is_active` | `shop_visible` | `variants` | Zweck |
|---|---:|---:|---|---|
| Kanonischer Familienartikel | 1 | 1 | vollständig | Einzige öffentliche Shopquelle und WaWi-Familienknoten |
| Operative Variantenlagerzeile | 1 | 0 | `null` | Echter Lagerbestand, WaWi-Bewegung und Smart Sub |
| Ausverkaufte Variante | 1 | 0 für Lagerzeile | vollständiger Eintrag im Familienvertrag | Im WaWi-Baum sichtbar; im Shop nicht kaufbar, aber nicht gelöscht |
| Noch nicht physisch angelegte Variante | 0/1 je Artikelstatus | 0 | `hidden: true`, `isActive: false` im Vertrag | Darf nicht als kaufbare Shopvariante erscheinen |
| Historische Altzeile | 0 | 0 | `null` | Ausschließlich Historie; nie automatisch löschen |

Operative Lagerzeilen mit `shop_visible = 0` sind bewusst aktiv. Der WaWi-Artikelrouter blendet sie aus der top-level Artikelliste aus, wenn sie über `inventoryArticleId` von einer sichtbaren Familie referenziert werden. Sie erscheinen stattdessen als Varianten unter dem Familienartikel.

## 5. Datenfluss

```text
WaWi-Bestandsbewegung / Bestellung
          │
          ▼
articles.stock der konkreten inventoryArticleId
          │
          ├── WaWi-Familienansicht und Variantenhistorie
          ├── article.shopProducts / article.shopArticle
          ├── article.shopAvailability
          └── Smart-Sub-Prüfung gegen aktive Lagerzeilen
```

`getPublicShopVariants` liest bei vorhandener `inventoryArticleId` ausschließlich den Bestand der verknüpften Lagerzeile. `getManualArticleVariants` liefert dieselbe Zuordnung inklusive Lagerartikel-ID an die WaWi. Eine Bestandsbewegung wird dadurch immer gegen die physische Variante gebucht, nicht gegen einen zufällig sichtbaren Familienartikel.

## 6. Smart Substitution

Smart Substitution gilt nur für berechtigte Peptidkategorien und nutzt reale, aktive Lagerzeilen derselben `shop_product_id`. Zubehör, Pens, BAC Wasser, Verpackungen und sonstige nicht berechtigte Kategorien dürfen nie als Smart Sub eingesetzt werden.

Der Resolver:

1. liest aktive Lagerzeilen derselben Produktfamilie;
2. bestimmt die Dosierung aus Name oder SKU;
3. akzeptiert nur kleinere, tatsächlich verfügbare Varianten;
4. sucht eine exakt passende Kombination statt eines unvollständigen Greedy-Resultats;
5. schreibt die verwendeten echten Artikel-IDs in die Bestell-/WaWi-Historie.

Damit Smart Sub funktioniert, müssen operative Variantenlagerzeilen aktiv bleiben, auch wenn sie nicht eigenständig im Shop sichtbar sind.

## 7. Standardablauf für neue Varianten

1. Physische Lagerzeile mit eindeutiger SKU, Preis, `stock = 0`, `is_active = 1`, `shop_visible = 0` anlegen.
2. Derselben `shop_product_id` wie der Familienartikel zuordnen.
3. Variante im `variants`-Array des kanonischen Familienartikels ergänzen – inklusive `inventoryArticleId`, SKU, Dosierung, Preis und `isActive`.
4. Kein separates Produkt im Shop anlegen und keinen JSON-Bestand pflegen.
5. WaWi-Variantenbaum, `shopProducts`, `shopAvailability`, manuelle Bestellung und Smart Sub rein lesend prüfen.
6. Erst dann Bestand über die normale WaWi-Bestandsbewegung buchen.

## 8. Standardablauf für eine Variantenkorrektur

1. Vorher-Snapshot aller Zeilen derselben `shop_product_id` sichern.
2. Jede Dosierung eindeutig aus Name/SKU ableiten und genau einer Lagerzeile zuordnen.
3. Einen kanonischen sichtbaren Familienartikel festlegen; alle übrigen aktiven Variantenlagerzeilen auf `shop_visible = 0` setzen.
4. Alle Varianten-JSONs der operativen Unterzeilen auf `null` setzen, damit keine zweite Variantenquelle bestehen bleibt.
5. Variantenvertrag nur auf dem kanonischen Artikel schreiben – mit `inventoryArticleId`, ohne `stock`.
6. Bestände nicht überschreiben; nur die Zuordnung, Sichtbarkeit und Variante normalisieren.
7. Atomar ausführen und danach API-Ausgabe sowie WaWi-Variantenbaum prüfen.

## 9. Sonderfall: Variante ohne reale Lager-SKU

Eine Variante ohne eigene physische Lagerzeile darf nicht die Lagerquelle einer anderen Dosierung verwenden. Sie wird im Variantenvertrag mit `hidden: true` und `isActive: false` geführt oder erst wieder sichtbar geschaltet, wenn eine echte Lager-SKU existiert.

**Beispiel:** Epithalon 50 mg darf nicht den Bestand von Epithalon 10 mg anzeigen. Solange keine 50-mg-Lagerzeile existiert, bleibt diese Auswahl nicht kaufbar.

## 10. Prüf- und Freigabekriterien

Vor jedem Deploy müssen folgende Prüfungen bestehen:

```bash
# Backend
./node_modules/.bin/tsc --noEmit

# Frontend
./node_modules/.bin/tsc --noEmit
```

Nach einem Deploy müssen mindestens diese Punkte geprüft werden:

| Prüfung | Erwartetes Ergebnis |
|---|---|
| `article.shopProducts` | Jede Produktfamilie erscheint nur einmal; jede Variante hat korrekten Preis und Bestand |
| `article.shopAvailability` | Bestand je Dosierung entspricht der realen Lagerzeile |
| WaWi-Artikelbaum | Alle Varianten sind sichtbar; operative Unterzeilen nicht doppelt top-level |
| WaWi `+` / `−` | Bewegung schreibt gegen die `inventoryArticleId` der ausgewählten Variante |
| Shopproduktseite | Ausverkaufte Varianten sind nicht kaufbar; vorhandene Varianten zeigen ihren echten Bestand |
| Smart Sub | Nutzt nur zulässige Kategorien und echte aktive kleinere Lagerzeilen |

## 11. Verbotene Änderungen

- Keine festen Produkt-IDs, Bestände, Variantenpreise oder Variantenfamilien im Runtime-Code hinterlegen.
- Keine zweite Datenbank, CSV, Frontenddatei oder Cachequelle als Bestandsquelle verwenden.
- Keine Lagerzeile löschen, wenn Bestell-, Bewegungs- oder Nachweishistorie existiert.
- Keine operative Variantenzeile allein deshalb deaktivieren, weil sie im Shop nicht separat erscheinen soll.
- Keine Variantenbestände im JSON fortschreiben.
- Keine Zubehörartikel über Smart Sub substituieren.

## 12. Migration vom 26. August 2026

Die 3G-Familie wurde zuerst nach diesem Modell normalisiert. Die im Vollabgleich als kritisch bewerteten Familien wurden anschließend mit demselben Datenvertrag überführt. Der einmalige Migrationscode ist nicht Teil der Laufzeit und wird nicht als Produktlogik verwendet; die dauerhafte Logik liegt ausschließlich im Router und im Datenmodell.

Normalisiert wurden: `5-amino-1mq`, `aod-9604`, `bpc-157`, `cagrilinitide`, `cjc-1295-no-dac`, `dsip`, `epithalon`, `ghk-cu`, `ghrp-2`, `ghrp-6`, `glutathione`, `hcg`, `ipamorelin`, `mots-c`, `nad-plus`, `ss-31`, `tb-500`, `thymosin-alpha-1` und `tirzepatide`. Epithalon 50 mg ist dabei bewusst nicht kaufbar, weil es weiterhin keine eigene physische Lager-SKU gibt.

Für künftige Wartung gilt dieses Dokument vor älteren Chatnotizen, temporären Auditdateien oder historisch mehrfach gespeicherten Varianten-JSONs.
