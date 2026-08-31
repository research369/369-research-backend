# 369 Research – Backend & API

**Live:** https://369-research-backend-production.up.railway.app  
**Hosting:** Railway (Auto-Deploy via GitHub `main` Branch)  
**Repo:** https://github.com/research369/369-research-backend  
**Stand:** Juni 2026

---

## Überblick

Dieses Repository enthält das vollständige Backend für den 369 Research Online-Shop sowie die Warenwirtschaft (WaWi). Es ist ein Node.js/Express-Server mit tRPC, Drizzle ORM und PostgreSQL auf Railway.

| Funktion | Beschreibung |
|---|---|
| **Shop-API** | Produkte, Bestellungen, Checkout, Promo-Codes |
| **WaWi-API** | Bestellverwaltung, Kunden, Labels, Rechnungen, Kampagnen |
| **Partner-System** | Provisionsberechnung, Partner-Portal-API |
| **E-Mail-Service** | Transaktionale E-Mails via Resend API |
| **Versand** | DHL-Label-Erstellung (direkt + via Sendcloud) |
| **Zahlungsabgleich** | Bunq API (automatischer Bankabgleich) |

---

## Tech Stack

| Technologie | Zweck |
|---|---|
| Node.js 22 + TypeScript 5 | Runtime & Typsicherheit |
| Express 4 | HTTP-Server |
| tRPC 11 | Type-safe API (Shop + WaWi) |
| Drizzle ORM | Datenbankzugriff |
| PostgreSQL 16 (Railway) | Datenbank |
| JWT (jose) + bcrypt | Authentifizierung |
| Resend | E-Mail-Versand |
| Bunq API | Zahlungsabgleich |
| DHL API | Label-Erstellung (DE national, V01PAK) |
| Sendcloud | Alternatives Label-System |

---

## Projektstruktur

```
server/
  index.ts                  ← Express-Server, Middleware, Router-Registrierung
  auth.ts                   ← JWT-Auth, Login/Logout, Middleware
  db.ts                     ← Drizzle-Datenbankverbindung
  routers.ts                ← tRPC-Router-Aggregation
  env.ts                    ← Umgebungsvariablen-Validierung
  emailService.ts           ← Resend E-Mail-Templates
  storage.ts                ← S3/CloudFront Datei-Upload
  articleRouter.ts          ← Produkt-CRUD (Shop + WaWi)
  orderRouter.ts            ← Bestellungen (Shop + WaWi)
  customerRouter.ts         ← Kundenverwaltung
  labelRouter.ts            ← DHL-Label-Erstellung
  invoiceRouter.ts          ← Rechnungen
  partnerRouter.ts          ← Partner-Provisionen
  promoCodeRouter.ts        ← Promo-Codes & Rabatte
  followUpRouter.ts         ← Follow-up E-Mail-Kampagnen
  productAdminRouter.ts     ← Produkt-Admin (Academy-Integration)
  dhlService.ts             ← DHL API Service
  dhlExpressRouter.ts       ← DHL Express-Router
  bunqService.ts            ← Bunq Zahlungsabgleich
  aiRouter.ts               ← KI-Funktionen (WaWi-Assist)
drizzle/
  schema.ts                 ← Datenbankschema (Tabellen & Typen)
  migrations/               ← SQL-Migrationsdateien
```

---

## Lokale Entwicklung

```bash
npm install
cp .env.example .env   # Umgebungsvariablen eintragen
npm run dev            # Entwicklungsserver auf Port 4000
npm run check          # TypeScript-Check (MUSS vor Push grün sein)
npm run build          # Production Build
```

**Wichtig:** Kein Push ohne erfolgreichen TypeScript-Check.

---

## Deployment (Railway)

Auto-Deploy bei jedem Push auf `main`.

| Einstellung | Wert |
|---|---|
| Platform | Railway |
| Runtime | Node.js 22 |
| Start Command | `node dist/server/index.js` (via Procfile) |
| Health Check | `GET /health` |
| Port | Automatisch via `PORT` Env-Variable |

---

## Umgebungsvariablen (Railway → Variables)

| Variable | Beschreibung | Pflicht |
|---|---|---|
| `DATABASE_URL` | PostgreSQL Connection String | ja |
| `JWT_SECRET` | Secret für JWT Token Signierung | ja |
| `ADMIN_USERNAME` | WaWi Admin Benutzername | ja |
| `ADMIN_PASSWORD` | WaWi Admin Passwort | ja |
| `FRONTEND_URL` | CORS-Origin: `https://www.369research.eu` | ja |
| `RESEND_API_KEY` | Resend API Key für E-Mail-Versand | ja |
| `BUNQ_API_KEY` | Bunq API Key für Zahlungsabgleich | ja |
| `DHL_API_KEY` | DHL API Key | ja |
| `DHL_BUSINESS_USERNAME` | DHL Business Account Username | ja |
| `DHL_BUSINESS_PASSWORD` | DHL Business Account Passwort | ja |
| `PORT` | Server Port (Railway setzt automatisch) | auto |

---

## API-Endpunkte

| Endpunkt | Methode | Beschreibung |
|---|---|---|
| `/health` | GET | Health Check |
| `/api/auth/login` | POST | WaWi Admin Login |
| `/api/auth/logout` | POST | Logout |
| `/api/auth/me` | GET | Aktueller eingeloggter User |
| `/api/trpc/*` | POST | Alle tRPC-Endpunkte (Shop + WaWi) |
| `/api/dhl/*` | POST | DHL Label-Erstellung |

---

## Datenbankschema (Wichtigste Tabellen)

| Tabelle | Beschreibung |
|---|---|
| `articles` | Produkte mit Preisen, Kategorien, Bildern, Nasenspray-Flag |
| `orders` | Bestellungen mit Items, Kundendaten, Status, Zahlungsstatus |
| `customers` | Kundendaten mit Partner-Zuordnung |
| `partners` | Partner-Affiliates mit Provisionsrate |
| `partner_transactions` | Provisionsabrechnungen |
| `promo_codes` | Rabattcodes |
| `invoices` | Rechnungen |
| `follow_up_campaigns` | E-Mail-Kampagnen |
| `dhl_labels` | Erstellte DHL-Labels mit Tracking-Nummern (`shipmentNo`) |

Schema-Änderungen immer in `drizzle/schema.ts` vornehmen, dann Migration generieren und anwenden.

---

## Authentifizierung

JWT-basiert (kein OAuth). Token wird im Frontend im LocalStorage gespeichert und als `Authorization: Bearer <token>` Header mitgeschickt.

---

## Datenbank-Backup

Automatisches wöchentliches Backup via GitHub Actions (jeden Sonntag 04:00 Uhr DE-Zeit). Artifacts sind 30 Tage verfügbar unter: **Actions → Wöchentliches DB-Backup → Artifacts**.

Datenbankverbindung:
```
Host:     centerbeam.proxy.rlwy.net
Port:     27325
User:     postgres
Database: railway
```

---

## DHL-Integration (Sicherheitsmodus)

Kein echtes Label ohne explizite Bestätigung. Tracking-Feld: `shipmentNo`. Aktuell nur DE national (V01PAK) implementiert.

---

## Verbundene Repositories

| Repo | Beschreibung |
|---|---|
| [research369/369-research-frontend](https://github.com/research369/369-research-frontend) | Shop-Frontend, WaWi-UI, Partner-Portal |
| [research369/369-academy](https://github.com/research369/369-academy) | 369 Research Academy Mitgliederplattform |

*Dokumentation aktualisiert: Juni 2026*
