# 369 Precision-Lab – Checkout-Integration und Abnahme

**Stand:** 27. November 2026, lokale technische Abnahme.
**Status:** Checkout-Integration implementiert und in einer isolierten lokalen Testumgebung geprüft. **Kein Livegang, kein Produktionsdeploy und kein Merge in `main`.** Zahlungsanbieter, echte Mailzustellung und DHL-Provider-Abnahme sind noch offen.

## 1. Was fertig ist

Der bestehende visuelle Shop-Kandidat wurde gezielt an den bereits vorhandenen serverautoritativen Bestellweg angebunden. Es wurde kein neuer Shop und kein anderes Design aufgebaut. Der Server ermittelt Preise, Mengenrabatte, Aktionscodes, Partnerkonditionen und KWK-Vorteile aus der vorhandenen Logik. Die Browserangaben sind nicht die Preis- oder Lagerautorität.

Die Integration verwendet den echten `orderRouter`, die vorhandene Katalog-/SKU-Auflösung, Bestelltransaktionen, Guthabenbuchungen und Lagerbewegungen. Der neue Precision-Zugriff ist ein zusätzlicher, serverseitig authentifizierter Bereich. Die normalen WaWi-, Altshop-, P4P- und Checkout-V2-Pfade behalten ihre bisherigen Standardparameter; sie wurden nicht global umgestellt.

Bei unklarer Bestellantwort wird kein zweiter Kauf automatisch ausgelöst. Ein starker Zufallsschlüssel und ein Payload-Fingerprint werden vor der Übermittlung gespeichert. Der Server persistiert den Bestellbeleg in der Bestelltransaktion. Der Browser fragt diesen Beleg nach Antwortverlust oder Neuladen ab und leert den Warenkorb erst nach bestätigtem Commit. Auch `not_found` erlaubt keinen automatischen Create-Replay.

Abgelaufene Rabattaktionen werden im Precision-Bereich entfernt und neu berechnet, statt den Checkout dauerhaft zu blockieren. Geänderte Preise, Bestand, Codes oder Kundendaten führen weiterhin zur notwendigen erneuten Prüfung. Die abschließende Lagerprüfung unter Transaktionssperre bleibt als Schutz gegen gleichzeitige Käufe erforderlich.

## 2. Sortiment und Nasenspray-Set

Die bereits korrigierte Auswahl bleibt erhalten: **369 Plug&Play Patrone** nur für die 13 freigegebenen Familien und die vorhandenen veröffentlichten Stärken. Die 13 Familien sind Retatrutide, Tirzepatide, Cagrilintide, Eloralintide, MOTS-c, SS-31, NAD+, 5-Amino-1MQ, TB-500, GHK-Cu, PT-141, Tesamorelin und CJC mit Ipamorelin. Die ursprünglichen 31 Stärken und die bestehende Katalogstruktur wurden nicht neu angelegt oder geändert.

Das optionale **DIY Nasenspray-Set für 7 € Aufpreis** ist für Semax, Selank, Adamax, Oxytocin, PT-141, Kisspeptin-10 und Semax+Selank vorgesehen. Der Lieferumfang bleibt genau:

- eine 10-ml-Spritze mit Kanüle;
- **einmal 10 ml BAC Wasser**;
- eine leere Nasensprayflasche.

Pro Set wird **genau eine vorhandene BAC10-Lagereinheit** gebucht. Es gibt keine zweite BAC-Buchung beim Wiederholen oder Wiederherstellen der Bestellung, keinen Ersatz durch BAC3 und keinen neu erfundenen Zubehörartikel. Zusätzlich gekaufter BAC10 wird mit dem Set-Bedarf in einem gemeinsamen atomaren Lagerplan summiert. Spritze/Kanüle und Flasche bleiben beschreibende Komponenten ohne neue lagergeführte SKU.

