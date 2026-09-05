# Checkout V2 – Abdeckungsmatrix Altshop/WaWi

**Status:** technische Arbeitsgrundlage, nicht ausgerollt
**Geltungsbereich:** Checkout-V2-Feature-Branch; keine Produktivverbindung oder Zahlung

## Grundsatz

Checkout V2 ist **keine zweite Warenwirtschaft**. Die Oberfläche übermittelt ausschließlich Auswahl, Identität, Lieferweg und bestätigte Kundeneingaben. Preis, sichtbare Artikel, Varianten, Lager, Versand, Aktionen, Codeberechtigung, Partner- und Empfehlungszuordnung sowie jede wirtschaftliche Buchung entstehen ausschließlich serverseitig aus den führenden WaWi-Daten.

| Vertragsbereich | Führende Altshop-/WaWi-Quelle | Checkout V2 – Quote | Checkout V2 – späterer Bestellabschluss | Status |
|---|---|---|---|---|
| Shopfreigabe und aktive Artikel | `articles.is_active`, `articles.shop_visible` | Server prüft beides vor jeder Quote | Erneute Prüfung vor Bestellanlage | Implementiert im Quote, Abschluss noch offen |
| Artikelpreis, Variantenpreis, Salepreis | `articles`, Variantenvertrag | Serverseitig berechnet; Browserpreis wird ignoriert | Erneut serverseitig berechnen | Implementiert im Quote, Abschluss noch offen |
| Menge und normaler Artikelbestand | `articles.stock` | Lesende Vorschau auf Verfügbarkeit | Atomare Bestandsprüfung und Abzug erst bei Bestellabschluss | Quote implementiert, Abschluss noch offen |
| Nasenspray-Kit und BAC-Wasser 10 ml | `shop_settings`, `articles.stock` | Berechtigung, Aufpreis und BAC-Verfügbarkeit serverseitig | Erneute atomare Prüfung; nur BAC-Wasser wird pro Kit abgebucht | Quote implementiert, Abschluss noch offen |
| Lieferland, Basisversand und Kühlversand | Führende Versandhilfen | Serverseitig berechnet | Erneut serverseitig berechnen | Implementiert im Quote, Abschluss noch offen |
| Privatadresse, Firma und Packstation | Bestehender Customer-/Adressvertrag | Formzustand und Packstationsgrenze; keine Adressbuchung | Vollständige Validierung und Speicherung erst beim Abschluss | Quotegrenze implementiert, Abschluss noch offen |
| Aktions-/Rabattcodes | `promo_codes` | Laufzeit, Aktivstatus, Mindestwert, Restriktionen und Versandvorteil serverseitig | Verbrauch und Zählung erst beim Abschluss, idempotent | Quote implementiert, Abschluss noch offen |
| Partnercode | `partners` und bestehender Partnervertrag | Partnerstatus, Kundenvorteil und bestehende Erstbestellungsregel serverseitig | Partnerzuordnung und Vergütung ausschließlich im Bestellvertrag | Quote implementiert, Abschluss noch offen |
| Kundenwerben-Kunden-Link | `kwk_accounts`, `orders` | Link, Selbstwerbung, E-Mail-/Telefonregel und Neukundenstatus serverseitig | Finale parallelsichere Neubewertung und spätere Gutschrift | Quote implementiert, Abschluss noch offen |
| KWK-Guthaben | KWK-Authentifizierung und Ledger | Erst nach geschützter Sitzung als serverseitig ermittelter Wert | Idempotente Einlösung ausschließlich im Bestellabschluss | Vertrag vorbereitet, UI-/Abschlussanbindung offen |
| Partnerguthaben | Partnerauthentifizierung und Ledger | Erst nach geschützter Sitzung als serverseitig ermittelter Wert | Idempotente Einlösung ausschließlich im Bestellabschluss | Vertrag vorbereitet, UI-/Abschlussanbindung offen |
| 2-für-3-Aktion | `shop_settings` und berechtigte Artikel | Muss als serverseitig ermittelte Gratispositionsvorschau ergänzt werden | Gratispositionen erneut und verbindlich erzeugen | Noch offen – bewusst nicht clientseitig kopiert |
| Gratis-BAC-Wasser 3 ml | zentrale Altshop-Beigabenregel | Muss aus WaWi-Artikelattributen serverseitig ermittelt werden | Gratispositionen erneut und verbindlich erzeugen | Noch offen – bewusst nicht clientseitig kopiert |
| Bundle-/Gratisartikelregeln | Bundle- und Aktionsvertrag | Muss serverseitig gelesen werden | Nur der Server erzeugt berechtigte Gratispositionen | Noch offen |
| QR-/Kampagnenzuordnung | erstes eigenes QR-Token | Opaques Token weiterreichen, keine Kampagnen-ID vertrauen | Bestehende Serverauflösung im Abschluss verwenden | Abschlussanbindung offen |
| Bestellnummer und Idempotenz | vorhandener `order.create`-Vertrag | Keine wirtschaftliche Aktion | Neuer Abschlussadapter muss die vorhandene atomare Bestellanlage nutzen | Noch offen |
| Zahlung und Zahlungsstatus | späterer Provider-Adapter, danach WaWi-Status | Keine Zahlung | Signierte Webhookbestätigung und nur einmalige Statusfolgen | Bewusst geschlossen |

## Nicht verhandelbare Implementierungsreihenfolge

Zuerst werden die vier offenen **wirtschaftlichen Vertragsbereiche** – automatische Aktionen, Gratisbeigaben, Partner-/KWK-Guthaben und idempotenter Bestellabschluss – serverseitig vervollständigt. Erst danach darf Checkout V2 einen Warenkorb in eine reale Bestellung überführen. Die Zahlungsanbindung bleibt bis zu einem separat freigegebenen Testanbieter geschlossen.

Die Funktion `shopSettings.getPromo2for3` wird nicht als Quote-Quelle wiederverwendet, weil sie bei Ablauf selbst in Einstellungen schreibt. Checkout V2 benötigt stattdessen eine lesende Auswertung derselben Werte. So bleibt eine Quote wirklich ohne Seiteneffekt.

## Release-Sperre

Solange mindestens eine Zeile mit **„offen“** gekennzeichnet ist, darf die Checkout-V2-Route weder als Standardcheckout noch auf einer produktiven Domain aktiviert werden. Der bestehende Checkout bleibt bis zu einer vollständigen Abnahme der operative Rückfallweg.
