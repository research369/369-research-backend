# Goodies – Implementierungs-Handover

**Stand:** 27. September 2026  
**Scope:** Interne Goodie-Verwaltung, Ausgabe beim Packen und Kundenhistorie.  
**Nicht aktiviert:** Öffentlicher Merchandise-Verkauf und Kundenwahl nach Warenkorbwert.

## Was produktiv geliefert wird

1. **WaWi → Goodies**
   - Ein schlankes Formular legt einen realen Artikel plus Goodie-Katalogeintrag an.
   - Freie optionale Gruppe und Zusatz-/Variantenlabel; keine vordefinierten oder automatisch angelegten Kategorien.
   - Anfangsbestand, Meldebestand, Einkaufspreis, Verkaufspreis, Notiz und optionale SKU.
   - Die SKU wird bei leerem Feld serverseitig erzeugt.
   - Bestand bleibt ausschließlich in `articles.stock` und wird im bestehenden `stock_history` geführt.

2. **Packen → Goodies für diese Bestellung**
   - Nur aktive Goodies mit Bestand werden gezeigt.
   - Ein Klick schreibt atomar: Sperre auf Bestellung/Artikel, Bestandsabzug, `stock_history` und Goodie-Ausgabe.
   - Die Ausgabe gehört **nicht** zu `order_items`, beeinflusst keine Rechnung, Zahlung, Rabatt, Versand oder Bestellsumme.
   - Jede Auswahl hat eine clientseitig erzeugte `requestId`, die serverseitig eindeutig ist. Netzwerkwiederholungen oder parallele Klicks können daher nicht doppelt buchen.
   - `Korrigieren` ist eine kompensierende Buchung: Ausgabebeleg bleibt erhalten, Bestand wird zurückgebucht.

3. **Kundenkontext beim nächsten Auftrag**
   - Der Packbildschirm zeigt „Früher erhalten“ aus der echten Kunden-ID und der Goodie-Ausgabehistorie.
   - Zusätzlich sind die für den aktuellen Auftrag zugelegten Goodies sichtbar.

## Datenmodell

| Tabelle | Zweck |
|---|---|
| `goodie_catalog` | Ergänzt einen bestehenden Artikel um Goodie-spezifische Metadaten: optionale Gruppe/Anzeige, Aktivität, spätere Reward-/Shop-Vormerkung und Sortierung. |
| `goodie_assignments` | Revisionssicherer Einzelbeleg je Ausgabe mit Order-, Kunden- und Artikelbezug, Snapshots, Quelle, Benutzer, Zeit, `request_id` und Korrekturfeldern. |
| `goodie_reward_config` | Deaktivierte Vorbereitung für die spätere Kundenwahl; `enabled = false`, keine automatische Schwelle und keine Checkout-Anzeige. |

Die Schemaanlage erfolgt über `ensureGoodieSchema()` beim Backend-Start, ist additiv und idempotent. Vorhandene Aufträge, Kunden, Rechnungen, Stock- und Checkouttabellen werden weder migriert noch umgebaut.

## Berechtigungen

| Aktion | Rollen |
|---|---|
| Goodie anlegen / Metadaten pflegen | `admin`, `product_manager` |
| Goodie beim Packen lesen, ausgeben, korrigieren | `admin`, `packing`, `product_manager` |
| Reward-Konfiguration lesen / zukünftig ändern | nur `admin` |

## Bewusst noch nicht freigeschaltet

- **Shop/Merchandise:** Das `shopSellable`-Flag ist nur eine Vormerkung. Es schaltet kein Produkt öffentlich sichtbar. Der aktuelle Shop-Checkout ist für Peptide gebaut; Merchandise muss erst einen generischen Varianten-/Inventory-Resolver, eigenen Content-/Bildpfad, Shop-Preview und Merchant-Validierung erhalten.
- **KI-Texte und Bilder:** Der vorhandene Peptid-Generator wird absichtlich nicht für Textilien/Zubehör verwendet. Der Merchandise-Prompt samt Faktenvalidierung wird als getrennte Ausbaustufe geliefert.
- **Kundenwahl nach Bestellwert:** Datenbasis ist vorhanden, bleibt deaktiviert. Es gibt keine versteckte Euro-Schwelle, keine automatische Auswahl und keinen öffentlichen Endpunkt im Checkout.

## Wichtige Fortsetzungsregeln

1. Nie Goodies als `price = 0` in `order_items` schreiben.
2. Nicht `article.generateDescription` für Merch nutzen; dieser Prompt ist Research-/Peptid-spezifisch.
3. Keine Shopkategorie oder Merchant-Defaultwerte im Frontend hardcoden.
4. Vor einer öffentlich sichtbaren Aktivierung müssen generischer Checkout, Shopdarstellung, Content-/Bildvalidierung und Merchant-Profil getrennt getestet werden.
5. Beim Hinzufügen einer Auftragslöschung ist `goodie_assignments` ausdrücklich zu prüfen; eine Korrektur muss über den Kompensationspfad erfolgen.

## Betroffene Dateien

### Backend

- `server/goodieSchema.ts`
- `server/goodieRouter.ts`
- `server/routers.ts`
- `server/trpc.ts`
- `server/index.ts`
- `server/customerIntegrityRouter.ts`

### Frontend

- `client/src/pages/WaWiGoodies.tsx`
- `client/src/pages/WaWiOrders.tsx`
- `client/src/lib/railwayApi.ts`
- `client/src/components/WaWiLayout.tsx`
- `client/src/App.tsx`
