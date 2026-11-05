# DHL Storno und Ersatzlabel – Backend-Vertrag

Stand: Implementierung im isolierten Worktree, nicht deployed. Basis `/api/shipping/dhl`. Alle Endpoints verwenden ausschließlich bestehende Admin-JWT-Authentifizierung; keine Rollenöffnung. Keine automatischen Kundenmitteilungen, Status-/Zahlungs-/Bestandsänderungen und kein Wiederöffnen historischer Bestellungen.

## Stornieren

`POST /api/shipping/dhl/cancel-label`

```json
{"orderId":"ORDER-ID","trackingNumber":"OLD-TRACKING","reason":"Falsche Lieferadresse","idempotencyKey":"unique-client-uuid"}
```

Die alte Trackingnummer muss exakt dem aktuellen Label entsprechen. Der Backend-Aufruf lautet laut offizieller DHL-OpenAPI `DELETE /orders?profile=STANDARD_GRUPPENPROFIL&shipment=<tracking>`, ohne Request-Body. Nur HTTP 200/207 mit passendem `items[].shipmentNo` und `sstatus.status=200` gilt als bestätigt. Manifestierte oder zugestellte Sendungen werden nicht freigegeben. Stornieren lässt alte Trackingnummer, Label und Bestellstatus unverändert sichtbar.

Erfolg: `200 {success:true, orderId, generationId, state:"cancelled", trackingNumber, cancellationSource:"dhl"}`. Die UI darf das alte Label danach nicht als gültiges Versandlabel behandeln.

## Externe Stornierung ausdrücklich bestätigen

`POST /api/shipping/dhl/attest-cancellation`

```json
{"orderId":"ORDER-ID","trackingNumber":"OLD-TRACKING","reason":"Im DHL-Portal geprüft und storniert; Referenz ...","idempotencyKey":"unique-client-uuid","externallyCancelled":true}
```

Keine DHL-Anfrage. Protokolliert nur die ausdrückliche Administratorbestätigung. Erfordert alte Trackingnummer und Grund; bekannt manifestierte oder zugestellte Labels sowie laufende/unbekannte Erstellung bleiben gesperrt. Ein unbekanntes DELETE darf nur nach tatsächlicher externer Prüfung hierdurch aufgelöst werden, niemals durch automatisches Wiederholen.

Erfolg wie oben, `cancellationSource:"admin_attestation"`.

## Neues Ersatzlabel ausdrücklich erstellen

`POST /api/shipping/dhl/replace-label`

```json
{
  "orderId":"ORDER-ID",
  "oldTrackingNumber":"OLD-TRACKING",
  "reason":"Neue geprüfte Lieferadresse",
  "idempotencyKey":"unique-client-uuid",
  "shippingProfile":"DHL_DE_STANDARD",
  "weightGrams":1000,
  "recipient":{
    "firstName":"Test",
    "lastName":"Recipient",
    "company":"",
    "street":"New Street",
    "houseNumber":"10",
    "zip":"10115",
    "city":"Berlin",
    "country":"DE",
    "email":"",
    "phone":"",
    "deliveryType":"home",
    "dhlPostNumber":""
  }
}
```

`recipient` ist ein vollständiger expliziter Snapshot: alle gezeigten Felder sind erforderlich, `company`, `email`, `phone`, `dhlPostNumber` dürfen leer sein. Keine Zusammenführung mit Kunde oder alter Bestellung; leere Firma entfernt die Firma im Ersatzlabel. `deliveryType` ist `home`, `packstation` oder `postfiliale`. Länder-/Profil-/Gewichts- und Abholortvalidierung bleiben serverseitig. Die Empfängeradresse wird nur am Label-Snapshot, nicht an Bestellung/Kunde gespeichert. Für CH bleiben gespeicherte Zolldeklaration und das tatsächliche gespeicherte Paketgewicht verbindlich; Vretti-/CN23-Pipeline unverändert.

Nur nach `cancelled` (DHL-bestätigt oder Administratorattestation) möglich. Historisch abgeschlossene Bestellungen sind zulässig, echte `deliveredAt`-Nachweise für das zu ersetzende Label nicht. Erst bei vollständig gespeichertem Erfolg werden ausschließlich die vier Label-/Trackingfelder der Bestellung auf die neue Generation gesetzt.

Erfolg: `200 {success:true, orderId, generationId, state:"active", trackingNumber:"NEW", labelUrl:"/api/shipping/dhl/label/ORDER-ID", hasContent:true, customsInvoiceStored:false, sandbox:false}`.

## Historie und geschützter Download

