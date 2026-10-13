# DHL Paket International in die Schweiz – geprüfte Integrationsvorgaben

Stand: 12. Oktober 2026

## Vertrag und DHL-Produkt

- Die hinterlegte Abrechnungsnummer ist im DHL-Geschäftskundenportal als **DHL Paket International** geführt. Sie wird deshalb ausschließlich mit dem API-Produkt `V53WPAK` verwendet.
- `V54EPAK` ist **DHL Europaket** und darf nicht mit der Paket-International-Abrechnungsnummer kombiniert werden.
- Für die Schweiz gilt die Frankatur **DAP**: 369 Research zahlt das Paketentgelt; Schweizer Einfuhrabgaben und die Zollabfertigung trägt der Empfänger. `shippingConditions` wird nicht im `V53WPAK`-Zollpayload übermittelt, weil DHL dieses Feld ausschließlich für V54 dokumentiert. DAP steht sichtbar auf der Handelsrechnung.

## Verbindliche Papierunterlagen je Packstück

DHL verlangt bei DHL Paket International für jedes einzelne Packstück:

1. das **DHL-Label** im Thermalformat 100 × 150 mm (**Hochformat**),
2. die von DHL erzeugte **Zollinhaltserklärung CN23**,
3. die **Handelsrechnung in zweifacher Ausfertigung** im A4-Format.

Die CN23 wird nicht nachgebildet: DHL generiert sie aus den übermittelten Zolldaten und liefert sie als separates `customsDoc` zurück. Die WaWi erzeugt daraus für den vorhandenen Thermodrucker einen dreiseitigen 100×150-mm-**Hochformat**-Drucksatz: **Paketmarke, linke CN23-Hälfte, rechte CN23-Hälfte**. Der Zuschnitt erfolgt ausschließlich an der vertikalen Mitte der originalen DHL-CN23; es werden keine Inhalte, Barcodes oder Felder neu geschrieben. Eine horizontale Teilung würde die 210-mm-breite Formularhälfte auf ein nur rund 35-mm-hohes Etikett verkleinern und ist deshalb nicht zulässig.

Für Tests mit einer DHL-Onlinefrankierung auf einem A4-Trägerblatt erkennt der Druckdienst die obere Paketmarkenhälfte automatisch und dreht sie einmal in das gleiche 100×150-mm-Hochformat. Echte DHL-API-Labels im Format `910-300-400` werden ohne Zuschnitt übernommen.

Zusätzlich speichert die WaWi die zwei Handelsrechnungen revisionssicher als separates A4-PDF. Sie werden nicht automatisch geöffnet und nicht in das Thermoformat gedrückt. Für die physische Zollabwicklung sind sie bei Bedarf packstückindividuell in der transparenten Zolldokumententasche außen am Paket zu befestigen.

Die drei Zollunterlagen werden außen am Packstück in einer selbstklebenden, transparenten Zolldokumententasche angebracht. Bei Warenwert über 1.000 EUR oder bei besonderen Ausfuhrvorgaben ist zusätzlich ein Ausfuhrbegleitdokument (ABD) erforderlich; die WaWi blockiert die automatische Buchung bewusst und erzeugt kein ABD.

## Pflichtdaten und technische Regel

- Zolldaten sind vor der DHL-Buchung explizit zu erfassen: englische Warenbeschreibung, Menge, Gewicht und Warenwert pro Position sowie tatsächliches Paketgewicht.
- HS-Code und Ursprungsland sind für eine DHL-API-Warenposition ausdrücklich optional. Die WaWi zeigt und verlangt sie deshalb nicht; falls sie später gezielt ergänzt werden, werden sie nur validiert und niemals aus Produktnamen abgeleitet oder durch Platzhalter ersetzt.
- Die DHL-API erhält für V53WPAK `exportType`, `postalCharges` und die positionsbezogenen Warenwerte.
- Die DHL API gibt die CN23 für `V53WPAK` als separates Dokument zurück. Falls nach der realen DHL-Buchung keine CN23 abrufbar ist, wird kein scheinbar vollständiges Druckpaket gespeichert; der bestehende Duplikatschutz bleibt aktiv, damit nicht versehentlich ein zweites Label erzeugt wird.
- Das neue DHL-Feature „Paperless Customs“ ist laut API nur in Sandbox verfügbar, nicht in Produktion. Deshalb bleiben die physischen Unterlagen Teil dieses Produktionsablaufs.

## Quellen

1. DHL, [Merkblatt zur Ausfuhr von Waren – DHL Paket International](https://www.dhl.de/dam/jcr:440cb199-a284-4c1c-ae2c-caf64329baa2/dhl-paket-international-merkblatt-zoll-042024.pdf)
2. DHL, [Zolldatenanforderungen](https://www.dhl.de/dam/jcr:afc09a9f-c2e7-4bd7-928c-abd8cf7bbec3/dhl-gk-zolldatenanforderung-072025-de.pdf)
3. DHL, [Parcel DE Shipping API v2.2.0](https://developer.dhl.com/api-reference/parcel-de-shipping-post-parcel-germany-v2?language_content_entity=en)
4. DHL, [OpenAPI-Spezifikation v2.2.0](https://developer.dhl.com/sites/default/files/2026-10/parcel-de-shipping-v2_2.yaml)
