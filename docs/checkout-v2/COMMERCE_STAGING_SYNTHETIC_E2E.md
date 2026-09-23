# Checkout V2 – Isoliertes Commerce-Staging: Bootstrap und synthetische Validierung

## Zweck und Sicherheitsgrenze

Dieses Verfahren initialisiert und prüft Checkout V2 ausschließlich im privaten Railway-Environment `commerce-staging`. Es ist **kein** Produktionsmigrationsweg und darf weder mit dem Hauptshop noch mit WaWi-, Zahlungs-, DHL-, Resend- oder Kundendaten verbunden werden. Die Ausführung ist nur mit den fest gesetzten Staging-Gates zulässig. Eine fehlende oder abweichende Variable beendet den Pre-Deploy-Schritt vor einer Schema- oder Datenmutation.

| Kontrollpunkt | Erwarteter Wert / Verhalten |
|---|---|
| `CHECKOUT_V2_COMMERCE_STAGING` | Muss `true` sein |
| `FEATURE_CHECKOUT_V2_ENABLED` | Muss `true` sein |
| `CHECKOUT_V2_TEST_MODE` | Muss `true` sein; Bestell-E-Mails werden im Abschlussadapter unterdrückt |
| Railway-Environment | Wenn Railway-Metadaten vorhanden sind: ausschließlich `commerce-staging` |
| Railway-Service | Wenn Railway-Metadaten vorhanden sind: ausschließlich `checkout-v2-commerce-staging-backend` |
| Datenbankziel | Ohne verifizierte Railway-Identität nur bei eindeutigem Staging-Marker oder einer exakten, expliziten lokalen Allowlist |
| Öffentliche Erreichbarkeit | Keine Domain erforderlich oder vorgesehen |

Die Railway-Konfiguration in `railway.json` legt einen einzelnen Pre-Deploy-Runner fest. Der Runner selbst ist fail-closed auf `commerce-staging` und den dort erwarteten Service gebunden; auf jedem anderen Ziel endet er vor einer Datenmutation. Der Bootstrap und der Smoke-Test laufen damit als Railway Pre-Deploy-Schritte im privaten Netzwerk. Ein Fehler verhindert den Service-Start.

> Am 23. September 2026 wurde der erste Lauf mit einer TOML-Environment-Override-Konfiguration zwar von Railway als Deployment angenommen, aber ohne übernommenen Pre-Deploy-Schritt gestartet. Die dadurch entstandene leere Testdatenbank führte nur im isolierten Service zu erwarteten „Tabelle fehlt“-Startfehlern. Die Quelle verwendet deshalb die von Railway dokumentierte JSON-Manifestform mit einem einzelnen, im Deployment sichtbaren Pre-Deploy-Kommando. Es wurden weder Produktionsdaten noch externe Integrationen berührt.

## Warum Schema-Push statt historischer Replay-Migration

Die historische Drizzle-Migrationsreihe ist für die bestehende WaWi-Datenbank gewachsen und nicht vollständig auf eine leere Datenbank replaybar: Die lokale Frischdatenbankprüfung hat kollidierende historische Enum-Erzeugungen in der Folge offengelegt. Es werden deshalb keine historischen Dateien verändert und keine Produktionsmigrationen umgeschrieben.

Für die neue, leere Commerce-Staging-Datenbank erstellt `checkout-v2-commerce-staging-bootstrap.ts` das aktuelle deklarative Drizzle-Schema per `drizzle-kit push`. Danach prüft es die für Checkout V2 erforderlichen Tabellen und erzeugt lediglich die isolierte, kollisionssichere Sequenz `checkout_v2_order_id_sequence` inklusive der Funktion `next_order_id()`. Die Haupt-WaWi-Datenbank wird bei diesem Ablauf nie adressiert.

## Synthetischer Smoke-Test

`checkout-v2-commerce-staging-smoke.ts` legt ausschließlich klar gekennzeichnete Datensätze mit `SYNTH-`-SKU bzw. `synthetic.*@example.invalid` an. Vor jedem Lauf werden nur vorherige Datensätze mit genau diesen Markern zurückgesetzt. Es werden keine Produkt-, Preis-, Bestands-, Kunden- oder Auftragsdaten aus der Produktion importiert oder gelesen.

Der Test prüft serverseitig folgende Punkte:

| Prüffall | Erwartung |
|---|---|
| Sichtbares Produkt / serverseitiger Preis | Preis, Versand und Summe kommen ausschließlich aus dem Katalog, nicht aus dem Browser |
| Verstecktes Produkt und Fehlbestand | Beide werden vor einem Abschluss abgewiesen |
| Aktionscode und automatische Vorteile | `SYNTH-PROMO10`, 2-für-3 und Gratis-BAC werden aus serverseitigen Einstellungen bestimmt |
| Partner/KWK-Ausschluss | Ein gültiger synthetischer Partnerweg zusammen mit einem gültigen synthetischen Empfehlungsweg wird abgewiesen |
| DIY-Nasenspray-Kit | Der zulässige Produktweg erhält ausschließlich den serverseitigen Kit-Aufpreis; die BAC-Komponente wird geprüft |
| Kühlkette | Kühlpflichtige Auswahl an Packstation wird abgewiesen; eine Hausadresse ist nötig |
| Abschluss, Idempotenz und Lieferwege | Zwei identische Abschlüsse mit demselben Schlüssel erzeugen genau eine isolierte Bestellung und einen einmaligen Bestandsabzug; zusätzlich werden Haus-/Firmenadresse, Packstation und Postfiliale mit synthetischen Daten geprüft |
| Externe Effekte | `CHECKOUT_V2_TEST_MODE=true` unterdrückt die Bestellbestätigung; der Ablauf aktiviert keine Payment-, DHL-, Resend- oder WaWi-Integration |

Der vollständige Abschlusslauf ist bewusst auf **vier** deterministische, synthetische Bestellungen begrenzt: eine idempotente Hauslieferung sowie je ein separater Test für Packstation, Postfiliale und Firmenadresse. Sie verbleiben in der isolierten Datenbank und enthalten keine realen Personen- oder Produktdaten.

## Lokale Nachweise vor Staging-Deployment

Vor der Aufnahme in den Feature-Branch wurde gegen eine neu erzeugte lokale PostgreSQL-16-Datenbank geprüft:

1. isolierter Schema-Bootstrap,
2. synthetischer Quote- und Abschlusslauf,
3. Idempotenz- und Bestandsprüfung,
4. Start des Backends mit leeren Integrationsschlüsseln und deaktiviertem Backup-Scheduler,
5. bestehende Checkout-V2-Contract-Suite mit 32 von 32 erfolgreichen Tests.

Die lokale Prüfung ersetzt nicht den Railway-Nachweis. Erst nach einem erfolgreichen, explizit freigegebenen Deployment sind Railway-Pre-Deploy-Log und private Service-Health als Staging-Evidenz zu dokumentieren.

## Ausführung und Rückfall

Der geprüfte Weg bleibt der manuelle GitHub-Workflow `Checkout V2 Commerce Staging` auf `main`, der eine explizit angegebene Feature-Commit-SHA verarbeitet. Direktes `railway up` außerhalb dieses Workflows ist nicht zulässig. Bei einem Pre-Deploy-Fehler startet Railway den neuen Service nicht; der vorherige Stand bleibt verfügbar. Funktionaler Checkout-V2-Code bleibt bis zum erfolgreichen Staging-Nachweis im Feature-Branch und wird nicht deshalb nach `main` übernommen, um ein Deployment zu erzwingen.
