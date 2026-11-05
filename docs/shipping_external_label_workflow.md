# Versandworkflow: DHL-Automatik und externe Labels

## Zweck

Der Packabschluss unterscheidet zwischen Sendungen mit aktivem DHL-Profil und Sendungen, für deren Zielland aktuell kein aktives DHL-Profil hinterlegt ist. Dadurch kann ein Auftrag nicht mehr am automatischen DHL-Schritt hängen bleiben, wenn ein Label bei einem anderen Versanddienstleister gebucht werden muss.

Der Workflow ist **zentral profilgesteuert**. Er enthält keine Pflege einzelner Länder im Frontend. Die Verfügbarkeit ergibt sich ausschließlich aus den aktiven DHL-Profilen in `server/dhlProfiles.ts`.

## Ablauf

| Situation | Verhalten beim Packabschluss | Folgeprozess |
|---|---|---|
| Aktives DHL-Profil vorhanden | Der bisherige automatische DHL-Prozess bleibt unverändert: Adressprüfung, Labelerstellung, PDF-Öffnung/Druck und bestehende Versandkommunikation. | Auftrag wird wie bisher automatisch weitergeführt. |
| Kein aktives DHL-Profil vorhanden | Pflichtfoto, Packstatus und Chargenzuordnung werden zunächst normal verarbeitet. Der DHL-Call sowie die DHL-spezifische Adressprüfung werden übersprungen. | Der Dialog **„Externes Versandlabel hochladen“** öffnet sich. |
| Externes PDF gespeichert | Versanddienstleister ist Pflicht; Trackingnummer ist optional. Die Daten werden am Auftrag gespeichert. | Auftrag wechselt nach `zu_versenden`. Der Versandabschluss bleibt ein bewusster separater Schritt. |
| Externer Dialog ohne PDF geschlossen | Der Auftrag bleibt bewusst `gepackt`. | Kein Schein-Label, kein automatischer Versandstatus und keine Versandmail. Das Label kann später über die Aktion „Label“ hochgeladen werden. |

## Zentrale Schnittstellen

| Baustein | Aufgabe |
|---|---|
| `GET /api/shipping/dhl/availability/:country` | Liefert authentifiziert, ob mindestens ein aktives DHL-Profil das normalisierte Zielland bedienen kann. |
| `POST label.uploadLabel` | Speichert hochgeladene Labels. Bei einem bewusst übergebenen externen Carrier werden Carrier und optionale Trackingnummer autoritativ übernommen und **nicht** als DHL klassifiziert. Ohne externen Carrier bleibt die bestehende DHL-Extraktion aktiv. |
| `GET /api/shipping/label/:orderId` | Geschützter Abruf für DHL- und externe Labeldateien. Große Base64-Daten bleiben außerhalb der Bestellliste. |
| `order.list` | Liefert für jedes gespeicherte Label nur die geschützte Abrufroute; externe Labels ohne Trackingnummer bleiben dadurch sichtbar. |

## Sicherheitsregeln

> Ein extern gebuchtes Label darf niemals als DHL-Label gespeichert werden, nur weil eine Trackingnummer erkannt oder hochgeladen wurde.

Die DHL-Verfügbarkeit wird vor dem automatischen Aufruf geprüft. Die Schweiz ist derzeit ein Beispiel für den externen Ablauf, weil `DHL_CH` bewusst inaktiv ist: Ohne Billing Number und Zollanbindung darf kein automatischer DHL-Versuch erfolgen. Sobald ein DHL-Profil in `dhlProfiles.ts` vollständig aktiviert wird, wechselt das betreffende Ziel ohne Frontend-Codeänderung automatisch wieder in den DHL-Automatikprozess.

Für den bestehenden DHL-Workflow wurden weder DHL-Profile, Drucklogik, Statusübergänge noch die Versandkommunikation verändert.

## Veröffentlichte Änderungen

| Repository | Commit | Inhalt |
|---|---|---|
| Backend | `94f6ace` | Profilbasierte DHL-Verfügbarkeit, externer Carrier/Tracking-Speicher und geschützter gemeinsamer Labelabruf. |
| Frontend | `698df95` | Packabschluss-Fallback, externer Labeldialog sowie sichtbarer, sicherer Nachhol-Upload. |

## Prüfungen

Der Profiltest bestätigt: Deutschland hat weiterhin `DHL_DE_STANDARD` als aktives Auto-Label-Profil; die Schweiz hat nur `DHL_CH`, das aktuell inaktiv ist, und fällt daher in den externen Labelprozess. Vor der Veröffentlichung wurden Frontend- und Backend-TypeScript-Prüfungen sowie der vollständige Frontend-Produktionsbuild ausgeführt.
