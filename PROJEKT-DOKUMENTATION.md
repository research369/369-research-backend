# 369 Research – Vollständige Projektdokumentation

**Stand:** 25. April 2026

Dieses Dokument enthält alle relevanten Informationen zum Projekt 369 Research, damit bei einem Sandbox-Verlust, Manus-Session-Abbruch oder Entwicklerwechsel nichts verloren geht. Es umfasst die gesamte Architektur, alle Zugangsdaten, den Deployment-Prozess und den aktuellen Feature-Stand.

---

## 1. Projektübersicht

369 Research ist ein Online-Shop für Forschungspeptide in Pharmaqualität. Das System besteht aus einem React-Frontend (gehostet auf Netlify) und einem Node.js-Backend (gehostet auf Railway), das eine PostgreSQL-Datenbank nutzt. Zusätzlich gibt es eine integrierte Warenwirtschaft (WaWi) und ein Partner-Provisionsportal.

| Komponente | Technologie | Hosting | URL |
|---|---|---|---|
| Frontend + Shop | React 18, Vite, TypeScript, Tailwind CSS | Netlify | https://www.369research.eu |
| Backend + API | Node.js, Express, tRPC, Drizzle ORM | Railway | https://369-research-backend-production.up.railway.app |
| Datenbank | PostgreSQL 16 | Railway | autorack.proxy.rlwy.net:58498 |
| Domain | 369research.eu | Netlify DNS | – |

---

## 2. GitHub-Repositories

Beide Repositories liegen unter dem GitHub-Account **research369** (E-Mail: 369peptides@gmail.com).

| Repository | Sichtbarkeit | URL | Beschreibung |
|---|---|---|---|
| 369-research-backend | Privat | https://github.com/research369/369-research-backend | Backend, API, DB-Schema, Migrationen |
| 369-research-frontend | Privat | https://github.com/research369/369-research-frontend | Frontend, Shop, WaWi, Partner-Portal |

**GitHub Personal Access Token (PAT):**
`[GITHUB PAT – siehe Passwort-Manager oder Manus-Dokumentation]`

Das Frontend-Repo enthält zusätzlich einen Branch `live-build-backup-2026-04-25` mit den kompilierten Build-Artefakten des aktuellen Live-Deploys (Deploy-ID: `69ec627b`). Dieser Branch kann als Notfall-Rollback direkt auf Netlify hochgeladen werden.

---

## 3. Zugangsdaten

### 3.1 Railway (Backend + Datenbank)

| Parameter | Wert |
|---|---|
| Backend-URL | https://369-research-backend-production.up.railway.app |
| Health-Check | GET /health |
| DB Host | autorack.proxy.rlwy.net |
| DB Port | 58498 |
| DB User | postgres |
| DB Password | gNJuGiwYqHTdWjOQljMwIaUtBHClxJzZ |
| DB Name | railway |
| SSL-Hinweis | SSL-Verbindung hat aktuell Probleme; direkte Verbindung von außen ist unzuverlässig. Empfohlen: SQL über Railway Dashboard oder über einen temporären API-Endpoint ausführen. |

### 3.2 Netlify (Frontend Hosting)

| Parameter | Wert |
|---|---|
| Account | 369peptides@gmail.com (Login via Google) |
| Site-ID | b251d2a8-34cb-4eb1-9094-f08394b4d48b |
| Site-Name | 369-research |
| Live-URL | https://www.369research.eu |
| Netlify PAT | nfp_htzvQtC2AB7dSA2NjsMYsQCJXT9EXE7se400 |
| Build-Command | npm run build |
| Publish-Dir | dist/public |

### 3.3 Anwendungs-Logins

| Bereich | Benutzername | Passwort | URL |
|---|---|---|---|
| WaWi Admin | admin | zcmgUSSF2336 | /wawi/login |
| Test-Partner (Max Testpartner) | P-1001 | Test1234! | /partner |

### 3.4 Backend Environment Variables (Railway)

| Variable | Wert / Beschreibung |
|---|---|
| JWT_SECRET | 369research-jwt-secret-2026-railway-production |
| DATABASE_URL | postgresql://postgres:gNJuGiwYqHTdWjOQljMwIaUtBHClxJzZ@autorack.proxy.rlwy.net:58498/railway |

---

## 4. Datenbank-Schema (Drizzle ORM)

Das Schema wird in `drizzle/schema.ts` definiert. Die Migrationen liegen in `drizzle/migrations/`. Aktuell sind **7 Migrationen** registriert (0000 bis 0006).

### Migration 0006 – Partner Transaction Control (25.04.2026)

Diese Migration hat folgende Schema-Änderungen vorgenommen:

1. **Neuer ENUM-Typ `transaction_status`** mit den Werten: `normal`, `storniert`, `nicht_gewertet`, `ausgeblendet`
2. **Neue Spalte `transaction_status`** in der Tabelle `partner_transactions` (Default: `normal`)
3. **Neuer ENUM-Wert `auszahlung`** zum bestehenden `partner_transaction_type` hinzugefügt
4. **Neue Spalte `assigned_partner_id`** in der Tabelle `customers` (Integer, nullable)

---

## 5. Backend-Architektur

Das Backend nutzt Express mit tRPC-ähnlichen Prozeduren. Die wichtigsten Dateien sind:

| Datei | Beschreibung |
|---|---|
| server/index.ts | Express-Server, Middleware, Health-Check |
| server/db.ts | Datenbankverbindung (getDb, getPool, closeDb) |
| server/env.ts | Umgebungsvariablen-Validierung |
| server/partnerRouter.ts | Alle Partner-Endpoints (Portal + WaWi) |
| drizzle/schema.ts | Drizzle ORM Schema-Definitionen |

