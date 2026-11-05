# Checkout-Contract: Typkorrektur und nächste Legacy-Abnahme

**Stand: 5. November 2026 · ausschließlich lokale Vorbereitung · keine Launch-Freigabe**

Arbeitsbaum: `/home/ubuntu/369-backend-double-chamber-staging`, Branch `feature/double-chamber-checkout-prep`, unveränderter Git-HEAD `7e5e1bc`. Die Änderungen sind uncommitted. Auditgrundlage: `/home/ubuntu/369_LAUNCHSTATUS_MERCHANT_KOSMETIK_2026-11-05.md`. Der zusätzlich gelesene Frontend-Arbeitsbaum `/home/ubuntu/369-mainshop-liveprep` steht auf `4da2f0c`. Dieser Vergleich ist **kein Nachweis des deployten Produktionsstands** und **kein Abgleich des separat bearbeiteten Upstream-Integrationsstands**.

## Was diese Änderung leistet

Die unveränderte Baseline hatte genau **13 TS2742-Diagnostiken**: fünf Express-Routerexporte sowie je zwei Diagnostiken für `protectedProcedure`, `adminProcedure`, `productManagerProcedure` und `packingProcedure`. Aus dem pnpm-Layout wurden transitive Express-/qs-Typen strukturell in die Inferenz übernommen; TypeScript konnte diese Exporte nicht portabel benennen.

Die fünf Express-Router werden nun mit dem öffentlichen `Router`-Typ aus `express` annotiert. In `server/trpc.ts` verwenden die Exporte öffentliche Typen aus `@trpc/server`: `TRPCRootObject`, `TRPCProcedureBuilder` und `TRPCUnsetMarker`. Der authentifizierte Kontext benennt `Request`, `Response` und `NonNullable<Context["user"]>` ausdrücklich. Rollen bleiben `string`, denn die vorhandenen Middlewares garantieren keinen unveränderlichen Literal-Rollentyp. Unset-Marker erhalten die anschließende Schema-/Input-/Output-Inferenz; SuperJSON bleibt als Transformer typisiert. Keine neuen `any`-Typen oder erzwungenen Procedure-Casts wurden hinzugefügt. `declaration: true` und alle Compileroptionen bleiben unverändert.

Die Authentisierungs-, Rollen-, Router- und Handler-Laufzeitlogik wurde nicht geändert. Der separat hinzukommende Checker wird nirgendwo in den App-Router eingehängt und verändert keinen Geschäftsablauf.

### Änderungsumfang

- `server/trpc.ts`
- `server/checkoutErrorRouter.ts`
- `server/dhlExpressRouter.ts`
- `server/packingPhotoRouter.ts`
- `server/qrRedirectRouter.ts`
- `server/trackingRouter.ts`
- `server/checkoutContractReadiness.ts` (neu, reine Offline-Evidenzprüfung)
- `server/checkoutContractReadiness.test.ts` (neu, sieben Tests)
- `server/checkoutContractReadinessTypes.test.ts` (neu, vier Tests plus Compile-time-Typinferenzprüfungen)
- dieses Release-README

**Nicht geändert:** `server/orderRouter.ts`, `drizzle/schema.ts`, `server/emailService.ts`, `server/routers.ts`, Paket-/Lockdateien und Compilerkonfiguration. Kein anderer Worktree wurde verändert. Keine Bestellung, Datenbankverbindung/-mutation, Produkt-/WaWi-, Netlify-/Railway- oder P4P-Änderung. Kein Login/Browser, Merge, Commit, Push oder Deploy.

## Lokale Prüfergebnisse und reproduzierbare Umgebung

Der volle ausführbare Node-Pfad ist `/home/ubuntu/.nvm/versions/node/v22.13.0/bin/node`; das Binary meldet tatsächlich **v22.23.4**. Der Verzeichnisname ist daher kein Versionsnachweis. Installiert: TypeScript **5.9.3**, `@trpc/server` **11.17.0**, `@types/express` **5.0.6**. Die Änderungen nutzen die öffentlichen Typ-Exporte dieses vorhandenen Installationsstands. Ein CI-Neuaufbau muss den vorgesehenen Lock-/Package-Manager-Stand reproduzieren; die bloße Range `^11.6.0` ist kein Beleg derselben Installation.

Alle Node-Prüfprozesse liefen mit `env -i`, explizitem `PATH`, `HOME`, `LANG` und `NODE_ENV=test`, ohne übernommene API-/DB-Secrets. Die Testläufe liefen zusätzlich in einem eigenen Netzwerk-Namespace (`sudo unshare --net`); Netzwerk war dort nicht verfügbar. Der Server und die Scheduler wurden nicht gestartet. Die vorhandenen V2-Tests prüfen ausschließlich die Sperre außerhalb expliziten Commerce-Stagings, nicht einen V2-Abschluss.

