# Kundenakte: Tags, Kundenstatus und Problemfälle

## Zweck

Die Kundenakte bündelt eine **sichtbare Kundenklassifizierung** und eine revisionssichere Problemhistorie. Sie erscheint im Kundendatensatz, in geöffneten Bestellungen sowie unmittelbar nach der Auswahl eines bestehenden Kunden bei einer manuellen Bestellung. Damit sehen Mitarbeiter vor jeder Bearbeitung, ob es relevante frühere Versand-, Qualitäts-, Adress- oder Servicefälle gibt.

## Datenmodell

| Tabelle | Zweck | Löschverhalten |
|---|---|---|
| `customer_tag_definitions` | Zentraler, konfigurierbarer Katalog sichtbarer Kundentags | Definitionen können deaktiviert, nicht durch die Kundenoberfläche gelöscht werden |
| `customer_issue_cases` | Revisionssichere Problemfälle mit Kunde, optionaler Bestellung, Priorität, Status und Lösungsvermerk | Fälle werden abgeschlossen oder archiviert, nie über die WaWi gelöscht |

Tags selbst bleiben im vorhandenen Feld `customers.tags` gespeichert. Die neue Tabelle liefert ausschließlich die standardisierte Anzeige, Farbe und Sortierung.

## Zentrale Konfiguration

Die Einstellungen werden beim Start additiv in `shop_settings` hinterlegt und können ohne Frontend-Code angepasst werden.

| Schlüssel | Inhalt |
|---|---|
| `customer_dossier_status_rules` | Schwellen für abgeleiteten Status: Neukunde, Wiederkehrend, Stammkunde, Vielbesteller, VIP |
| `customer_dossier_issue_categories` | Auswahlliste der Problemkategorien |

Der Status wird bei jedem Abruf der Kundenakte aus bezahlten Bestellungen und Umsatz berechnet. Tags sind ausdrücklich manuell steuerbar und überlagern den Status nicht.

## API

Alle Endpunkte sind durch `adminProcedure` geschützt.

| Endpunkt | Funktion |
|---|---|
| `customerDossier.overview` | Kundenstatus, Tags, Kennzahlen und offene/aktuelle Problemfälle |
| `customerDossier.tagDefinitions` | Tagkatalog lesen |
| `customerDossier.saveTagDefinition` | Tagdefinitionen pflegen |
| `customerDossier.setCustomerTags` | Tags am Kunden ersetzen |
| `customerDossier.createCase` | Problemfall revisionssicher anlegen |
| `customerDossier.resolveCase` | Fall in Bearbeitung, gelöst oder archiviert setzen |
| `customerDossier.casesForOrders` | Fälle für mehrere Bestellungen abrufen |

## Bedienablauf

1. In **Kunden** oder einer geöffneten **Bestellung** steht oben die Kundenakte mit Status, Tags und Kundenwert.
2. Offene Problemfälle erscheinen rot und enthalten Titel, Kategorie, Bestellbezug, Details und Erfassungszeitpunkt.
3. Ein Mitarbeiter kann den Fall auf **In Bearbeitung** setzen oder mit einem Lösungsvermerk als **Gelöst** abschließen.
4. Über **Problemfall erfassen** wird ein neuer Fall direkt beim Kunden angelegt; aus einer Bestellung heraus wird die Bestellnummer automatisch verknüpft.
5. Bei **Neuer Verkauf** werden Status, Tags und offene Fälle sofort nach Kundenauswahl angezeigt. Der Ablauf wird gewarnt, aber nicht automatisch blockiert.

## Implementierungsdateien

| Bereich | Dateien |
|---|---|
| Datenbank und Migration | `drizzle/schema.ts`, `server/customerDossierSchema.ts` |
| Geschäftslogik/API | `server/customerDossierRouter.ts`, `server/routers.ts`, `server/index.ts` |
| WaWi-UI | `client/src/components/CustomerContextPanel.tsx`, `client/src/components/NewSaleDialog.tsx` |
| API-Client | `client/src/lib/railwayApi.ts` |

## Schutzvorgaben

* Kein automatisches Zusammenführen, Sperren oder Ändern von Kunden- bzw. Bestelldaten.
* Problemfälle bleiben erhalten und werden nur über Statuswechsel abgeschlossen oder archiviert.
* Der Packabschluss wird nicht blockiert; Mitarbeitende werden stattdessen sichtbar gewarnt.
* Tags, Regeln und Kategorien bleiben konfigurierbar und sind nicht als Anzeige-Logik im Frontend fest verdrahtet.
