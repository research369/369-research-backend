# DHL Paket Schweiz – geprüfte Integrationsvorgaben

Stand: 11. Oktober 2026

- Für DHL Europaket in die Schweiz sind Zoll-EDI-Daten und eine Handelsrechnung erforderlich.
- Bis 1.000 € Warenwert je Packstück: Handelsrechnung in **zweifacher Ausfertigung**. Über 1.000 € oder bei besonderen Beschränkungen ist zusätzlich ein Ausfuhrbegleitdokument (ABD) erforderlich; dieses wird nicht automatisch erzeugt.
- Die Rechnung muss je Packstück u. a. Absender, Empfänger, Exportgrund, Menge, Warenbeschreibung, Warenwert, Gewicht, HS-Code, Ursprungsland, Versandkosten, Versandbedingungen, Rechnungsnummer/-datum und eine Originalunterschrift enthalten. Sie muss Englisch oder in der Sprache des Bestimmungslandes sein.
- Für die gewählte Frankatur DAP zahlt der Absender nur das Paketentgelt; Empfänger zahlt Zollabfertigung, Zölle und Steuern. In der DHL Parcel DE API lautet der Wert `shippingConditions: "DAP"`.
- Die DHL-API-Beispiele für V54EPAK verlangen bei Zollsendungen `exportType`, `shippingConditions`, `postalCharges` sowie je Warenposition `itemDescription`, `packagedQuantity`, `hsCode`, `countryOfOrigin`, `itemValue` und `itemWeight`.
- Das Schweizer Druckpaket enthält in verbindlicher Reihenfolge das DHL-Label sowie die zwei Handelsrechnungs-Kopien. Ein expliziter Klick auf „Druckpaket erstellen & drucken“ öffnet den Druckdialog für alle Seiten; die Handelsrechnung wird zusätzlich als separates PDF revisionssicher bei der konkreten Bestellung abgelegt. Bei mehr als drei Warenpositionen wird jede Rechnung lesbar auf weitere 4×6-Zoll-Seiten fortgesetzt.

## Quellen

1. DHL Paket Deutschland, „DHL Europaket – Einfach durch den Zoll“, Mai 2026: https://www.dhl.de/dam/jcr:12efd54a-2b40-4ffe-8436-c5f32701738c/dhl-europapaket-einfach-durch-den-zoll.pdf
2. DHL Parcel DE Shipping API v2, V54EPAK Customs DAP example, Postman collection: https://developer.dhl.com/sites/default/files/2025-06/pp-parcel-shipping-native_onboarding_collection_1.json
3. DHL Parcel DE Shipping API v2 reference: https://developer.dhl.com/api-reference/parcel-de-shipping-post-parcel-germany-v2?language_content_entity=en