`GET /api/shipping/dhl/label-history/:orderId` liefert `{success:true,orderId,currentGenerationId,blocked,canCancel,canReplace,canAttestCancellation,generations:[...],operations:[...]}`. Jede Generation enthält `generationId`, `generation`, `state`, `trackingNumber`, `recipient`, `shippingProfile`, `reason`, `cancellationSource`, `createdAt`, `updatedAt`, `hasLabel`, `hasCustomsDocuments` und generationseigene `labelUrl`/`documentsUrl`. Vorgänge enthalten `idempotencyKey`, `kind`, `state`, `createdAt`, `finishedAt`; keine Secrets oder Base64-PDFs in Listen.

`GET /api/shipping/dhl/label-generation/:orderId/:generationId` lädt das archivierte Label. `GET /api/shipping/dhl/label-generation-documents/:orderId/:generationId` lädt die archivierten Schweizer A4-Handelsrechnungen. Bestehende aktuelle Label-/CH-Downloadpfade bleiben erhalten.

## Fehler und Idempotenz

Fehlerformat `{success:false,error,code,orderId?,generationId?,state?,trackingNumber?}`. `400 INVALID_INPUT`, `404 ORDER_NOT_FOUND`, `409 LABEL_CONFLICT | CANCELLATION_REQUIRED | IDEMPOTENCY_CONFLICT | OPERATION_PENDING | OUTCOME_UNKNOWN | MANIFESTED | DELIVERED`, `422` für Profil-/Adress-/Zolldatenvalidierung, `502 DHL_REJECTED`, `503 DATABASE_UNAVAILABLE`; Dokument-/Persistenzprobleme nach tatsächlicher Erstellung bleiben gesperrt und werden als `OUTCOME_UNKNOWN`/`DOCUMENTS_FAILED` gemeldet.

Jede bewusste Aktion erhält eine neue, vom Client generierte UUID. Bei Netzwerkfehlern denselben Key und exakt denselben Body wiederverwenden, niemals automatisch neue Keys oder POSTs erzeugen. Derselbe Key + anderer Body ergibt Konflikt. Erfolgreiche/abgelehnte Aktionen werden ohne weiteren DHL-Call wiedergegeben. Unbekannte POST-Ergebnisse oder noch offene Operationen sperren alle neuen Labelaktionen dauerhaft, auch nach Serverrestart. Normaler `create-label` bleibt mit bisherigen Inputs/Outputs kompatibel, nutzt aber dieselbe per-order Sperre und Ledgerprüfung; damit ist Ersatzlabel-Freigabe nicht umgehbar.

## Offizielle Referenz

Die offizielle Seite beschreibt DELETE nur vor Tagesabschluss: https://developer.dhl.com/api-reference/parcel-de-shipping-post-parcel-germany-v2?language_content_entity=en

Exakte Parameter und `LabelDataResponse`/`ResponseItem` wurden aus der dort eingebundenen offiziellen OpenAPI gelesen: https://developer.dhl.com/sites/default/files/2026-10/parcel-de-shipping-v2_4.yaml (lokal als `docs/dhl-parcel-de-shipping-v2_4.yaml` gesichert). `400` für bereits gelöschte/nicht existierende Sendung ist ausdrücklich keine erfolgreiche Stornobestätigung.

## Verbindliche Typen und Optimistic Preconditions (Frontend-Ergänzung)

Alle `generationId`/`currentGenerationId` sind **UUID-Strings**, niemals numerische IDs. `generation` ist die numerische laufende Versionsnummer. `currentGenerationId` ist ohne DHL-Historie `null`; `blocked`, `canCancel`, `canReplace`, `canAttestCancellation` sind Booleans. Generation-`recipient` ist immer ein Objekt mit allen oben dokumentierten Stringfeldern; Legacy-Felder können leere Strings sein (kein `null`, keine Kundenanreicherung). `shippingProfile` und Download-URLs können bei Legacy-Generationen `null` sein. `operations[].state`: `pending | succeeded | rejected | unknown`. `generations[].state`: `active | cancel_pending | cancel_unknown | cancel_rejected | manifested | delivered | cancelled | create_pending | create_unknown | create_rejected | documents_failed`.

History liefert zusätzlich `addressFingerprint` (kanonischer SHA-256-Hexstring über die gegenwärtigen kompletten Empfängerfelder der Bestellung), `currentRecipient` (vollständiges Objekt wie oben), sowie `orderStatus` (nur Anzeige). Vor Ersatzlabel muss die UI History frisch laden und den vollständigen Snapshot ausdrücklich anzeigen/bestätigen.

`replace-label` benötigt zusätzlich zwingend:

```json
{"expectedGenerationId":"prior-generation-uuid","expectedAddressFingerprint":"64-character-hash-issued-by-history"}
```

Backend vergleicht unter derselben per-order Transaktionssperre mit der aktuellen Generation und dem aktuellen Bestelladresssnapshot. Abweichung ergibt `409 STALE_SNAPSHOT`, ohne DHL-Call. Fingerprint niemals clientseitig nachbauen. Der vom Benutzer editierte `recipient` bleibt ein expliziter neuer Snapshot, kann absichtlich von `currentRecipient` abweichen und wird nicht mit Bestellung/Kunde gemischt. Die Preconditions beziehen sich auf die frisch angezeigte Quelle und alte Labelgeneration, nicht auf den neuen Empfänger.