Ein fehlender, inaktiver, mehrdeutiger oder widersprüchlicher BAC10-Katalogartikel wird nicht stillschweigend ersetzt. Das Set erhält kein zusätzliches Gratis-BAC3. Die bestehende Gratis-BAC-Regel für sonstige qualifizierende Vial-Käufe bleibt separat erhalten. Versand bleibt Standardversand; veraltete Kühlversand-Angaben schalten keinen Kühlversand frei.

## 3. Sicherer Gateway und API-Vertrag

Der Browser nutzt ausschließlich den gezielten Server-Gateway `/api/precision-commerce/`. Freigegeben sind genau vier POST-Verfahren mit JSON-Hülle `{ "json": <input> }`:

| Verfahren | Zweck |
|---|---|
| `order.quote` | Kanonische, schreibfreie Preis-/Konditionsprüfung |
| `order.create` | Gesperrte Bestelltransaktion mit Lagerbuchung und dauerhaftem Beleg |
| `order.checkoutReceipt` | Bereichsgebundene Belegabfrage; Datenbanktransaktion READ ONLY |
| `order.checkoutCustomerConfirmation` | Bestehender kurzlebiger Nachweis für explizit bestätigte abweichende Kundendaten |

Der Gateway fügt den Schlüssel `x-369-precision-commerce-key` ausschließlich serverseitig hinzu. Client-Schlüssel, Admin-/WaWi-Kontexte, andere Shops, andere Verfahren, Batches und Query-Parameter sind nicht freigegeben. Partner-Bearer-Tokens werden weitergeleitet und im Backend tatsächlich validiert. Cookies oder Admin-Token-Fallbacks werden nicht weitergereicht. `Origin`, `Referer` und `storeKey` allein erteilen keine Berechtigung.

Der Belegzugriff verlangt sowohl den ursprünglichen 64-Hex-Bestellschlüssel als auch den unveränderten Payload-Fingerprint. Der Server bindet ihn intern zusätzlich an Precision-Shop und Policy-Version. Ein Wechsel in den normalen Shop-Kontext kann den Precision-Beleg nicht wiederverwenden.

Transport ist begrenzt: 256 KiB Request, 1 MiB Response, 15 Sekunden Timeout, keine Redirects und keine Weitergabe interner Fehlermeldungen oder Schlüssel. Antworten sind `no-store` und `noindex`.

### Standardmäßig geschlossen

Der Browser-Schalter `VITE_PRECISION_COMMERCE_ENABLED` ist standardmäßig aus. Offline-Preview bleibt ebenfalls aus. Der Gateway benötigt ausdrücklich:

```text
PRECISION_COMMERCE_ENABLED=true
PRECISION_COMMERCE_BACKEND_ENV=commerce-staging
PRECISION_COMMERCE_BACKEND_URL=<nachweislich isolierter HTTPS-Origin>
PRECISION_COMMERCE_GATEWAY_KEY=<zufälliger serverseitiger Schlüssel>
```

Das Backend benötigt die passende Freischaltung und denselben serverseitigen Schlüssel. Der bisherige produktive Railway-Hostname sowie Hostnamen mit `production` werden vom Gateway abgewiesen. Das ist kein Ersatz für die spätere Prüfung von Service-ID, Datenbank und Secret-Trennung. HTTP-Loopback ist nur in der injizierten lokalen Testfactory erlaubt, nicht über eine Hosting-Umgebungsvariable.

Die vorhandenen Katalog-, Partner- und KWK-Loginpfade wurden nicht umfassend umgeschrieben. Für ein externes Staging muss deshalb auch `VITE_RAILWAY_API_URL` auf das isolierte Backend zeigen – kein Login- oder Katalogzugriff über den Live-Host.

## 4. Design und bestehende Funktionen erhalten

Hashvergleiche bestätigen die unveränderten Dateien für globale CSS, HTML-/Schriftgrundlage, Startseite, CartContext, Patronen-Konfiguration, Gratis-BAC-Regeln und alte Warenkorb-Formatregeln. Im Checkout sind sämtliche 256 geprüften ursprünglichen `className`-Marker, 14 Inline-Style-Marker und der ursprüngliche Bild-Marker weiterhin vorhanden.

