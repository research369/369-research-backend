# DHL Label Dokumentation

## Aktive Labels (Production)

| Trackingnummer | Bestellung | Status | Erstellt | Hinweis |
|---|---|---|---|---|
| `00340433929947900024` | 369-10182 (Marko Tole) | **AKTIV** — in DB gespeichert, Tracking bestätigt | 2026-05-27 | Aktives Label, in WaWi/DB unter `shipping_label_content` |

## Inaktive / Zu stornierende Labels

| Trackingnummer | Bestellung | Status | Erstellt | Hinweis |
|---|---|---|---|---|
| `00340433929947900017` | 369-10182 (Marko Tole) | **NICHT GENUTZT** — nicht in DB, nicht in WaWi | 2026-05-27 | Erstes Test-Label, durch Script-Fehler nicht gespeichert. **Später im DHL Geschäftskundenportal stornieren**, sobald es dort sichtbar ist. |

## Stornierung von `00340433929947900017`

Das Label `00340433929947900017` ist aktuell (Stand 2026-05-27) im DHL Geschäftskundenportal noch nicht sichtbar.
Sobald es erscheint, muss es manuell im Portal storniert werden:

1. DHL Geschäftskundenportal öffnen
2. Sendung `00340433929947900017` suchen
3. Stornieren (solange das Paket noch nicht eingescannt wurde)

**Wichtig:** Das Label wurde nie gedruckt und nie einem Paket beigefügt. Es entsteht kein Schaden wenn es nicht storniert wird — es wird einfach nie eingescannt und verfällt automatisch nach 30 Tagen.

## Technische Details

- **API:** DHL Parcel DE Shipping REST API v2
- **Produkt:** V01PAK (DHL Paket, DE national)
- **Billing-Nummer:** `63979135280101`
- **EKP:** `6397913528`
- **Absender:** Core Versand und Logistik, Klingenhagen 31, 48336 Sassenberg, DE
- **Modus:** Production (`DHL_SANDBOX=false`)
- **Label-Format:** PDF (Base64, in DB gespeichert)
- **Tracking-Status:** "Status offen" = normal, solange Paket nicht eingescannt
