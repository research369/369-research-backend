# Checkout V2 – Review-, Release- und Rückfallstatus

**Stand:** 5. September 2026
**Status:** Quell- und Contract-Reviewbasis vollständig geprüft. Weiterhin nicht mergen, nicht deployen und nicht für reale Aufträge, Zahlungen oder Lagerbewegungen verwenden.

## Zweck

Dieses Dokument verbindet die getrennten Backend- und Frontend-Arbeiten für Checkout V2. Es ist die verbindliche Referenz, bevor ein Commerce-Staging-Testdeploy überhaupt erwogen wird.

> Checkout V2 ersetzt weder den bestehenden Checkout noch den führenden WaWi-/Altshop-Vertrag. Er übernimmt die Kundensicht und fragt alle wirtschaftlich relevanten Werte ausschließlich serverseitig ab.

## Geschützte GitHub-Reviewbasis

| Komponente | Repository und Branch | Commit | Draft-PR | Status |
|---|---|---|---|---|
| Serverseitiger Quote-/Abschlussvertrag | `research369/369-research-backend` · `feat/checkout-v2-commerce-contract` | `aaa5dcb193fa8b9ab20cb44b48242ae96cdac1df` | [#12](https://github.com/research369/369-research-backend/pull/12) | Offen, Draft, kein Merge |
| Checkout-V2-Oberfläche | `research369/369-research-frontend` · `feat/checkout-v2-commerce-ui` | `954a565e61b2c6016cff004f828f1e14976d879f` | [#13](https://github.com/research369/369-research-frontend/pull/13) | Offen, Draft, kein Merge |
| Bestehender Backend-Main | `research369/369-research-backend` · `main` | `3edffa35ff11c1d4c5b6b6fcc79c758a0b680e84` | — | Unverändert |
| Bestehender Frontend-Main | `research369/369-research-frontend` · `main` | `610c4080eb8473337eda439789656eb12d271581` | — | Unverändert |

Beide Feature-Branches wurden zusätzlich in unabhängigen privaten Spiegelrepositorys mit identischen Commit-Referenzen gesichert.

## Vertragsumfang

| Bereich | Checkout-V2-Verhalten | Führende Instanz |
|---|---|---|
| Produkt, Variante, Sichtbarkeit und Preis | Vor Quote und Abschluss serverseitig neu auflösen | WaWi-/Backenddaten |
| Rabatt- und Aktionscodes | Serverseitig prüfen, berechnen und begrenzen | Bestehender Promo-Vertrag |
| Partnercode, Partner-Eigenbestellung und Guthaben | Serverseitige Berechtigung und bestehende Partner-Sitzung; keine Browserwerte als Wahrheit | Bestehender Partner-/Ledger-Vertrag |
| Kundenwerben-Kunden | Serverseitiger Neukunden-/Selbstwerbungscheck; nicht mit Partnerweg kombinierbar | Bestehender KWK-Vertrag |
| 2-für-3 und Gratis-BAC | Ausschließlich aus Einstellungen und Produktattributen ableiten | Führende Shop-Einstellungen und Artikel |
| Nasenspray-Kit und BAC 10 ml | Nur sieben freigegebene Produktfamilien; Bestand erneut prüfen | Führender Kitvertrag und Artikelbestand |
| Privat, Firma, Packstation, Postfiliale | Kanonische Adressfelder; Abholadressen bei Kühlversand sperren | Bestehender Adress-/Versandvertrag |
| Abschluss | Quote unmittelbar erneut berechnen; V2-Idempotenz vor WaWi-Transaktion | Neuer Serveradapter plus bestehender Order-Kern |

## Bestehende Sicherheitsgrenzen

| Grenze | Durchsetzung |
|---|---|
| Standardmäßig geschlossen | Quote und Abschluss verweigern ohne `CHECKOUT_V2_COMMERCE_STAGING=true` und `FEATURE_CHECKOUT_V2_ENABLED=true` vor jedem Datenbankzugriff. |
| Testkommunikation | `CHECKOUT_V2_TEST_MODE=true` unterdrückt im Checkout-V2-Adapter Bestätigungs-E-Mails; der historische Checkout bleibt unverändert. |
| Kein Produktionsfallback | Das Frontend spricht Checkout V2 ausschließlich bei expliziter eigener `VITE_CHECKOUT_V2_API_BASE` an. |
| Kein Browserpreis | Browserwerte für Preis, Rabatt, Versand, Guthaben, Partnerberechtigung und Gratispositionen werden nicht als wirtschaftliche Wahrheit verwendet. |
| Kein automatischer Deploy | Commerce-Staging-Workflow ist ausschließlich manuell auslösbar und verlangt `COMMERCE_STAGING_ONLY`. |
| GitHub-Umgebung | `checkout-v2-commerce-staging` ist nur für `feat/checkout-v2-commerce-contract` freigegeben. |

## Nachweise

| Nachweis | Ergebnis |
|---|---|
| Checkout-V2-Vertragstests | 31/31 lokal bestanden; feste Testdaten, keine Datenbankverbindung. |
| Backend-Typecheck | Keine Diagnosen in den Checkout-V2- und geänderten Kern-Dateien; bekannte Alt-Diagnosen außerhalb dieses Umfangs bleiben getrennt. |
| Frontend-Typecheck und Produktionsbuild | Bestanden im isolierten Feature-Branch. |
| Backend-GitHub-Contract-CI | Zwei erfolgreiche Läufe für `aaa5dcb`: [Lauf 33930035240](https://github.com/research369/369-research-backend/actions/runs/33930035240) und [Lauf 33930032127](https://github.com/research369/369-research-backend/actions/runs/33930032127). Reine Teststrecke; kein Railway-, Staging-, WaWi-, Payment- oder E-Mail-Schritt. |
| Frontend-GitHub-Contract-CI | Zwei erfolgreiche Läufe für `954a565`: [Lauf 33930238840](https://github.com/research369/369-research-frontend/actions/runs/33930238840) und [Lauf 33930235241](https://github.com/research369/369-research-frontend/actions/runs/33930235241). Transporttest, Typecheck, Build ohne API-Basis und statische Deploy-Sperrprüfung. |
| Staging Workflow | Manuell, branchgebunden und ohne vollständige separate Zielkonfiguration nicht ausführbar. |

## Absolute Sperren vor Merge oder Deploy

Keiner der folgenden Punkte ist aktuell erfüllt; daher bleiben beide PRs Entwürfe:

1. Es existiert noch kein getrennter Backend-Service mit eigener Testdatenbank.
2. Für die GitHub-Umgebung sind noch keine explizit nicht-produktiven Zielwerte hinterlegt.
3. Ein End-to-End-Test wurde noch nicht ausgeführt; lokale Tests ersetzen ihn nicht.
4. Ein Payment-Testadapter ist bewusst nicht ausgewählt oder konfiguriert.
5. Eine zusätzliche Prüfung muss garantieren, dass weder Kundenkommunikation, Versandlabel noch operative Folgeprozesse in der Testumgebung möglich sind.
6. Ein späterer Merge oder Livegang benötigt eine neue ausdrückliche Freigabe.

## Rückfall

Der aktuelle Checkout unter `/checkout` bleibt vollständig erhalten. Checkout V2 ist ausschließlich `/checkout-v2`, in Main nicht verknüpft und ohne gesonderte Commerce-Staging-URL nicht kaufbar. Bei jedem künftigen Fehler wird der Checkout-V2-Featurepfad deaktiviert; der historische Checkout bleibt unverändert erreichbar.