Desktop mit 1440 px und Mobile mit 390 px wurden tatsächlich im Browser bestellt; Checkout und Bestätigung hatten keinen horizontalen Überlauf und keine unbehandelten Browserfehler. Der Test sperrt externe Verbindungen einschließlich externer Fonts/Bilder. Daher sind die Screenshots **Funktions-/Layoutnachweise, keine vollständige Abnahme aller extern geladenen Medien**. Fehlende externe Bilder im Test wurden nicht durch neue Bilder ersetzt.

Privatadresse, Firma und Packstation bleiben im vorhandenen Checkout erhalten. Es wurde keine neue Postfiliale-Oberfläche oder andere Seitenstruktur hinzugefügt. Reale DHL-Adress-/Label-Abnahme ist eine separate offene Prüfung.

Ein anfänglich fehlgeschlagener Alt-Sicherheitstest war auf eine nicht materialisierte, bereits versionierte Datei in der Sparse-Worktree-Ansicht zurückzuführen: `lib/launchAccessPolicy.cjs`. Genau diese Datei wurde aus dem unveränderten Git-Baseline wiederhergestellt. Es war keine Sicherheitslogikänderung und keine fehlende GitHub-Historie. Ausgeschlossene Token-/Credential-Dateien wurden nicht materialisiert.

## 5. Tatsächlich ausgeführte Prüfungen

| Prüfgruppe | Ergebnis |
|---|---:|
| Gesamte Frontend-Vitest-Suite | 879 bestanden |
| Native Frontend-/Gateway-/SEO-Tests | 216 bestanden |
| Bestehende Netlify-Sicherheitstests | 224 bestanden |
| Erweiterte Backend-Handler-/Partner-/KWK-/Katalogtests | 258 bestanden |
| Bestehende Bestellintegrität gegen frisches PostgreSQL | 59 bestanden |
| Dedizierte Precision-Transaktionsprüfungen gegen frisches PostgreSQL | 8 bestanden |
| Echter HTTP-Gateway → tRPC → PostgreSQL, inklusive Desktop/Mobile | 24 bestanden |
| Frontend-TypeScript, Vite-TypeScript, Backend-TypeScript | bestanden |
| Default-off-Offlinebuild und isolierter Feature-on-Build | bestanden |
| Git-Diff-Formatprüfung | bestanden |

Die 48 spezifischen Gateway-Prüfungen sind bereits in den 216 nativen Frontend-Prüfungen enthalten; die 319 gezielten Checkout-Prüfungen sind in der gesamten Frontend-Suite enthalten. Die acht PostgreSQL-Prüfungen waren in der rein offline ausgeführten Backend-Suite absichtlich deaktiviert und wurden anschließend separat mit echtem PostgreSQL ausgeführt. Teilmengen werden nicht doppelt gezählt.

### Echte Lager- und Recovery-Abnahme

Für die Browser-Abnahme wurden zwei synthetische Bestellungen erzeugt: einmal Desktop normal, einmal Mobile mit tatsächlich erfolgreich abgeschlossener Create-Transaktion, anschließend verworfener HTTP-Antwort, blockierter erster Belegabfrage und Recovery nach Neuladen. Geprüft wurden **zwei Bestellungen, zwei dauerhafte Belege, Adamax 10 → 8, BAC10 20 → 18 und BAC3 unverändert 100**. In beiden Browserkontexten gab es exakt einen Create-Request. Die Frontend-Commerce-POSTs wurden nicht gemockt.

Weitere echte HTTP-/PG-Prüfungen decken unter anderem Authentifizierung, manipulierbare Preise, alle 13/7 Familien, Partner/JWT/KWK und Guthaben, parallele/replayte Bestellungen, letzten BAC10-Bestand, Rollback und die vierte Kundendaten-Bestätigungsroute ab. Die ursprünglichen Kundenprofile werden durch bestätigte Bestellsnapshots nicht überschrieben.

