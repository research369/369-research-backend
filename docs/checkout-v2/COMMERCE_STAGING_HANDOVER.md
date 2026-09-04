# Checkout V2 – Commerce-Staging: GitHub-Übergabecheckliste

**Stand:** 4. September 2026
**Geltungsbereich:** Ausschließlich die GitHub-Umgebung `checkout-v2-commerce-staging` und ein davon getrenntes Backend-/Datenbank-Ziel. Diese Checkliste aktiviert nichts selbst und enthält keine Zugangsdaten oder Infrastrukturwerte.

## Ziel

Commerce-Staging ist die erste Umgebung, in der Checkout V2 gegen **ausschließlich isolierte Testdaten** Angebots- und Bestellverträge testen darf. Sie ist weder die bestehende sichtbare Netlify-Staging-Seite noch das produktive Backend oder die reale WaWi.

> Ein Start von Commerce-Staging ist nur zulässig, wenn Backend-Service, Datenbank, CORS-Ziel und alle Sicherheitsflags nachweislich isoliert sind. Es darf kein Zugriff auf Produktionsdaten, Live-Zahlungen, echte Versandkonten oder reale Kundenkommunikation möglich sein.

## GitHub-Umgebung

| Einstellung | Sollwert | Zweck |
|---|---|---|
| Repository | `research369/369-research-backend` | Enthält den geschützten Backend-Workflow. |
| GitHub Environment | `checkout-v2-commerce-staging` | Secrets und Variablen sind ausschließlich dieser Umgebung zuzuordnen. |
| Branch-Policy | Nur `feat/checkout-v2-commerce-contract` | Verhindert Deploys aus `main`, anderen Branches oder beliebigen Commits. |
| Workflow | `Checkout V2 Commerce Staging` | Ausschließlich `workflow_dispatch`; kein Push- oder Merge-Trigger. |
| Manuelle Bestätigung | Exakt `COMMERCE_STAGING_ONLY` | Der Workflow bricht bei abweichendem Wert vor einem Deploy ab. |
| Parallelität | Ein Lauf zugleich | Verhindert überlappende Staging-Deploys. |

## GitHub Environment: Werte nur als Namen

Die folgenden Werte werden erst bei vorhandenem separatem Commerce-Staging-Ziel im GitHub-Environment hinterlegt. Ihre tatsächlichen Inhalte gehören **nie** in ein Repository, einen Branch, ein Ticket oder eine Nachricht.

| GitHub Environment-Feld | Art | Muss auf zeigen | Darf nicht zeigen auf |
|---|---|---|---|
| `RAILWAY_COMMERCE_STAGING_TOKEN` | Secret | Nur das getrennte Commerce-Staging-Projekt | Produktion, allgemeine Organisationstoken oder mehrere Projekte |
| `RAILWAY_COMMERCE_STAGING_PROJECT_ID` | Variable | Nur das Commerce-Staging-Projekt | Produktionsprojekt |
| `RAILWAY_COMMERCE_STAGING_ENVIRONMENT` | Variable | Ein isoliertes Nicht-Produktions-Environment | `production` |
| `RAILWAY_COMMERCE_STAGING_SERVICE` | Variable | Nur den Checkout-V2-Backend-Service | Gemeinsamen Live-Backend-Service |

Der GitHub-Workflow verweigert einen Lauf ohne alle vier Felder und verweigert den Namen `production` explizit.

## Backend-Service: erforderliche nicht-produktive Konfiguration

Die folgenden serverseitigen Werte werden **im getrennten Backend-Service**, niemals im Frontend, hinterlegt. Werte sind absichtlich nicht Teil dieses Dokuments.

