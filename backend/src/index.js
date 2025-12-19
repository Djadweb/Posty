// ...existing code...
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
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

// Debug: log incoming TikTok callback requests (help diagnose ngrok/route issues)
app.use((req, res, next) => {
  if (req.path && req.path.startsWith('/auth/tiktok/callback')) {
    console.log('DEBUG incoming callback', { method: req.method, path: req.path, query: req.query });
  }
  next();
});

const DB_PATH = path.join(__dirname, '..', 'data', 'posty.db');
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
const FormData = require('form-data');

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
// store oauth states for PKCE / verification
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    provider TEXT,
    code_verifier TEXT,
    redirect_uri TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // attempt to add redirect_uri column if table existed previously without it
  db.run(`ALTER TABLE oauth_states ADD COLUMN redirect_uri TEXT`, () => {});
});
// Add display_name column if missing (safe attempt)
db.serialize(() => {
  db.get("PRAGMA table_info(accounts)", (err) => {
    // attempt to add column; ignore errors if already exists
    db.run(`ALTER TABLE accounts ADD COLUMN display_name TEXT`, () => {});
  });
});

// Deduplicate existing accounts (keep the row with the highest id for each provider+provider_user_id)
db.serialize(() => {
  db.all("SELECT provider, provider_user_id, GROUP_CONCAT(id) as ids, COUNT(*) as cnt FROM accounts GROUP BY provider, provider_user_id HAVING cnt>1", [], (err, rows) => {
    if (err) return console.error('Error checking duplicate accounts', err.message || err);
    if (!rows || !rows.length) {
      // ensure uniqueness index exists
      db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider_user ON accounts(provider, provider_user_id)", (ixErr) => { if (ixErr) console.error('Could not create unique index', ixErr.message || ixErr); });
      return;
    }

    rows.forEach(r => {
      try {
        const ids = (r.ids || '').split(',').map(x => parseInt(x, 10)).filter(Boolean);
        if (ids.length <= 1) return;
        const keep = Math.max(...ids);
        const toDelete = ids.filter(i => i !== keep);
        if (toDelete.length) {
          const placeholders = toDelete.map(() => '?').join(',');
          db.run(`DELETE FROM accounts WHERE id IN (${placeholders})`, toDelete, function (dErr) {
            if (dErr) return console.error('Failed to delete duplicate accounts', dErr.message || dErr);
            console.log(`Removed duplicate account rows for provider=${r.provider} provider_user_id=${r.provider_user_id}: removed ${toDelete.length} row(s)`);
          });
        }
      } catch (e) {
        console.error('Error deduping accounts row', e.message || e);
      }
    });

    // Create unique index after cleanup
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider_user ON accounts(provider, provider_user_id)", (ixErr) => { if (ixErr) console.error('Could not create unique index', ixErr.message || ixErr); });
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

// Start TikTok OAuth flow (configurable endpoints)
app.get('/auth/tiktok', async (req, res) => {
  const clientKey = process.env.TT_CLIENT_KEY;
  const scope = process.env.TT_SCOPES || 'user.info.basic,video.list';
  const authUrl = process.env.TT_AUTH_URL || 'https://sandbox.tiktokapi.com/auth/authorize/';
  const state = Math.random().toString(36).slice(2,10);

  // Determine public base for redirect_uri (PUBLIC_URL env, ngrok, or BACKEND_URL)
  let publicBase = process.env.PUBLIC_URL || process.env.NGROK_URL || process.env.BACKEND_URL || 'http://localhost:4000';
  try {
    const r = await axios.get('http://127.0.0.1:4040/api/tunnels', { timeout: 1000 });
    const tunnels = r.data && r.data.tunnels ? r.data.tunnels : [];
    if (tunnels.length) {
      const targetPort = process.env.PORT || '4000';
      const portStr = `:${targetPort}`;
      const httpsTunnel = tunnels.find(t => t.proto === 'https' && t.config && t.config.addr && t.config.addr.includes(portStr)) || tunnels.find(t => t.proto === 'https') || tunnels[0];
      publicBase = httpsTunnel.public_url.replace(/\/$/, '');
    }
  } catch (e) {
    // ignore ngrok lookup failures
  }

  const redirect = `${publicBase}/auth/tiktok/callback`;

  // PKCE: generate a URL-safe code_verifier and code_challenge (S256)
  const base64Url = (str) => str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const codeVerifier = base64Url(crypto.randomBytes(96).toString('base64'));
  const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest('base64'));

  // persist the code_verifier and redirect tied to this state
  db.run('INSERT OR REPLACE INTO oauth_states (state, provider, code_verifier, redirect_uri) VALUES (?,?,?,?)', [state, 'tiktok', codeVerifier, redirect], (err) => {
    if (err) console.error('Could not save oauth state', err.message || err);
    // Build auth url including PKCE params
    const url = `${authUrl}?client_key=${clientKey}&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(scope)}&response_type=code&state=${state}&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256`;
    res.redirect(url);
  });
});

// TikTok OAuth callback
app.get('/auth/tiktok/callback', async (req, res) => {
  const { code, state } = req.query;
  const clientKey = process.env.TT_CLIENT_KEY;
  const clientSecret = process.env.TT_CLIENT_SECRET;
  const redirect = `${process.env.BACKEND_URL || 'http://localhost:4000'}/auth/tiktok/callback`;
  const tokenUrl = process.env.TT_TOKEN_URL || 'https://open.tiktokapis.com/v1/oauth/token';
  try {
    // retrieve code_verifier stored for this state (PKCE)
    let codeVerifier = null;
    let storedRedirect = null;
    if (state) {
      await new Promise((resolve) => {
        db.get('SELECT code_verifier, redirect_uri FROM oauth_states WHERE state = ?', [state], (err, row) => {
          if (!err && row) {
            if (row.code_verifier) codeVerifier = row.code_verifier;
            if (row.redirect_uri) storedRedirect = row.redirect_uri;
          }
          // cleanup the state entry
          db.run('DELETE FROM oauth_states WHERE state = ?', [state], () => {});
          resolve();
        });
      });
    }

    // Exchange code for token. Include code_verifier if available (PKCE)
    const tokenPayload = {
      client_key: clientKey,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: storedRedirect || redirect
    };
    if (codeVerifier) tokenPayload.code_verifier = codeVerifier;

    // prefer form-encoded payload for token endpoints
    const qs = new URLSearchParams(tokenPayload).toString();
    console.log('TikTok token exchange ->', { tokenUrl, tokenPayload: Object.assign({}, tokenPayload, { client_secret: 'REDACTED' }) });
    const tokenRes = await axios.post(tokenUrl, qs, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const data = tokenRes.data || {};
    console.log('TikTok token response:', JSON.stringify(data).slice(0, 2000));
    const access_token = data.access_token || data.data && data.data.access_token;
    const refresh_token = data.refresh_token || data.data && data.data.refresh_token;
    const open_id = data.open_id || data.data && data.data.open_id || data.data && data.data.open_id;

    if (!access_token) {
      console.error('TikTok token response', data);
      return res.status(500).send('TikTok OAuth failed');
    }

    // store tiktok user
    db.run(`INSERT INTO accounts (provider, provider_user_id, access_token, refresh_token, display_name) VALUES (?,?,?,?,?)`, ['tiktok_user', open_id || 'unknown', access_token, refresh_token, null]);

    res.redirect(process.env.FRONTEND_URL || FRONTEND_URL);
  } catch (err) {
    const resp = err?.response;
    console.error('TikTok callback error:', {
      status: resp?.status,
      headers: resp?.headers,
      data: resp?.data,
      message: err.message
    });
    const body = resp?.data || { error: err.message };
    return res.status(resp?.status || 500).json({ error: 'TikTok OAuth error', details: body });
  }
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
          const targetPort = process.env.PORT || '4000';
          const portStr = `:${targetPort}`;
          const httpsTunnel = tunnels.find(t => t.proto === 'https' && t.config && t.config.addr && t.config.addr.includes(portStr)) || tunnels.find(t => t.proto === 'https') || tunnels[0];
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

    // store or update the facebook_user account (avoid duplicates)
    db.get('SELECT id FROM accounts WHERE provider = ? AND provider_user_id = ?', ['facebook_user', provider_user_id], (gErr, gRow) => {
      if (gErr) {
        console.error('DB error checking facebook_user', gErr.message || gErr);
      } else if (gRow && gRow.id) {
        db.run('UPDATE accounts SET access_token = ? WHERE id = ?', [access_token, gRow.id], (uErr) => { if (uErr) console.error('Could not update facebook_user token', uErr.message || uErr); });
      } else {
        db.run(`INSERT INTO accounts (provider, provider_user_id, access_token) VALUES (?,?,?)`, ['facebook_user', provider_user_id, access_token], (iErr) => { if (iErr) console.error('Could not insert facebook_user', iErr.message || iErr); });
      }
    });

    // fetch pages the user manages and upsert page access tokens for posting
    try {
      const pagesRes = await axios.get('https://graph.facebook.com/v17.0/me/accounts', { params: { access_token } });
      const pages = pagesRes.data && pagesRes.data.data ? pagesRes.data.data : [];
      pages.forEach(p => {
        // upsert page account (provider_user_id = page.id) and save page access_token/display_name
        db.get('SELECT id FROM accounts WHERE provider = ? AND provider_user_id = ?', ['facebook_page', p.id], (pgErr, pgRow) => {
          if (pgErr) return console.error('DB error checking facebook_page', pgErr.message || pgErr);
          if (pgRow && pgRow.id) {
            db.run('UPDATE accounts SET access_token = ?, display_name = ? WHERE id = ?', [p.access_token, p.name || null, pgRow.id], (upErr) => { if (upErr) console.error('Could not update facebook_page', upErr.message || upErr); });
          } else {
            db.run('INSERT INTO accounts (provider, provider_user_id, access_token, display_name) VALUES (?,?,?,?)', ['facebook_page', p.id, p.access_token, p.name || null], (insErr) => { if (insErr) console.error('Could not insert facebook_page', insErr.message || insErr); });
          }
        });
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
      if (row.provider && row.provider.startsWith('facebook')) {
        // Post to the page ID using the stored token (for pages use /{page_id}/videos)
        const pageId = row.provider_user_id;
        const params = new URLSearchParams();
        params.append('file_url', file_url);
        if (message) params.append('description', message);
        params.append('access_token', row.access_token);

        const fbRes = await axios.post(`https://graph.facebook.com/v17.0/${pageId}/videos`, params);
        return res.json({ success: true, result: fbRes.data });
      }

      if (row.provider && row.provider.startsWith('tiktok')) {
        // TikTok posting flow (generic / configurable via env vars)
        // Steps: upload media to TikTok upload endpoint, then create/publish video
        const ttUploadUrl = process.env.TT_UPLOAD_URL; // endpoint to POST file multipart
        const ttCreateVideoUrl = process.env.TT_CREATE_VIDEO_URL; // endpoint to finalize/create video
        const accessToken = row.access_token;

        if (!ttUploadUrl || !ttCreateVideoUrl) return res.status(500).json({ error: 'TikTok endpoints not configured (TT_UPLOAD_URL, TT_CREATE_VIDEO_URL)' });

        // fetch file stream
        const fileResp = await axios.get(file_url, { responseType: 'stream' });

        const form = new FormData();
        form.append('video', fileResp.data, { filename: path.basename(file_url) });

        const uploadRes = await axios.post(ttUploadUrl, form, {
          headers: {
            ...form.getHeaders(),
            Authorization: `Bearer ${accessToken}`
          },
          maxBodyLength: Infinity
        });

        // Expecting uploadRes.data to include an upload_id or similar identifier
        const uploadId = uploadRes.data && (uploadRes.data.upload_id || uploadRes.data.data && (uploadRes.data.data.upload_id || uploadRes.data.data.video_id));

        if (!uploadId) {
          return res.status(500).json({ error: 'TikTok upload did not return upload id', raw: uploadRes.data });
        }

        // finalize / create the video
        const createRes = await axios.post(ttCreateVideoUrl, { upload_id: uploadId, text: message || '' }, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });

        return res.json({ success: true, result: createRes.data });
      }

      return res.status(400).json({ error: 'Unsupported provider for posting' });
    } catch (err) {
      console.error('Error posting', err?.response?.data || err.message);
      return res.status(500).json({ error: err?.response?.data || err.message });
    }
  });
});

// --- Facebook page management endpoints ---

// Return pages the connected Facebook user manages (requires a stored facebook_user access token)
app.get('/facebook/available_pages', async (req, res) => {
  // pick the most recent facebook_user entry (single-user app assumption)
  db.get("SELECT access_token FROM accounts WHERE provider = 'facebook_user' ORDER BY id DESC LIMIT 1", [], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row || !row.access_token) return res.status(404).json({ error: 'No connected Facebook user found' });
    try {
      const pagesRes = await axios.get('https://graph.facebook.com/v17.0/me/accounts', { params: { access_token: row.access_token } });
      const pages = pagesRes.data && pagesRes.data.data ? pagesRes.data.data : [];
      return res.json({ pages });
    } catch (e) {
      console.error('Could not fetch pages', e?.response?.data || e.message || e);
      return res.status(500).json({ error: 'Could not fetch pages', details: e?.response?.data || e.message });
    }
  });
});

// Save a selected page to our DB (body: { pageId, pageAccessToken, pageName })
app.post('/facebook/pages', (req, res) => {
  const { pageId, pageAccessToken, pageName } = req.body;
  if (!pageId || !pageAccessToken) return res.status(400).json({ error: 'pageId and pageAccessToken required' });

  // avoid duplicates
  db.get('SELECT id FROM accounts WHERE provider = ? AND provider_user_id = ?', ['facebook_page', pageId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (row) return res.json({ ok: true, message: 'Page already added', id: row.id });

    db.run(`INSERT INTO accounts (provider, provider_user_id, access_token, display_name) VALUES (?,?,?,?)`, ['facebook_page', pageId, pageAccessToken, pageName || null], function (err2) {
      if (err2) return res.status(500).json({ error: err2.message });
      return res.json({ ok: true, id: this.lastID });
    });
  });
});

// List connected Facebook pages stored in our DB
app.get('/facebook/connected_pages', (req, res) => {
  db.all("SELECT id, provider_user_id AS page_id, display_name, created_at FROM accounts WHERE provider = 'facebook_page'", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    return res.json({ pages: rows });
  });
});