Jeder Datenbanklauf nutzte einen frisch angelegten PostgreSQL-Cluster in einem separaten Linux-Netzwerk-Namespace. Nur Loopback war erreichbar. Produktions-DB- und Provider-Variablen waren leer; der normale Backend-Server mit seinen Initialisierungen/Schedulern wurde nicht gestartet. Nach dem Lauf wurden Cluster und temporäre Daten gelöscht.

## 6. Was noch nicht abgenommen ist

**Zahlungsweg:** Kein neuer Anbieter wurde ausgewählt oder aktiviert. Der bestehende technische Payment-Key ist nur Kompatibilität, keine Anbieterentscheidung. Bestätigte Bestellungen ohne freigegebene Zahlungsinformationen zeigen einen sicheren Hinweis, nicht erneut zu bestellen und zunächst Zahlungsdaten bestätigen zu lassen. Sandbox-Zahlung, Callback/Webhook, Abgleich, Fehlschlag und Rückerstattung sind noch nicht geprüft.

**Bestätigungsmail:** Der Lauf enthielt absichtlich keinen `RESEND_API_KEY`. Die vorhandene Versandlogik meldete deshalb die fehlende Konfiguration; es wurde keine reale Mail zugestellt. Die erfolgreiche Bestell-/Receipt-Transaktion darf nicht mit erfolgreicher Mailzustellung verwechselt werden.

**DHL/Fulfillment:** Es wurde kein echtes oder Sandbox-Label erzeugt und kein Versand ausgelöst. Reale Packstation-/Firmenadresse, Postnummer, Label, Tracking, Druck-/Pickliste, Komponentenübergabe und genau einmal angestoßene Fulfillment-Verarbeitung müssen auf dem isolierten Service mit Testzugängen geprüft werden.

**Externes Commerce-Staging:** Die neue Integration wurde in dieser Runde nicht auf einen Railway-/Netlify-Service deployed. Der bestehende Checkout-V2-Staging-Workflow ist an einen anderen Quellbranch gebunden und ist keine automatische Deploy-Freigabe für diesen neuen Branch. Er darf nicht unbesehen verwendet werden.

**Freigaben vor Live:** Katalog-/Stärken-/BAC10-Veröffentlichung auf dem vorgesehenen Ziel, aktuelle Rechtstexte und Bestätigungsnachweise, Shop-Texte, reale Medien, produktive Domains/SEO-/Merchant-Aktivierung sowie getrennte Deploy-/Merge-Freigabe bleiben Release-Gates. Diese Runde behauptet keine erneute komplette Rechts-/SEO-/Medien-Abnahme.

## 7. Nächste gemeinsame isolierte Abnahme

1. Neue Frontend-/Backend-SHAs auf getrennte Commerce-Staging-Dienste pinnen; Service-/Projekt-ID, separate synthetische Datenbank und deaktivierte Produktionsjobs nachweisen. Deploy nur nach der dafür erforderlichen Freigabe. Branch-Sicherung allein ist kein Deploy.
2. Server-Gateway-Schlüssel ausschließlich in Staging-Secrets setzen; Browserbuild auf isolierten Katalog-/Login-Origin verweisen. Read-only-Prüfung und Fehlkonfigurationstest vor Write-Test.
3. Den von Pakko gewählten Zahlungsweg mit **Testzugängen** anbinden. Erfolgreiche, fehlgeschlagene und doppelte Ereignisse prüfen; kein realer Geldtransfer und keine neue Bankverbindung eigenmächtig wählen.
4. Mail an einen kontrollierten Testempfänger zustellen und Provider-ID/Archiv/Retry prüfen, inklusive erfolgreicher Bestellung bei vorübergehendem Mailausfall.
5. DHL-Testlabel für Privatadresse, Firma und Packstation erstellen; Bestellnummer, Postnummer und Adresse in Label/Tracking/Pickliste vergleichen. Kein produktiver Versandschein.
6. Eine vollständige synthetische Bestellung mit Code/Partner/KWK und DIY-Set durch Zahlung, Mail und Fulfillment führen; Replay-/Ausfalltests wiederholen und BAC10 weiterhin exakt einmal buchen.
7. Erst nach dokumentierter gemeinsamer Abnahme Produktionsumstellung gesondert freigeben.

