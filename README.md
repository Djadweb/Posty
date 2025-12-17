# Posty — simple social uploader (MVP)

Small demo project to connect a Facebook account/page, upload media, and publish posts (video/image) from a minimal web UI.

This workspace contains two parts:
- `backend/` — Express server that handles OAuth, stores tokens in a lightweight SQLite DB, serves uploaded files and posts to Facebook pages.
- `frontend/` — small React (Vite) single-page app that lets you connect accounts, upload files, and publish posts.

## Features
- Facebook OAuth (stores user + page tokens)
- Upload files (served from `/uploads` and accessible via ngrok in development)
- Post media to Facebook Pages using page access tokens
- Simple UI with upload progress and account/profile previews

## Requirements
- Node.js (v18+ recommended)
- npm or yarn
- ngrok (recommended for Facebook OAuth redirect URI during development)

## Environment variables
Create a `.env` in `backend/` with at least:

- `FACEBOOK_APP_ID` — your Facebook App ID
- `FACEBOOK_APP_SECRET` — your Facebook App Secret
- `BACKEND_URL` — public URL used by Facebook as redirect (in dev use your ngrok HTTPS URL, e.g. https://xxxx.ngrok.io)
- `FRONTEND_URL` — frontend URL (defaults to http://localhost:5173)
- Optional: `PUBLIC_URL` or `NGROK_URL` to force public URL used for upload links

Example `backend/.env`:

FACEBOOK_APP_ID=your_app_id
FACEBOOK_APP_SECRET=your_app_secret
BACKEND_URL=https://uncrooked-unfussing-dakota.ngrok-free.dev
FRONTEND_URL=http://localhost:5173

Note: Do not commit `.env` (it's ignored by `.gitignore`).

## Installation

1. Install backend deps

```bash
cd backend
npm install
```

2. Install frontend deps

```bash
cd ../frontend
npm install
```

## Running in development

1. Start the backend (from `/backend`):

```bash
cd backend
npm run dev
```

If the backend port (4000) is already used, pick another port with `PORT=4001 npm run dev`.

2. Run the frontend (from `/frontend`):

```bash
cd frontend
npm run dev
```

3. Start ngrok and forward to your backend port (if Facebook requires HTTPS redirect URIs):

```bash
ngrok http 4000
# note the https URL shown, e.g. https://xxxx.ngrok-free.dev
```

4. In the Facebook Developer dashboard, register the Redirect URI exactly:

```
https://<your-ngrok-host>/auth/facebook/callback
```

Replace `<your-ngrok-host>` with the HTTPS ngrok URL.

## How to use

1. Open the frontend (Vite) URL (default http://localhost:5173).
2. Click **Connect Facebook** — this redirects to Facebook OAuth. Complete the flow.
3. After redirect, the backend stores user and any page access tokens. Refresh accounts in the UI.
4. Select a connected *page* account (the app prefers `facebook_page` accounts).
5. Use **Upload file** to upload an image/video — upload progress will show and the `File public URL` is populated.
6. Click **Post** to publish the media to the selected page.

Notes:
- The app stores tokens in `backend/data/posty.db` (SQLite). This file is ignored by git.
- Uploaded files are placed in `backend/public/uploads` and served from `/uploads/<filename>`.
- In development, the backend attempts to discover ngrok's public URL and return correct public links for uploaded files.

## Facebook permissions and App Review

- The app requests page-related permissions (`pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_read_user_content`) and `public_profile`.
- Publishing on behalf of a Page requires using the Page Access Token (this project fetches page tokens after OAuth and stores them).
- If you need additional publish scopes that require App Review (e.g., wider publishing permissions), request them via Facebook App Review before using them for non-developer users.

## Troubleshooting

- If you see `Invalid Scopes` errors during OAuth: remove unsupported scopes or request the permissions via App Review.
- If the backend says `EADDRINUSE` when starting, another process is using port 4000. Either stop that process or run backend on another port: `PORT=4001 npm run dev`.
- If the frontend cannot fetch `/accounts`, ensure CORS is allowed (`FRONTEND_URL` matches) and the backend is reachable.

## Development tips

- To test Facebook flows locally, run ngrok and use the HTTPS tunnel as your `BACKEND_URL` and in the Facebook Redirect URIs.
- To reset stored accounts, delete `backend/data/posty.db` (or remove rows via sqlite3).

## Files of interest
- Backend: [backend/src/index.js](backend/src/index.js)
- Frontend: [frontend/src/App.jsx](frontend/src/App.jsx)

---
If you want, I can commit the README and changes, or add more documentation (example .env.development file, screenshots, or a demo script). Which would you like next?