| Prüfung | Vorher | Nachher |
|---|---:|---:|
| `tsc --noEmit`, `declaration: true` | Exit 2, 13 × TS2742 | Exit 0, keine Diagnostik |
| Gesamte Backend-Testreihe | 55/55 bestanden | 66/66 bestanden |
| Echter `--emitDeclarationOnly` | nicht als Baseline ausgeführt | erfolgreich; Exporte der sechs geänderten Module ohne `.pnpm`-Typreferenzen |
| `git diff --check` | sauber | sauber |

Die vier neuen tRPC-Regressionsprüfungen testen die ursprüngliche Rollenmatrix, Ablehnung fehlender Nutzer, Zod-Validierung und typisierte Antworten. Die Compile-time-Assertions sichern Inputs/Outputs, nicht-null `ctx.user`, DefaultErrorShape und den Transformer ab; eine pauschale Builder-Verbreiterung würde diese Assertions nicht erfüllen. Kein Test ruft `order.create` auf.

Zusätzlich wurde das mit TypeScript erzeugte JavaScript aller sechs geänderten vorhandenen Laufzeitmodule vor/nach dem Patch verglichen (`ES2022`, `ESNext`, Kommentare entfernt): **exakt identisch**. Der Laufzeitimport in `trpc.ts` bleibt unverändert; neue Typimporte sind separat und werden entfernt. Der Vergleich und die erfolgreiche Prüfung auf ausschließlich zehn erlaubte Dateien sind in `/home/ubuntu/checkout-typecheck-evidence/runtime-equivalence.log` protokolliert. Dies belegt die Typänderung ohne Geschäftslogikänderung, aber keinen tatsächlichen Bestellablauf.

Prüfkommandos, aus dem ausdrücklich angegebenen Arbeitsbaum:

```bash
cd /home/ubuntu/369-backend-double-chamber-staging
NODE=/home/ubuntu/.nvm/versions/node/v22.13.0/bin/node
CLEAN_PATH=/home/ubuntu/.nvm/versions/node/v22.13.0/bin:/usr/local/bin:/usr/bin:/bin

env -i HOME=/home/ubuntu PATH="$CLEAN_PATH" LANG=C.UTF-8 NODE_ENV=test \
  "$NODE" node_modules/typescript/bin/tsc --noEmit

sudo unshare --net -- env -i HOME=/home/ubuntu PATH="$CLEAN_PATH" LANG=C.UTF-8 NODE_ENV=test \
  "$NODE" --import tsx --test server/*.test.ts

env -i HOME=/home/ubuntu PATH="$CLEAN_PATH" LANG=C.UTF-8 NODE_ENV=test \
  "$NODE" node_modules/typescript/bin/tsc --emitDeclarationOnly \
  --outDir /home/ubuntu/checkout-typecheck-evidence/declarations-final

git diff --check
```

Die lokalen Logs liegen außerhalb des Git-Arbeitsbaums unter `/home/ubuntu/checkout-typecheck-evidence/`: `tsc-baseline.log`, `tests-baseline.log`, `tsc-final.log`, `tests-final.log` und `declaration-final.log`; Declaration-Artefakte in `declarations-final/`. Diese Evidence-Dateien sind nicht automatisch Teil eines späteren Checkout/CI-Laufs. Die Paket-`build`-Anweisung ist aktuell nur `echo 'No build step needed with tsx'`: ihr Erfolg wäre **kein vollständiger Build-/Release-Nachweis**.

## Offline-Checker: ausdrücklich nicht „connected“

`checkCheckoutContractReadiness(evidence)` prüft eine lokale, vom Aufrufer bereitgestellte Evidenzliste. Nur `status: "verified"` **und** eine nichtleere Nachweisreferenz schließen einen Punkt. Fehlende und ungeprüfte Punkte bleiben Blocker. Der Checker macht keine I/O, liest keine Umgebung und importiert weder API, DB noch App-Router.

Selbst bei zehn als verifiziert angegebenen Punkten bedeutet `offlineEvidenceComplete: true` ausschließlich, dass die vorgelegte Checkliste vollständig ist. **`connected` und `releaseApproved` bleiben immer `false`.** Die Referenzen werden nicht unabhängig authentifiziert; weder Schema-/Payload-Kompatibilität noch Existenz, sichere Semantik, tatsächliche Persistenz, Mailzustellung, rechtliche Wirksamkeit oder Live-Zustand werden automatisch überprüft. Der historische `CHECKOUT_CONTRACT_LOCAL_BASELINE` ist keine dynamische Live-Erkennung und muss nach dem Upstream-Abgleich ersetzt oder neu bewertet werden.

## Konkrete offene Legacy-Verträge