## 8. Reproduktion und Sicherung

Beide Repositories verwenden den neuen isolierten Branch `feat/precision-commerce-integration-20261127`.

| Repository | Unveränderte Ausgangsbasis |
|---|---|
| Frontend | `0813c04115dce3dad64c0bdea2c63f47d191f7e0` |
| Backend | `fa5f12d23a0f0e5e23133e556062871fb8cdc708` |
| Gelesener Frontend-Commerce-Quellstand | `ac57e6e1f485674223c96430748602bb96fbda3a` |

Der frühere Kandidatbranch `fix/launch-ruo-20261124` bleibt auf `0813c04115dce3dad64c0bdea2c63f47d191f7e0`. Build-Veto für den ursprünglichen Kandidaten und den neuen Integrationsbranch ist getestet. Commits tragen Skip-Marker; kein Push nach `main`, kein Force-Push und kein Deployment-Aufruf gehören zu dieser Sicherung.

Für die lokale Reproduktion werden zwei vollständige Checkouts nebeneinander als `frontend/` und `backend/` benötigt. Abhängigkeiten aus den vorhandenen Lockfiles ohne Lifecycle-Skripte installieren. Laufzeit: Node 22, Linux mit User-/Netzwerk-Namespaces, PostgreSQL 16 einschließlich libpq und Share-Dateien; für UI zusätzlich Chromium und Python Playwright. Der Teststarter verwendet den dokumentierten extrahierten PG-Root oder `PRECISION_TEST_PG_ROOT` auf einen gleich aufgebauten Test-Root; er verwendet **keine vorhandene Datenbank**.

```bash
# Vollständige Frontend-Prüfung und beide isolierten Buildartefakte:
bash frontend/scripts/validate-precision-isolated.sh

# Jeweils frischer lokaler Testcluster, keine externen Verbindungen:
bash backend/scripts/test-precision-isolated.sh server/priorityOrderIntegrity.test.ts
bash backend/scripts/test-precision-isolated.sh server/precisionCommerce.postgres.test.ts
bash backend/scripts/test-precision-isolated.sh --ui server/precisionCommerceHttp.test.ts
```

Die relative Browser-Testdatei wird exakt vom Runner freigegeben und erhält keine Datenbank-, Provider- oder Gateway-Schlüssel. Die Testdatenpreise sind synthetisch und dürfen nicht als reale Shoppreise übernommen werden.

Bericht und technische Verträge werden in `docs/precision-commerce-integration-20261127/` beider Repositories mitgesichert. Der vollständige visuelle Erhaltungsnachweis, alle Testlogs und die Browser-Screenshots liegen im privaten Frontend-Repository; das bereits öffentliche Backend-Repository erhält nur technische Dokumentation und synthetische Backend-Testnachweise, keine unveröffentlichten Shopbilder. Beide privaten Backup-Repositories bleiben privat. Die abschließende Sicherungsquittung enthält die vollständigen neuen Commit-SHAs sowie den überprüften Gleichstand von Primärrepository und privatem Backup. Bis zu dieser Quittung ist die lokale Abnahme nicht als abgeschlossener Remote-Backup-Nachweis zu lesen.

Nach dem Push werden die vollständigen Remote-SHAs zusätzlich in einer eigenständigen Sicherungsquittung verifiziert. Die Commit-identische Dokumentation kann ihren eigenen endgültigen Commit-Hash nicht enthalten; sie wird zusammen mit dieser Quittung gelesen.
