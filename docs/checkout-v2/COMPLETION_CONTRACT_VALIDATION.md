# Checkout V2 – Abschlussvertrag: lokale Validierung

**Stand:** 4. September 2026
**Geltungsbereich:** Isolierte Checkout-V2-Feature-Branches im kanonischen Backend und Frontend. Kein Deployment, keine Commerce-Staging-Instanz und keine produktive Transaktion wurden ausgeführt.

## Zweck

Der Checkout-V2-Abschluss ist als serverseitiger Adapter vor dem bestehenden WaWi-Bestellkern vorbereitet. Der Browser übermittelt ausschließlich Produktauswahl, Lieferadresse, Code-/Empfehlungsreferenzen, geschützte Sitzungsnachweise sowie einen stabilen Abschluss-Schlüssel. Preise, Versand, automatische Vorteile, Gratispositionen, Partner-/KWK-Regeln, Sichtbarkeit und Verfügbarkeit werden unmittelbar vor der möglichen Bestellpersistenz erneut aus den führenden Serverdaten bestimmt.

> Der Abschlussweg ist standardmäßig geschlossen. Er kann nur in einer ausdrücklich freigegebenen Commerce-Staging-Umgebung verwendet werden und ist weder an die sichtbare Staging-Seite noch an das produktive Backend angebunden.

## Lokale Testbefunde

| Prüfbereich | Ergebnis | Grenze |
|---|---:|---|
| Quote, Preise und sichtbare Artikel | Bestanden | Keine Browserpreise; ausgeblendete Artikel werden abgewiesen. |
| Aktionscode, Partnercode, KWK | Bestanden | Partner- und KWK-Wege bleiben gegenseitig ausgeschlossen. |
| Partner-Eigenbestellung und Guthaben | Bestanden | Partnernummer, Rabatt und Guthaben werden nur aus einer bestehenden geschützten Partnersitzung aufgelöst. |
| 2-für-3 und Gratis-BAC | Bestanden | Regeln werden aus serverseitigen Einstellungen/Katalogdaten erzeugt; Geschenkbestand wird geprüft. |
| Nasenspray-Kit und BAC 10 ml | Bestanden | Nur sieben freigegebene Familien; fehlender BAC-Bestand wird abgewiesen. |
| Privat, Firma, Packstation, Postfiliale | Bestanden | Abholadressen sind auf Deutschland begrenzt und bei Kühlversand gesperrt. |
| Aggregierter Bestand | Bestanden | Bezahlte und Gratispositionen derselben Variante werden vor WaWi-Abzug zusammengeführt. |
| Idempotenz | Bestanden | Checkout V2 benötigt einen stabilen Abschluss-Schlüssel; die WaWi-Transaktion verwendet eine dedizierte Advisory-Lock-Grenze. |
| Fail-closed | Bestanden | Quote und Abschluss sind ohne beide expliziten Commerce-Staging-Flags vor jedem Datenbankzugriff gesperrt. |
| Externe Kommunikation im Test | Bestanden | Bei `CHECKOUT_V2_TEST_MODE=true` unterdrückt ausschließlich der serverseitige Checkout-V2-Adapter Bestätigungs-E-Mails; der Altcheckout bleibt unverändert. |
| Backend-Vertragstests | **31/31 bestanden** | Rein lokal, feste Testdaten, keine Datenbankverbindung. |
| Frontend-Typecheck und Produktionsbuild | Bestanden | Die neue Route, Abschlussmutation und Lieferarten kompilieren im Feature-Branch. |

## TypeScript-Abgrenzung

Der vollständige Backend-Typecheck enthält weiterhin bekannte Diagnosen außerhalb der Checkout-V2-Dateien. Die gefilterte Prüfung ergab **keine Diagnosen** in `checkoutV2*`, `orderRouter`, `partnerRouter`, `storeSource` oder `emailService`.

## Noch gesperrte Schritte

Der Abschlussvertrag bleibt bis zum separaten Commerce-Staging vollständig gesperrt. Vor einer technischen Freigabe fehlen weiterhin eine eigene Testdatenbank, ein separates Backend-Service-Deployment, eine eigene Commerce-Staging-URL und ein rein testbarer Payment-Adapter. Es dürfen keine Produktionsdatenbank, Bankdaten, Zahlungsprovider-Credentials, DHL-Zugänge oder echten Kunden-/Bestelldaten in diese Umgebung übernommen werden. In Commerce-Staging muss `CHECKOUT_V2_TEST_MODE=true` gesetzt sein; dadurch sind ausgehende Bestätigungs-E-Mails im neuen Abschlussweg serverseitig unterdrückt.

## Rückfall

Der bestehende Checkout unter `/checkout` wurde nicht verändert. Die neue Frontendroute bleibt `/checkout-v2`; ohne `VITE_CHECKOUT_V2_API_BASE` ist sie sichtbar, aber nicht kaufbar. Ein Backend- oder Frontend-Feature-Branch wird erst nach Commerce-Staging-Abnahme und einer separaten Freigabe gegen `main` vorgeschlagen.

## Vor GitHub-Sicherung zu prüfen

1. Nur Checkout-V2-Quell-, Test- und Dokumentationsdateien sind gestaged.
2. Beide Feature-Branches bauen bzw. testen lokal wie oben dokumentiert.
3. Der Branch wird in Primär- und unabhängiges Backup-Repository gespiegelt.
4. Es wird kein GitHub-Commerce-Staging-Workflow ausgelöst.
5. Es wird nichts nach `main` gemergt und kein Deployment gestartet.
