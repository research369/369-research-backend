# Automatisierter Packabschluss und DHL-Versand

**Gültigkeitsbereich:** Dieser Ablauf gilt für DHL-Sendungen, die aus der WaWi über `Packen abschließen` bearbeitet werden. Abholaufträge bleiben vom automatischen DHL-Label unverändert ausgenommen.

## Ziel und Sicherheitsinvarianten

Der Packabschluss ist absichtlich sequenziell. Kein nachfolgender Schritt darf stattfinden, wenn der vorherige nicht erfolgreich und dauerhaft bestätigt ist.

```text
Packpositionen vollständig
→ Packfoto serverseitig gespeichert
→ gespeicherte Lieferadresse geprüft und protokolliert
→ Chargen zugeordnet
→ Status gepackt
→ DHL-Label erzeugt
→ Label geöffnet / Browserdruck angefordert
→ Status versendet
→ Versandmail nur bei gültiger E-Mail
→ bestehende WhatsApp-Web-Nachricht wird geöffnet
```

Die folgenden Regeln sind verbindlich:

| Regel | Technische Durchsetzung |
|---|---|
| Kein Packfoto, kein Versand | Der Client prüft das Pflichtfoto; der Upload muss eine erfolgreiche Serverantwort liefern, bevor Chargen oder Status verändert werden. |
| Jede DHL-Adressprüfung ist nachweisbar | `addressValidation.validateForShipment` liest ausschließlich die gespeicherte Bestellung und schreibt einen unveränderbaren Nachweis mit `context = shipping_automation`. |
| Keine doppelte Chargenabbuchung | `purchaseOrder.assignBatchToOrderItem` erkennt identische Zuweisungen je `order_id` und `order_item_id` und beendet sie idempotent. Eine bewusste Neuzuordnung bucht die alte Menge zuerst zurück. |
| Kein doppeltes DHL-Label | Der DHL-Router bleibt die serverseitige Quelle für Tracking-/Label-Duplikatschutz. Bei Fehlern nach `gepackt` werden Chargen auf Wiederholung nicht nochmals bewegt. |
| Keine Dummy-Mail | Der Statuswechsel zu `versendet` ruft die Versandmail nur bei aktiver Konfiguration auf. Die E-Mail-Service-Validierung überspringt fehlende oder ungültige Empfänger ohne Versandversuch. |
| WhatsApp bleibt unverändert | Nach erfolgreichem DHL-Label öffnet die bestehende WhatsApp-Web-Funktion die vorhandene Versandnachricht. Es gibt keine neue WhatsApp-API oder zusätzliche Nachrichtenvorlage. |

## Zentrale Konfiguration

Die Konfiguration liegt ausschließlich in der Tabelle `shop_settings` unter dem Schlüssel `packing_automation_config`. Sie ist absichtlich kein Code- oder Frontend-Constant.

```json
{
  "enabled": true,
  "requireServerConfirmedPackingPhoto": true,
  "requireDhlAddressValidation": true,
  "domesticProfile": "DHL_DE_STANDARD",
  "internationalProfile": "DHL_EU",
  "packstationProfile": "DHL_DE_STANDARD",
  "requestBrowserPrint": true,
  "sendShippingEmail": true,
  "openWhatsAppAfterLabel": true
}
```

Die einzige zugelassene Pflege erfolgt über die tRPC-Admin-Endpunkte:

- `shopSettings.getPackingAutomationConfig`
- `shopSettings.setPackingAutomationConfig`

Die Standardkonfiguration wird mit `scripts/seed_packing_automation_config.mjs` einmalig eingerichtet. Dieses Hilfsskript gehört nicht in einen Produktiv-Deploy und wird nach Verwendung aus dem Arbeitsstand entfernt.

## Profile und Ausnahmen

| Auftragstyp | Profilquelle | Verhalten |
|---|---|---|
| Deutsche Standardadresse | `domesticProfile` | DHL-Label wird automatisiert erzeugt. |
| Packstation | `packstationProfile` | DHL prüft die Packstation zusätzlich serverseitig. |
| Internationale Adresse | `internationalProfile` | DHL-EU-Profil wird genutzt. |
| Abholung | keines | Kein DHL-Label und keine automatische Versandmail. |
| Fehlende/auffällige Adresse | keines | Ablauf stoppt vor dem DHL-Call. |

## Fehlerverhalten

Ein Fehler am Foto, an der Adresse oder am DHL-Call darf kein zusätzliches DHL-Label erzeugen. Nach bereits erfolgter Chargenzuordnung bleibt der Auftrag `gepackt`; beim nächsten Versuch wird dieselbe Chargenzuordnung durch die Bestellpositions-ID idempotent erkannt. Das bereits gespeicherte Foto bleibt erhalten.

Der Browserdruck ist bewusst nur ein Druckimpuls für das aus dem Benutzerklick geöffnete Label-Fenster. Ein vollständig dialogfreier physischer Druck benötigt einen separat installierten lokalen Druckdienst am Arbeitsplatz. Dieser lokale Schritt darf niemals Einfluss auf die DHL-Erstellung oder die gespeicherten Bestelldaten haben.

## Wartungs- und Testpflicht

Vor jeder Änderung sind mindestens folgende Fälle zu testen: fehlendes Foto, Foto-Upload-Fehler, deutsche Adresse, Packstation, ausländische Adresse, fehlende E-Mail-Adresse, fehlende Telefonnummer, DHL-Fehler, Wiederholung nach DHL-Fehler und bereits vorhandenes DHL-Label. Vor jedem GitHub-Push muss der TypeScript-Check für Backend und Frontend erfolgreich sein.

## Betroffene Module

| Modul | Verantwortung |
|---|---|
| `server/addressValidationRouter.ts` | Gespeicherte DHL-Adresse prüfen und Nachweis schreiben |
| `server/addressValidationService.ts` | Validierungs- und Persistenzlogik |
| `server/purchaseOrderRouter.ts` | Idempotente Chargenzuordnung |
| `server/orderRouter.ts` | Versandstatus und optionale Versand-E-Mail |
| `server/shopSettingsRouter.ts` | Zentrale Packautomationskonfiguration |
| `client/src/pages/WaWiOrders.tsx` | Reihenfolge, Packdialog, DHL-Auslösung, WhatsApp-Öffnung |
| `client/src/lib/railwayApi.ts` | Typisierte API- und Label-Druckschnittstellen |
