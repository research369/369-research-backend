# 369 Research Backend

Eigenständiges Backend für den 369 Research Peptide Shop.
Deployed auf Railway mit PostgreSQL.

## Stack

- **Runtime**: Node.js 22 + tsx
- **Framework**: Express 4 + tRPC 11
- **Database**: PostgreSQL (Drizzle ORM)
- **Auth**: JWT-basiert (bcrypt + jose)
- **Email**: Resend API
- **Payments**: Bunq API (Zahlungsabgleich)

## Environment Variables

| Variable | Beschreibung |
|---|---|
| `DATABASE_URL` | PostgreSQL Connection String |
| `JWT_SECRET` | Secret für JWT Token Signierung |
| `ADMIN_USERNAME` | Admin Benutzername (default: admin) |
| `ADMIN_PASSWORD` | Admin Passwort (muss gesetzt werden!) |
| `FRONTEND_URL` | Frontend URL für CORS (default: https://www.369research.eu) |
| `BUNQ_API_KEY` | Bunq API Key für Zahlungsabgleich |
| `RESEND_API_KEY` | Resend API Key für E-Mail-Versand |
| `PORT` | Server Port (default: 4000, Railway setzt automatisch) |

## API Endpoints

- `GET /health` – Health Check
- `POST /api/auth/login` – Admin Login
- `POST /api/auth/logout` – Logout
- `GET /api/auth/me` – Aktueller User
- `/api/trpc/*` – tRPC Endpoints (Order, Article, Customer, Label)

## Lokale Entwicklung

```bash
npm install
cp .env.example .env  # Anpassen
npm run dev
```

## Deployment (Railway)

1. GitHub Repo erstellen und pushen
2. Railway Projekt erstellen → "Deploy from GitHub"
3. PostgreSQL Plugin hinzufügen
4. Environment Variables setzen
5. Deploy!