### 1. Preflight und Bestätigungstoken

Der Frontend-Launchweg ist weiterhin **`order.create`**, nicht V2. Das Frontend erwartet vorher die Mutation **`customerDataChange.previewCheckoutChange`** mit `{ customer: { firstName, lastName, email?, phone?, company?, street?, houseNumber?, zip?, city?, country?, dhlPostNumber? } }`.

Erwartete Preview-Antwort:

```ts
{
  requiresConfirmation: boolean;
  matchState: "matched" | "none" | "ambiguous" | "conflict";
  confirmationToken: string | null;
  expiresAt: string | null;
  changedFields: string[];
}
```

In Backend `7e5e1bc` ist diese Route in `server/routers.ts:30–54` nicht registriert. Das Frontend sendet nach Bestätigung **`customerDataChangeConfirmationToken`** an `order.create` (`Checkout.tsx:626`); dieses Feld fehlt im lokalen `createOrderSchema` (`server/orderRouter.ts:59–132`). Bestehende optionale `addressValidationOverride`-Bestätigung ist **kein Ersatz** für den Kundenänderungstoken.

Nach dem Upstream-Abgleich sind genaue Matching-/Konfliktsemantik, Bindung des Tokens an die tatsächlich bestätigten Kundendaten, Ablauf, Manipulationsschutz und sichere Wiederholung verbindlich festzulegen und negativ zu testen. Wichtiges Frontend-Risiko: Der aktuelle Code lässt `requiresConfirmation: true` ohne Token durch, prüft dabei `matchState`/`expiresAt` nicht ausdrücklich (`Checkout.tsx:357`). Diese Antwortkombination darf nicht zum stillen Umgehen einer notwendigen Bestätigung führen. Hier wurde das Frontend nicht geändert.

### 2. Freigegebene Wise-Zahlungsdaten

Die erfolgreiche Legacy-Antwort muss für den Überweisungs-Launch nutzbare, freigegebene **`paymentInstructions`** liefern:

```ts
{
  accountCount: number;
  accounts: Array<{
    id: string;
    labelDe: string;
    labelEn: string;
    accountHolder: string;
    iban: string;
    bic: string;
    bankAddress?: string;
  }>;
}
```

Der Frontend-Typ erlaubt derzeit `undefined`/`null`; daraus folgt keine ausreichende Zahlungsinformation für den Launch. Legacy `7e5e1bc` liefert diese Felder nicht (`orderRouter.ts:1279–1289`). Bestätigungsseite und Mail müssen dieselbe freigegebene Quelle benutzen; kein zusätzlicher hardcodierter Bankdatensatz und keine ungeprüfte Veröffentlichung hier. Anzahl/Accounts, Währung/Betrag, kanonische Bestellreferenz und Zahlungseingangsablauf sind gemeinsam abzunehmen. Ein automatischer Wise-Abgleich ist nicht nachgewiesen und wird nicht vorausgesetzt; ein bestätigter vorhandener Betriebsablauf kann genügen.

### 3. Dauerhafte Kundenbestätigungsnachweise

Das Frontend bildet lokal `confirmations: { research, age, noReturn, address }` (`Checkout.tsx:593–598`), übermittelt dieses Objekt im tatsächlichen `orderApi.create`-Aufruf jedoch nicht (`603–627`). Im lokalen Legacy-Schema fehlt es ebenfalls. Nach Abgleich müssen ein gemeinsamer Vertrag und dauerhafte Zuordnung zum Auftrag **aller Einzelwerte, tatsächlich angezeigter Texte, Textversionen und Zeitpunkt** geschlossen werden. Namensangleichung zu V2-`acknowledgements` ist nicht automatisch eine Legacy-Anbindung.

Checkboxwerte sind kein amtlicher Altersnachweis und kein pauschaler Ausschluss gesetzlicher Verbraucherrechte. Die Bedeutung von `research` und `noReturn` muss zu Produktbestimmung, kosmetischen Produkten, vereinheitlichten Rechtstexten und fachkundiger Rechtsprüfung passen.

### 4. Preis-, Rabatt-, Beigaben- und Bestandsparität

Die Legacy-Standardstrecke vergleicht teilweise vom Client gelieferte Positionen und Summen miteinander, statt in allen Fällen vollständig kanonische Preise neu zu berechnen. Die zusätzliche KWK-Neuberechnung (`orderRouter.ts:164–185`) belegt keine durchgehend identischen Launchregeln. Geprüfte V2-Quote-/Rabatthelper ersetzen den tatsächlich verwendeten Legacy-Weg nicht.