## Read-only Lifecycle-Summary für Bestellliste und Detail

Additives Bestellfeld (Router-Verdrahtung separat):

```ts
dhlLabelLifecycle: { generationId: string | null; state: string; blocked: boolean } | null
```

Backend-Exporte aus `server/dhlLabelLifecycleSummary.ts`:

```ts
export interface DhlLabelLifecycleSummary {
  generationId: string | null;
  state: string;
  blocked: boolean;
}
export async function getDhlLabelLifecycleForOrders(
  orderIds: readonly string[],
): Promise<Map<string, DhlLabelLifecycleSummary>>;
export function isDhlLabelLifecycleUsable(
  summary: DhlLabelLifecycleSummary | null,
): boolean;
```

Der Aufrufer übergibt ausschließlich DHL-/`DHL_PENDING`-Bestell-IDs und setzt `dhlLabelLifecycle = summaries.get(orderId) ?? null`. Ein einziger parametrierter `SELECT` liest die neueste Generation nach numerischer `generation`, überspringt `create_rejected` (wie die Service-Engine) und prüft bestellweit offene Operationen mit `pending`/`unknown`, auch an älteren Generationen. Keine Mutation, keine per-order Sperre, keine Lazy-Archivierung, kein DHL-Call; weder PDFs noch Tracking, Adressen, Akteure oder Snapshots werden gelesen oder ausgegeben. Leere ID-Listen führen zu keinem Datenbankzugriff; doppelte IDs werden dedupliziert.

Ohne aktuelle nicht-abgelehnte Generation **und** ohne ungeklärte Operation gibt es keinen Map-Eintrag: das Feld wird `null` und Legacy-Verhalten bleibt unverändert, auch nach ausschließlich `create_rejected`-Versuchen. Eine ungeklärte Operation ohne aktuelle Generation liefert `{generationId:null,state:"unknown",blocked:true}`. Bei fehlendem Schema, fehlendem Pool oder anderem Ledger-Lesefehler liefert der Helper für **alle angefragten DHL-IDs** konservativ `{generationId:null,state:"unknown",blocked:true}` und wirft nicht die ganze Bestellliste um. Nur bestätigte Schema-/Zugriffsfehler (`42P01` fehlende Relation, `3F000` fehlendes Schema, `42501` fehlende Berechtigung) setzen die Schema-Readiness auf `false`; transiente DB-/Timeoutfehler und ein fehlender Pool ändern den Initialisierungsmarker nicht. Nicht-DHL-Bestellungen bleiben außerhalb dieses Fallbacks. `blocked` für lesbare Generationen bedeutet offene Operation, nicht generell ungültiges Label; auch ein nicht blockiertes `cancelled`-Label ist ungültig.

`isDhlLabelLifecycleUsable(null)` ist `true` (bestehendes Legacy-Verhalten). Sonst ist der Rückgabewert ausschließlich bei `blocked:false` und `state` gleich `active`, `cancel_rejected` oder `manifested` wahr. `cancelled`, `documents_failed`, alle Pending-/Unknown-Zustände, `delivered`, `create_rejected` und unbekannte zukünftige Zustände sind nicht gültig. Aktuelle PDF-Endpunkte können dieses Prädikat vor der Ausgabe verwenden; generationseigene Archivdownloads bleiben ein separater historischer Zugriff.

`server/dhlRelabelSchema.ts` exportiert `isDhlRelabelSchemaReady(): boolean` für das additive `/health/ready`-Feld `dhlLabelLedgerReady` (Verdrahtung separat). Initial ist der Marker `false`; ausschließlich ein vollständig erfolgreicher `ensureDhlRelabelSchema()` setzt ihn auf `true`. Ein fehlgeschlagener Ensure oder bestätigter Schema-/Berechtigungsfehler beim Lesen setzt ihn auf `false`; erfolgreiche Summary-Reads allein setzen ihn nicht wieder auf `true`. Der Marker beschreibt Schema-Initialisierung, nicht die momentane Datenbankverfügbarkeit.

Migration `0031` enthält bewusst **keinen Order-Fremdschlüssel** in beiden Ledger-Tabellen: `order_id` bleibt `VARCHAR(32) NOT NULL`, sodass autorisiertes Bestelllöschen die archivierte Historie erhält. Der `generation_id`-Fremdschlüssel von Operationen zu Generationen mit `ON DELETE RESTRICT` bleibt bestehen. Diese noch nicht deployte Migration wurde direkt angepasst; dies entfernt keine Constraints aus bereits angelegten Tabellen.
