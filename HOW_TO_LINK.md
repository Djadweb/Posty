# HOW TO LINK - Posty (MVP)

This document explains how to run the local Posty app and link social media (Facebook) using a Cloudflare Tunnel to expose local uploads.

## Overview
- Posty is a minimal two-feature app:
  1) Connect social media accounts (Facebook OAuth)
  2) Upload posts (send a public file URL to Facebook)

Local files must be publicly accessible for social platforms to fetch them. Use Cloudflare Tunnel (`cloudflared`) to expose your frontend uploads directory.

## Prerequisites
- Node.js (v18+)
- npm or pnpm
- Cloudflared (install via `brew install cloudflared` on macOS)

## Setup
1. Install dependencies for backend and frontend

```bash
cd Posty/backend
npm install
cd ../frontend
npm install
```

2. Configure env files
- Copy `Posty/backend/.env.example` to `Posty/backend/.env` and fill values.
- Important values:
  - `BACKEND_URL` – e.g. `http://localhost:4000`
  - `FRONTEND_URL` – set to your public tunnel URL when using cloudflared (e.g. `https://abc.trycloudflare.com`)
  - `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET`

3. Run cloudflared tunnel (to expose frontend uploads)

```bash
cloudflared tunnel --url http://localhost:5173
```

The command prints a `https://<random>.trycloudflare.com` public URL. Use that as `FRONTEND_URL` in backend `.env` and as the public base for uploads.

4. Update Facebook App settings
- In Facebook Developer Console, add the redirect URI:
  `https://<your-tunnel>.trycloudflare.com/integrations/social/facebook`

- Ensure your Facebook app has the permissions you need (for testing, many permissions require review; user-level publish may work in developer mode for admin/test users).

5. Start services

```bash
# backend
cd Posty/backend
npm run dev

# frontend (in another terminal)
cd Posty/frontend
npm run dev
```

6. Use the app
- Open your tunnel URL (or local frontend URL if not using tunnel):
  `https://<your-tunnel>.trycloudflare.com` (or `http://localhost:5173`)
- Click `Connect Facebook` to start OAuth flow.
- After connecting, copy the public file URL (you can use the tunnel URL + `/uploads/...`) and paste it into the post form, then `Post`.

## Notes and Limitations
- Facebook requires public URLs to fetch videos/images. Local `http://localhost` URLs will not work for Facebook.
- Permissions and Graph API behavior depend on your app configuration and review status.
- This MVP stores Facebook `access_token` in a local sqlite DB; tokens may expire.

## Env variables (backend)
- `BACKEND_URL` – backend base (http://localhost:4000)
- `FRONTEND_URL` – frontend base (use tunnel URL for public access)
- `PORT` – backend port
- `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET`

## Security
- This is an MVP and not production-ready. Do not store secrets in plaintext for production.

