require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(bodyParser.json());

// Simple CORS middleware for development: allow the frontend origin to call this API
app.use((req, res, next) => {
  const allowed = process.env.FRONTEND_URL || 'http://localhost:5173';
  res.header('Access-Control-Allow-Origin', allowed);
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
const DB_PATH = path.join(__dirname, '..', 'data', 'posty.db');
const fs = require('fs');
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Ensure uploads directory exists and serve it
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// multer for file uploads
const multer = require('multer');
const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, uploadsDir); },
  filename: function (req, file, cb) { const unique = Date.now() + '-' + Math.random().toString(36).slice(2,8); cb(null, unique + '-' + file.originalname); }
});
const upload = multer({ storage });

const db = new sqlite3.Database(DB_PATH);

// initialize tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT,
    provider_user_id TEXT,
    access_token TEXT,
    refresh_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});
// Add display_name column if missing (safe attempt)
db.serialize(() => {
  db.get("PRAGMA table_info(accounts)", (err) => {
    // attempt to add column; ignore errors if already exists
    db.run(`ALTER TABLE accounts ADD COLUMN display_name TEXT`, () => {});
  });
});

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// Start Facebook OAuth flow
app.get('/auth/facebook', (req, res) => {
  const clientId = process.env.FACEBOOK_APP_ID;
  const redirect = `${process.env.BACKEND_URL || 'http://localhost:4000'}/auth/facebook/callback`;
  const scope = 'pages_show_list,pages_read_engagement,pages_manage_posts,pages_read_user_content,public_profile';
  const url = `https://www.facebook.com/v17.0/dialog/oauth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(scope)}&response_type=code`;
  res.redirect(url);
});

// Return a public URL (prefer ngrok) so frontend can build file URLs automatically
app.get('/public_url', async (req, res) => {
  try {
    // Prefer explicit env override
    if (process.env.PUBLIC_URL) return res.json({ public_url: process.env.PUBLIC_URL });

    // Try ngrok local API
    const ngrokApi = 'http://127.0.0.1:4040/api/tunnels';
    const r = await axios.get(ngrokApi, { timeout: 2000 });
    const tunnels = r.data && r.data.tunnels ? r.data.tunnels : [];
    let public_url = null;
    if (tunnels.length) {
      const httpsTunnel = tunnels.find(t => t.proto === 'https') || tunnels[0];
      public_url = httpsTunnel.public_url.replace(/\/$/, '');
    }

    // Fallbacks
    if (!public_url) public_url = process.env.NGROK_URL || process.env.FRONTEND_URL || FRONTEND_URL;
    return res.json({ public_url });
  } catch (err) {
    console.error('public_url lookup failed', err.message || err);
    return res.json({ public_url: process.env.PUBLIC_URL || process.env.NGROK_URL || process.env.FRONTEND_URL || FRONTEND_URL });
  }
});

// Upload endpoint: accepts a single file field `file` and returns public URL
app.post('/upload', upload.single('file'), (req, res) => {
  (async () => {
    try {
      if (!req.file) return res.status(400).json({ error: 'file required' });

      // Try to discover a public URL via ngrok local API
      let publicBase = process.env.PUBLIC_URL || process.env.NGROK_URL || process.env.FRONTEND_URL || process.env.BACKEND_URL || null;
      try {
        const r = await axios.get('http://127.0.0.1:4040/api/tunnels', { timeout: 1000 });
        const tunnels = r.data && r.data.tunnels ? r.data.tunnels : [];
        if (tunnels.length) {
          const httpsTunnel = tunnels.find(t => t.proto === 'https') || tunnels[0];
          publicBase = httpsTunnel.public_url.replace(/\/$/, '');
        }
      } catch (e) {
        // ignore ngrok lookup failures
      }

      if (!publicBase) publicBase = process.env.BACKEND_URL || 'http://localhost:4000';
      const fileUrl = `${publicBase}/uploads/${req.file.filename}`;
      return res.json({ url: fileUrl });
    } catch (err) {
      console.error('upload error', err);
      res.status(500).json({ error: 'upload failed' });
    }
  })();
});