Abzunehmen sind WaWi-Artikel-/Variantenkennung, regulärer Preis und `salePrice`, PEN/Patronen, freigegebener Plug&Play-Aufpreis, berechtigte Mengenstaffeln **4/8/13/20/36 → 10/20/25/30/35 %**, Aktionscodes einschließlich Ablauf, Rabattreihenfolge, Gratis-BAC, Bundlepositionen, Partner/KWK/Guthaben sowie Rundung und Rabattaufschlüsselung. Versand bleibt eine ausdrücklich geprüfte Preisquelle. Abgelehnte Manipulationen von Preis, Rabatt, Guthaben und Beigaben gehören dazu.

Bereits Auswahl/Hinzufügen muss bei nicht verfügbarem Produkt, noch unbekanntem Bestand und API-Fehler sperren. Die gemeinsam benötigte Menge zählt auch über mehrere Positionen/Varianten mit demselben Bestand sowie Beigaben. Die finale serverseitige Prüfung bleibt zweite Schutzschicht. Auch diese offenen Punkte wurden hier nicht implementiert.

## Präziser nächster Schritt nach Upstream-Abgleich

1. **Den separaten Integrationsarbeitsbaum zuerst abschließen und vergleichen.** Die dort ermittelten exakten Frontend-/Backend-Commit-IDs und die Konfliktauflösung dokumentieren. In diesem Arbeitsbaum nichts von Upstream kopieren, kein blindes Merge und keinen bereits upstream vorhandenen Kundenänderungs-/Zahlungsdatenvertrag duplizieren. Bei Übernahme dieser Typkorrekturen die tatsächlich dort vorhandenen Context-/Routerdefinitionen und Lockversionen prüfen; HEAD `7e5e1bc` ist nicht automatisch der künftige Zielstand.
2. **Am abgeglichenen Zielstand eine konkrete Vertragsmatrix erstellen:** vorhandene/registrierte Preview-Route, Token-Input und Prüfung, erfolgreiche Legacy-Antwort, freigegebene Zahlungsdatenquelle, bestätigte Texte/Versionen/Persistenz und kanonische Preishelper. Erst dann die wirklich fehlenden Legacy-Stellen in einem gesondert autorisierten Patch an `orderRouter`, Routerregistrierung, gemeinsamen Typen/Schema und gegebenenfalls Mailquelle ergänzen. Das ist bewusst außerhalb des Änderungsumfangs dieses Tasks.
3. **Offline-Contracttests an echten kombinierten Quellen ergänzen:** Preview-Fälle `none/matched/ambiguous/conflict`, Bestätigung erforderlich ohne Token, falscher/geänderter/abgelaufener Token, Übermittlung und Zuordnung jeder Bestätigung, fehlende Zahlungsdaten, Preis-/Rabattmanipulationen sowie Tabellen für Rabattgrenzen und Partner/KWK-Fälle. Die hier erstellte Evidenzliste allein genügt hierfür nicht.
4. **Vor jeglicher Bestellmutation die Isolation belegen:** Frontend-API darf nicht die derzeit feste Produktions-API verwenden; Test-API, DB, WaWi-/Mailziele und deaktivierte Scheduler müssen eindeutig getrennt beziehungsweise kontrolliert sein. Kein Probeauftrag aus der vorhandenen Vorschau. Eine tatsächliche E2E-/Mail-/Persistenzabnahme verlangt einen gesondert freigegebenen isolierten Zielstand und Freigabe für diese Seiteneffekte.
5. **Exakt den kombinierten Stand prüfen:** Typecheck plus Declaration-Emit, vollständiger sinnvoller Build/CI, vorhandene und neue Tests; anschließend autorisierte isolierte Legacy-Abnahme für Normalfall, Doppelklick/Retry, Bestandsänderung, Aktionscodeablauf, Packstation sowie EU/Schweiz. Persistierter Auftrag, Zahlungsreferenz/-hinweis, Mailzustellung oder sichtbarer Zustellfehler, Zahlungseingang/Status und Versandablauf müssen zusammenpassen. Mailfehler dürfen keinen vermeintlich fehlgeschlagenen Auftrag und blindes Doppelbestellen auslösen.
6. **Release bleibt separat:** Rechts-/Bestätigungsabnahme, Preview-SEO, mobile/Desktop-Prüfung, Rückfallplan und ausdrückliche Veröffentlichungsfreigabe. Merchant/Kosmetikfreigabe ist ein eigener Vorgang. Gruppenkauf und P4P bleiben außerhalb dieses Vorhabens.

**Fazit:** Die 13 Declaration-Portabilitätsfehler sind lokal mit passenden öffentlichen Typen behoben und regressionsgeprüft. Der Legacy-Checkout ist damit weder integriert noch verbunden oder launchbereit. Die nächste Arbeit ist gezielte Legacy-Vertragsschließung am erst abgeglichenen Upstream-Zielstand, nicht ein Umschalten auf staging-only V2.
