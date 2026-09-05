# Checkout V2 – Commerce-Staging-Verfügbarkeit

**Stand:** rein lesende Infrastrukturprüfung, keine Änderung ausgeführt.

## Ergebnis

Für Checkout V2 existiert aktuell **keine bestätigte, getrennte Commerce-Staging-Umgebung** im Arbeitskontext. Die vorhandene Connector-Inventur enthält keine Railway-Verbindung. Das Railway-Dashboard wurde ausschließlich lesend geöffnet, stellte jedoch keinen verlässlich auswertbaren Projekt- oder Datenbankbestand bereit. Deshalb wurde weder ein Projekt ausgewählt noch eine Variable, Datenbank oder ein Deployment verändert.

## Konsequenz

Die Checkout-V2-Branches bleiben vollständig fail-closed:

| Komponente | Aktueller Schutz |
|---|---|
| Backend `checkoutV2.quote` | Ohne beide expliziten Commerce-Staging-Flags gesperrt |
| Frontend `CheckoutV2` | Ohne eigene Commerce-Staging-Basis-URL nicht kaufbar |
| Staging-Shop | Keine Anbindung an den neuen Checkout-V2-Endpoint |
| Produktions-WaWi | Keine Prüfung, Bestellung, Reservierung oder Bestandsbewegung möglich |
| Payment | Nicht integriert |

## Vorbedingung für Commerce-Staging

Vor einem technischen Deployment wird ausschließlich eine **eigene** Umgebung benötigt: ein separater Backend-Service, eine davon getrennte Datenbank, ein eigener Frontend-Preview und bewusst gesetzte nicht geheime Staging-Flags. Es dürfen keine Produktionsdatenbank, keine Produktivdomain, keine Bunq-/DHL-/E-Mail-/Provider-Zugangsdaten und keine Zahlungswebhooks in diese Umgebung übernommen werden.

Bis diese isolierte Umgebung nachweislich verfügbar ist, bleiben die Feature-Branches der richtige Arbeits- und Rückfallstand. Kein Checkout-V2-Code darf gegen `main` gemergt oder auf eine bestehende Shopdomain veröffentlicht werden.