// OAuth callback - exchange code for token and store
app.get('/auth/facebook/callback', async (req, res) => {
  const { code } = req.query;
  const clientId = process.env.FACEBOOK_APP_ID;
  const clientSecret = process.env.FACEBOOK_APP_SECRET;
  const redirect = `${process.env.BACKEND_URL || 'http://localhost:4000'}/auth/facebook/callback`;
  try {
    const tokenRes = await axios.get('https://graph.facebook.com/v17.0/oauth/access_token', {
      params: {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirect,
        code,
      },
    });

    const access_token = tokenRes.data.access_token;

    // Get user id
    const me = await axios.get('https://graph.facebook.com/me', { params: { access_token } });
    const provider_user_id = me.data.id;

    // store the user account (basic)
    db.run(`INSERT INTO accounts (provider, provider_user_id, access_token) VALUES (?,?,?)`, ['facebook_user', provider_user_id, access_token]);

    // fetch pages the user manages and store page access tokens for posting
    try {
      const pagesRes = await axios.get('https://graph.facebook.com/v17.0/me/accounts', { params: { access_token } });
      const pages = pagesRes.data && pagesRes.data.data ? pagesRes.data.data : [];
      pages.forEach(p => {
        // insert page account (provider_user_id = page.id) and save page access_token
        db.run(`INSERT INTO accounts (provider, provider_user_id, access_token, display_name) VALUES (?,?,?,?)`, ['facebook_page', p.id, p.access_token, p.name]);
      });
    } catch (e) {
      console.error('Could not fetch pages', e?.response?.data || e.message);
    }

    // Redirect back to frontend
    res.redirect(process.env.FRONTEND_URL || FRONTEND_URL);
  } catch (err) {
    console.error('FB callback error', err?.response?.data || err.message);
    res.status(500).send('OAuth error');
  }
});

// Simple endpoint to list stored accounts
app.get('/accounts', (req, res) => {
  db.all('SELECT id,provider,provider_user_id,display_name,created_at FROM accounts', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Return account details including a profile/picture for Facebook accounts
app.get('/accounts/:id', async (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM accounts WHERE id = ?', [id], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'account not found' });

    const result = { ...row };
    try {
      if (row.provider && row.provider.startsWith('facebook') && row.provider_user_id && row.access_token) {
        // Use the stored token to fetch profile/page picture
        const graphRes = await axios.get(`https://graph.facebook.com/v17.0/${row.provider_user_id}`, {
          params: { fields: 'name,picture.type(large)', access_token: row.access_token }
        });
        if (graphRes.data) {
          result.display_name = graphRes.data.name || result.display_name;
          result.picture = graphRes.data.picture && graphRes.data.picture.data && graphRes.data.picture.data.url ? graphRes.data.picture.data.url : null;
        }
      }
    } catch (e) {
      // ignore errors from FB graph, return whatever we have
      console.error('Could not fetch account picture', e?.response?.data || e.message || e);
    }

    res.json(result);
  });
});

// Endpoint to post a URL/video to Facebook using stored token (MVP)
app.post('/posts', async (req, res) => {
  const { accountId, file_url, message } = req.body;
  if (!accountId || !file_url) return res.status(400).json({ error: 'accountId and file_url required' });

  db.get('SELECT * FROM accounts WHERE id = ?', [accountId], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'account not found' });

    try {
      // Post to the page ID using the stored token (for pages use /{page_id}/videos)
      const pageId = row.provider_user_id;
      const params = new URLSearchParams();
      params.append('file_url', file_url);
      if (message) params.append('description', message);
      params.append('access_token', row.access_token);

      const fbRes = await axios.post(`https://graph.facebook.com/v17.0/${pageId}/videos`, params);
      res.json({ success: true, result: fbRes.data });
    } catch (err) {
      console.error('Error posting to FB', err?.response?.data || err.message);
      return res.status(500).json({ error: err?.response?.data || err.message });
    }
  });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Posty backend listening on ${port}`));
