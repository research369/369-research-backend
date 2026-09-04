# Checkout V2 – GitHub Commerce-Staging-Vertrag

**Status:** Vorbereiteter Releasepfad, noch nicht ausgelöst.

## Zweck und Grenze

Checkout V2 wird über den manuellen GitHub-Workflow `.github/workflows/checkout-v2-commerce-staging.yml` erst dann in eine **eigene** Commerce-Staging-Umgebung übertragen, wenn der Branch vollständig geprüft ist. Ein Push auf einen Branch ist ausdrücklich **kein** Deployment. Der Workflow reagiert nicht auf `push`, `pull_request` oder `main`, sondern ausschließlich auf eine manuelle Auslösung mit der exakten Bestätigung `COMMERCE_STAGING_ONLY`.

> Die Commerce-Staging-Umgebung ist kein Ersatz für Produktion und darf weder dieselbe Datenbank noch dieselben Zahlungs-, Versand-, E-Mail-, Bank- oder Provider-Zugangsdaten verwenden.

## GitHub-Umgebung

Im Backend-Repository wird ausschließlich die GitHub-Environment `checkout-v2-commerce-staging` verwendet. Sie enthält nur die für das getrennte Backend-Staging benötigten Werte.

| Typ | Name | Regel |
|---|---|---|
| Environment Secret | `RAILWAY_COMMERCE_STAGING_TOKEN` | Projekt-Token nur für das separate Staging-Environment; niemals ein Produktions- oder Konto-Token |
| Environment Variable | `RAILWAY_COMMERCE_STAGING_PROJECT_ID` | Kennung des separaten Railway-Projekts |
| Environment Variable | `RAILWAY_COMMERCE_STAGING_ENVIRONMENT` | Muss ein nicht-produktiver Environment-Name sein; `production` wird im Workflow abgewiesen |
| Environment Variable | `RAILWAY_COMMERCE_STAGING_SERVICE` | Ausschließlich der explizite Backend-Service für Checkout V2 |

Die GitHub-CLI kann Secretwerte nicht auslesen und speichert sie nicht im Repository. Fehlen Werte, bricht der Workflow vor einem Deployment ab.

## Unveränderliche Servergrenzen

Die Commerce-Staging-Umgebung setzt zusätzlich ausschließlich diese nicht geheimen Schutzflags:

| Variable | Erlaubter Wert | Bedeutung |
|---|---|---|
| `CHECKOUT_V2_COMMERCE_STAGING` | `true` | Schaltet den V2-Quote-Endpunkt nur in der isolierten Umgebung frei |
| `FEATURE_CHECKOUT_V2_ENABLED` | `true` | Zweite, unabhängige Feature-Freigabe |
| `FRONTEND_URL` | Eigene Commerce-Staging-URL | Keine Produktionsdomain als CORS-Quelle |
| `DATABASE_URL` | Eigene Testdatenbank | Keine Produktions-WaWi-Datenbank |
| `BUNQ_API_KEY` | Leer | In Commerce-Staging nicht zulässig |
| `DHL_SANDBOX` | `true` | Keine produktive Versandlabel-Erzeugung |
| E-Mail-/Provider-Keys | Leer | Bis zum getrennten Testadapter nicht zulässig |

## Manuelle Auslösung

Der Workflow darf erst ausgeführt werden, wenn die Testfälle erfolgreich, die Frontend- und Backend-Branches abgeglichen und die separate Umgebung mit Testdaten erstellt ist. Als Input wird der exakte Backend-Branch oder Commit angegeben. Der Workflow testet zuerst die Quote-Grenzen und bricht ab, wenn die Bestätigung oder eine Stagingvariable fehlt.

Der Workflow selbst erzeugt keine Datenbank, kopiert keine Produktionsvariablen und führt keine Migrationen aus. Er überträgt nur den bereits getesteten Backend-Featurestand an den explizit benannten Staging-Service.

## Rückfall

Ein fehlgeschlagener Workflow verändert weder `main` noch das bestehende Live-Deployment. Jeder Staging-Deploymentstand ist über seinen GitHub-Commit, den manuellen Workflowlauf und die bestehenden Backend-/Frontend-Rückfalltags nachvollziehbar. Für den späteren Rückfall darf ausschließlich der zuvor geprüfte Staging-Commit erneut ausgerollt werden.

## Offene Vorbedingung

Die GitHub-Umgebung ist vorbereitet, aber ein echtes, separates Railway-Projekt und eine Testdatenbank sind noch nicht bestätigt. Deshalb bleibt der Workflow bis zur bewussten, späteren Auslösung inaktiv. Ein Deployment ohne diese Isolation ist ausdrücklich verboten.

## Referenzen

[1]: https://docs.railway.com/cli/deploying "Railway – Deploying with the CLI"
[2]: https://docs.railway.com/environments "Railway – Environments"
[3]: https://docs.railway.com/deployments/github-autodeploys "Railway – Controlling GitHub Autodeploys"