| Backend-Konfiguration | Erforderlicher Zustand in Commerce-Staging |
|---|---|
| `DATABASE_URL` | Neue, separate Testdatenbank; keine Kopie mit echten Kundendaten. |
| `FEATURE_CHECKOUT_V2_ENABLED` | `true` – öffnet nur den neuen Featurepfad. |
| `CHECKOUT_V2_COMMERCE_STAGING` | `true` – bestätigt ausschließlich die Commerce-Staging-Grenze. |
| `CHECKOUT_V2_TEST_MODE` | `true` – unterdrückt für Checkout V2 ausgehende Bestätigungs-E-Mails. |
| `FRONTEND_URL` | Ausschließlich eigene Commerce-Staging-Frontend-URL. |
| `RESEND_API_KEY` | Nicht setzen. |
| `BUNQ_API_KEY` | Nicht setzen. |
| DHL-/Versandzugänge | Nicht setzen; keine Labelerstellung oder Versandautomation im Test. |
| Produktions-/Admin-Zugänge | Nicht übernehmen. |

## Testdatenvertrag

| Bereich | Erlaubt | Verboten |
|---|---|---|
| Artikel | Synthetische Testartikel und fest dokumentierte Varianten | Reale Lagerbestände oder unverfälschte Produktionsartikel |
| Preise/Aktionen | Feste Testszenarien für Codes, 2-für-3, Gratis-BAC und Versand | Live-Aktionen oder echte Rabattnutzung |
| Kunden/Adressen | Synthetische Identitäten und Testadressen | Reale Kunden-, Partner-, Empfehlungs- oder Bestelldaten |
| Partner/KWK | Statische Testkonten und Testledger | Produktive Partnerguthaben oder echte Provisionsdaten |
| Bestellungen | Ausschließlich als Testbestellungen in der Testdatenbank | Jede Produktionsbestellung oder Bestandsbuchung |
| Payment | Kontrollierter Testadapter erst nach späterer Freigabe | Live-Zahlung, Kontozugang oder Zahlungswebhook |

## Sichere Auslösefolge

1. In GitHub wird überprüft, dass `checkout-v2-commerce-staging` ausschließlich den Checkout-V2-Feature-Branch zulässt.
2. Die vier GitHub-Environment-Felder werden mit dem **separaten** Ziel hinterlegt; keine Werte werden in Quellcode kopiert.
3. Im separaten Backend-Service werden die drei Checkout-V2-Flags, eine getrennte Testdatenbank und eine eigene Frontend-URL gesetzt.
4. Der Contract-CI-Workflow muss auf dem Zielcommit erfolgreich sein.
5. Erst dann darf `Checkout V2 Commerce Staging` manuell mit `COMMERCE_STAGING_ONLY` gestartet werden.
6. Nach dem Deploy wird zuerst die Quote gegen synthetische Testdaten geprüft. Der Abschluss bleibt gesperrt, bis alle Quote-/Adress-/Code-/Partner-/KWK-/Gratis-/Kit-Tests bestanden sind.
7. Erst nach erfolgreicher Abschlussprüfung wird ein noch nicht konfigurierter Payment-Testadapter einzeln ergänzt.

## Harte Sperren

* `main` ist kein zulässiger Deploy-Ref für Commerce-Staging.
* Der bestehende Checkout unter `/checkout` wird nicht ersetzt.
* Die sichtbare Netlify-Staging-Domain wird nicht für Commerce-Staging verwendet.
* Ein fehlendes oder ungültiges Feld führt zum Workflowabbruch; es gibt keine Fallback-URL und keinen Produktionsfallback.
* Ein späterer Livegang benötigt einen neuen, separaten Freigabeprozess.

## Abnahme vor erstem manuellen Workflow-Start

| Prüfung | Erwartung |
|---|---|
| GitHub Environment | Beschränkt auf den Checkout-V2-Backend-Branch. |
| CI | Vertragsworkflow auf Zielcommit erfolgreich. |
| Environment-Variablen | Vollständig und nachweislich nicht produktiv. |
| Backend-Flags | Alle drei Checkout-V2-Flags aktiv, Testmodus aktiv. |
| Datenbank | Isoliert und ausschließlich mit synthetischen Daten befüllt. |
| Externe Dienste | E-Mail, Payment, Bank, DHL und Fulfillment deaktiviert. |
| Rollback | Commit-/Tag-Referenzen und alter Checkout unverändert vorhanden. |

Erst wenn jede Zeile bestanden ist, kann ein GitHub-Workflow als **Commerce-Staging-Testdeploy** gestartet werden. Die Ausführung erfordert anschließend erneut eine explizite Bestätigung.