// Remove a connected page and unsubscribe from webhooks (if possible)
app.delete('/facebook/pages/:pageId', async (req, res) => {
  const pageId = req.params.pageId;
  db.get('SELECT id, access_token FROM accounts WHERE provider = ? AND provider_user_id = ?', ['facebook_page', pageId], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Page not found' });

    // attempt to unsubscribe the page from app webhooks
    try {
      await axios.delete(`https://graph.facebook.com/v17.0/${pageId}/subscribed_apps`, { params: { access_token: row.access_token } });
    } catch (e) {
      // non-fatal: log and proceed to remove local data
      console.warn('Could not unsubscribe page from subscribed_apps', e?.response?.data || e.message || e);
    }

    db.run('DELETE FROM accounts WHERE id = ?', [row.id], function (dErr) {
      if (dErr) return res.status(500).json({ error: dErr.message });
      return res.json({ ok: true });
    });
  });
});

// Disconnect Facebook account entirely: revoke permissions and remove stored accounts/pages
app.post('/facebook/disconnect', async (req, res) => {
  // find user token
  db.get("SELECT id, access_token FROM accounts WHERE provider = 'facebook_user' ORDER BY id DESC LIMIT 1", [], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row || !row.access_token) {
      // ensure we still delete any stored pages
      db.run("DELETE FROM accounts WHERE provider = 'facebook_page'", [], () => {});
      return res.json({ ok: true, message: 'No facebook user found, removed pages if any' });
    }

    try {
      // revoke app permissions for the user (this removes the app from user's FB account)
      await axios.delete('https://graph.facebook.com/v17.0/me/permissions', { params: { access_token: row.access_token } });
    } catch (e) {
      console.warn('Could not revoke user permissions', e?.response?.data || e.message || e);
    }

    // delete all accounts where provider is 'facebook', 'facebook_user', or 'facebook_page' (case-insensitive)
    db.run("DELETE FROM accounts WHERE LOWER(provider) = 'facebook' OR LOWER(provider) = 'facebook_user' OR LOWER(provider) = 'facebook_page'", [], function (dErr) {
      if (dErr) return res.status(500).json({ error: dErr.message });
      return res.json({ ok: true });
    });
  });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Posty backend listening on ${port}`));