### Partner-System Endpoints (partnerRouter.ts)

**Partner-Portal (öffentlich, mit Partner-Auth):**
- `portalLogin` – Login mit Partnernummer + Passwort
- `portalLogout` – Abmelden
- `portalMe` – Eigene Daten abrufen
- `portalMyTransactions` – Eigene Transaktionen
- `portalMyOrders` – Eigene geworbene Bestellungen
- `portalMyStats` – Statistiken (beide Modelle: Dauerhaft + Einmalig)
- `portalMyCredit` – Guthaben-Details
- `portalRedeemCredit` – Guthaben einlösen (mit Passwort-Pflicht)
- `portalChangePassword` – Passwort ändern

**WaWi-Verwaltung (Admin-Auth):**
- `list`, `create`, `update`, `delete` – CRUD für Partner
- `getPartnerStats` – Detaillierte Statistiken pro Partner
- `adjustCredit` – Manuelle Guthaben-Anpassung
- `updateTransactionStatus` – Transaktions-Kontrolle (Normal/Storniert/Nicht gewertet/Ausgeblendet)
- `recordPayout` – Auszahlung buchen
- `assignPartnerToCustomer` – Partner einem Kunden zuordnen (mit rückwirkender Provisionsberechnung)
- `removePartnerFromCustomer` – Partner-Zuordnung entfernen
- `redeemCreditByNumber` – Guthaben per Partnernummer einlösen (Checkout, mit Passwort-Pflicht)

---

## 6. Frontend-Architektur

Das Frontend ist eine Single Page Application (SPA) mit React Router. Die wichtigsten Seiten sind:

| Route | Komponente | Beschreibung |
|---|---|---|
| / | Homepage | Shop-Startseite mit Produktübersicht |
| /shop | Shop | Produktkatalog |
| /product/:slug | ProductPage | Einzelne Produktseite |
| /checkout | Checkout | Warenkorb + Bestellung |
| /partner | PartnerPortal | Partner-Login + Dashboard |
| /wawi/login | WaWiLogin | WaWi-Anmeldung |
| /wawi | WaWiDashboard | WaWi-Übersicht |
| /wawi/customers | WaWiCustomers | Kundenverwaltung (CRM) |
| /wawi/partners | WaWiPartners | Partner-Verwaltung |
| /wawi/orders | WaWiOrders | Bestellverwaltung |
| /calculator | Calculator | Dosierungsrechner |

---

## 7. Deployment-Anleitung

### 7.1 Backend (Railway – automatisch)

Railway deployed automatisch bei jedem Push auf den `main`-Branch des Backend-Repos. Der Prozess ist:

1. Code auf GitHub pushen: `git push origin main`
2. Railway erkennt den Push und startet automatisch einen Build
3. Nach ca. 2–3 Minuten ist das neue Backend live
4. Verifizierung: `curl https://369-research-backend-production.up.railway.app/health`

### 7.2 Frontend (Netlify – manuell via CLI)

Das Frontend wird über die Netlify CLI deployed:

```bash
# Im Frontend-Projektverzeichnis
npm install
npm run build

# Deploy auf Netlify
NETLIFY_AUTH_TOKEN=nfp_htzvQtC2AB7dSA2NjsMYsQCJXT9EXE7se400 \
NETLIFY_SITE_ID=b251d2a8-34cb-4eb1-9094-f08394b4d48b \
npx netlify deploy --prod --dir=dist/public
```

### 7.3 DB-Migrationen

Da die direkte DB-Verbindung von außen wegen SSL-Problemen unzuverlässig ist, gibt es zwei Wege:

**Option A – Railway Dashboard:** SQL direkt im Railway Dashboard unter "Data" → "Query" einfügen und ausführen.

**Option B – Temporärer API-Endpoint:** Einen abgesicherten Endpoint im Backend einbauen (wie bei Migration 0006 geschehen), auf GitHub pushen, Railway deployed automatisch, dann den Endpoint aufrufen, und anschließend den Endpoint wieder entfernen.

---

## 8. Notfall-Rollback

Falls ein Deploy fehlschlägt oder die Seite nicht mehr funktioniert:

1. **Frontend:** Im Netlify Dashboard unter "Deploys" auf ein früheres Deploy klicken und "Publish deploy" wählen. Alternativ den Branch `live-build-backup-2026-04-25` aus dem Frontend-Repo herunterladen und den Inhalt von `dist/public/` manuell auf Netlify deployen.

2. **Backend:** Im Railway Dashboard unter "Deployments" auf ein früheres Deployment klicken und "Rollback" wählen.

---

## 9. Aktuelle Partner (Stand 25.04.2026)

| Partnernr. | Name | Modell | Code | Provision | Kundenrabatt | Guthaben |
|---|---|---|---|---|---|---|
| P-1000 | Doc Ben | Dauerhaft (Guthaben) | DOCB | 10% | 75% | 9,30€ |
| P-1001 | Max Testpartner | Dauerhaft (Guthaben) | MAX15 | 10% | 10% | 0,00€ |
| P-1002 | Madita Krakowsky | Dauerhaft (Guthaben) | MADDY | 10% | 10% | 0,00€ |
| P-1003 | Adriano Cricchio | Dauerhaft (Guthaben) | ADRIANO | 10% | 10% | 0,00€ |

---

*Dokumentation erstellt am 25.04.2026 durch Manus AI.*
