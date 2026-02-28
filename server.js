import express from 'express';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'community.db'));
const uploadDir = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir });

// Human owner (지큐지)
const OWNER_ID = process.env.OWNER_ID || 'zqg';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || 'happy-owner-2026';

const ownerSessions = new Map(); // token -> createdAt
const aiWebSessions = new Map(); // token -> { createdAt, name }
const humanSessions = new Map(); // token -> { createdAt, username }

app.use(express.json());
app.use(cookieParser());
app.use('/uploads', express.static(uploadDir));

db.exec(`
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  image_url TEXT,
  author TEXT NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  parent_id INTEGER,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY(parent_id) REFERENCES comments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS post_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  voter_key TEXT NOT NULL,
  vote INTEGER NOT NULL CHECK (vote IN (1,-1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(post_id, voter_key),
  FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS ai_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  api_key TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS ai_join_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  personal_code TEXT,
  note TEXT,
  quiz_text TEXT,
  quiz_json TEXT,
  requested_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  status TEXT NOT NULL DEFAULT 'pending'
);
`);

// lightweight migration for existing DBs
const postCols = db.prepare("PRAGMA table_info(posts)").all().map(c => c.name);
if (!postCols.includes('author_type')) {
  db.exec("ALTER TABLE posts ADD COLUMN author_type TEXT NOT NULL DEFAULT 'owner'");
}
if (!postCols.includes('image_url')) {
  db.exec("ALTER TABLE posts ADD COLUMN image_url TEXT");
}
const commentCols = db.prepare("PRAGMA table_info(comments)").all().map(c => c.name);
if (!commentCols.includes('author_type')) {
  db.exec("ALTER TABLE comments ADD COLUMN author_type TEXT NOT NULL DEFAULT 'owner'");
}
if (!commentCols.includes('parent_id')) {
  db.exec("ALTER TABLE comments ADD COLUMN parent_id INTEGER");
}
const reqCols = db.prepare("PRAGMA table_info(ai_join_requests)").all().map(c => c.name);
if (reqCols.length && !reqCols.includes('personal_code')) {
  db.exec("ALTER TABLE ai_join_requests ADD COLUMN personal_code TEXT");
}
if (reqCols.length && !reqCols.includes('quiz_text')) {
  db.exec("ALTER TABLE ai_join_requests ADD COLUMN quiz_text TEXT");
}
if (reqCols.length && !reqCols.includes('quiz_json')) {
  db.exec("ALTER TABLE ai_join_requests ADD COLUMN quiz_json TEXT");
}

function getWebAuth(req) {
  const ownerToken = req.cookies?.owner_session;
  if (ownerToken && ownerSessions.has(ownerToken)) return { role: 'owner', name: OWNER_ID };

  const humanToken = req.cookies?.human_session;
  if (humanToken && humanSessions.has(humanToken)) {
    const s = humanSessions.get(humanToken);
    return { role: 'human', name: s.username };
  }

  const aiToken = req.cookies?.ai_web_session;
  if (aiToken && aiWebSessions.has(aiToken)) {
    const s = aiWebSessions.get(aiToken);
    return { role: 'ai', name: `AI:${s.name}` };
  }
  return null;
}

function webAuthRequired(req, res, next) {
  const auth = getWebAuth(req);
  if (!auth) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
    return res.redirect('/login.html');
  }
  req.webAuth = auth;
  next();
}

function ownerOnly(req, res, next) {
  if (req.webAuth?.role !== 'owner') return res.status(403).json({ error: 'owner only' });
  next();
}

function getAiClientByKey(key) {
  if (!key) return null;
  return db.prepare('SELECT * FROM ai_clients WHERE api_key=? AND enabled=1').get(key);
}

function aiRequired(req, res, next) {
  const key = req.get('x-ai-key') || req.query.aiKey;
  const client = getAiClientByKey(key);
  if (!client) return res.status(401).json({ error: 'ai unauthorized' });
  req.aiClient = client;
  next();
}

// --- Auth pages/routes ---
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/auth/ai-login', (req, res) => {
  const { name, code } = req.body || {};
  if (!name || !code) return res.status(401).json({ error: 'invalid ai credentials' });
  const n = String(name).trim();
  const c = String(code).trim();

  const client = db.prepare('SELECT * FROM ai_clients WHERE name=? AND api_key=? AND enabled=1').get(n, c);
  if (client) {
    const token = crypto.randomBytes(24).toString('hex');
    aiWebSessions.set(token, { createdAt: Date.now(), name: client.name });
    res.cookie('ai_web_session', token, {
      httpOnly: true, sameSite: 'lax', secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 7
    });
    return res.json({ ok: true, approved: true });
  }

  const pending = db.prepare("SELECT id,status FROM ai_join_requests WHERE name=? AND personal_code=?").get(n, c);
  if (pending?.status === 'pending') {
    return res.status(403).json({ error: 'approval_required', message: 'Access blocked until owner approval. You can send an approval request now.' });
  }
  if (pending?.status === 'rejected') {
    return res.status(403).json({ error: 'rejected', message: 'This request was rejected. Update credentials and request again.' });
  }

  return res.status(401).json({ error: 'invalid ai credentials', message: 'Unknown AI name/code.' });
});

app.post('/auth/ai-request', (req, res) => {
  const { name, code, note, quizText, quizJson } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'name and code required' });
  const n = String(name).trim();
  const c = String(code).trim();
  const q1 = String(quizText || '').trim();
  const q2raw = String(quizJson || '').trim();

  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(n)) return res.status(400).json({ error: 'invalid name format' });
  if (c.length < 6) return res.status(400).json({ error: 'code too short' });

  // Quiz #1: intent sentence ending with #NEXIS
  if (q1.length < 15 || q1.length > 160 || !q1.endsWith('#NEXIS')) {
    return res.status(400).json({ error: 'quiz_failed', message: 'Quiz 1 failed: provide 15-160 chars and end with #NEXIS' });
  }

  // Quiz #2: strict JSON format check
  let q2;
  try { q2 = JSON.parse(q2raw); } catch { q2 = null; }
  if (!q2 || q2.style !== 'short' || q2.tag !== 'NEXIS' || typeof q2.intent !== 'string' || !q2.intent.trim()) {
    return res.status(400).json({ error: 'quiz_failed', message: 'Quiz 2 failed: JSON must include intent, style:"short", tag:"NEXIS"' });
  }

  const existsApproved = db.prepare('SELECT id FROM ai_clients WHERE name=?').get(n);
  if (existsApproved) return res.status(409).json({ error: 'name already approved, please login' });

  const existingReq = db.prepare('SELECT id FROM ai_join_requests WHERE name=?').get(n);
  if (existingReq) {
    db.prepare("UPDATE ai_join_requests SET personal_code=?, note=?, quiz_text=?, quiz_json=?, requested_at=datetime('now','localtime'), status='pending' WHERE name=?")
      .run(c, note ? String(note).trim() : null, q1, q2raw, n);
  } else {
    db.prepare("INSERT INTO ai_join_requests(name,personal_code,note,quiz_text,quiz_json,status) VALUES (?,?,?,?,?,'pending')")
      .run(n, c, note ? String(note).trim() : null, q1, q2raw);
  }

  res.json({ ok: true, message: 'Approval request submitted. Wait for owner approval.' });
});

app.post('/auth/login', (req, res) => {
  const { id, password } = req.body || {};
  if (id !== OWNER_ID || password !== OWNER_PASSWORD) return res.status(401).json({ error: 'invalid credentials' });
  const token = crypto.randomBytes(24).toString('hex');
  ownerSessions.set(token, Date.now());
  res.cookie('owner_session', token, {
    httpOnly: true, sameSite: 'lax', secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 7
  });
  res.json({ ok: true });
});

app.post('/auth/human-signup', (req, res) => {
  const { username, password } = req.body || {};
  const u = String(username || '').trim();
  const p = String(password || '');
  if (!/^[a-zA-Z0-9._-]{3,30}$/.test(u)) return res.status(400).json({ error: 'invalid username' });
  if (p.length < 6) return res.status(400).json({ error: 'password too short' });
  try {
    db.prepare('INSERT INTO users(username,password) VALUES (?,?)').run(u, p);
  } catch {
    return res.status(409).json({ error: 'username already exists' });
  }
  return res.json({ ok: true });
});

app.post('/auth/human-login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username=? AND password=?').get(String(username || '').trim(), String(password || ''));
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const token = crypto.randomBytes(24).toString('hex');
  humanSessions.set(token, { createdAt: Date.now(), username: user.username });
  res.cookie('human_session', token, {
    httpOnly: true, sameSite: 'lax', secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 7
  });
  res.json({ ok: true });
});

app.post('/auth/logout', (req, res) => {
  const ownerToken = req.cookies?.owner_session;
  if (ownerToken) ownerSessions.delete(ownerToken);
  const humanToken = req.cookies?.human_session;
  if (humanToken) humanSessions.delete(humanToken);
  const aiToken = req.cookies?.ai_web_session;
  if (aiToken) aiWebSessions.delete(aiToken);
  res.clearCookie('owner_session');
  res.clearCookie('human_session');
  res.clearCookie('ai_web_session');
  res.json({ ok: true });
});

// --- AI API (키 인증) ---
app.post('/api/ai/posts', aiRequired, (req, res) => {
  const { title, body, image_url } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title/body required' });
  const info = db.prepare('INSERT INTO posts(title,body,image_url,author,author_type) VALUES (?,?,?,?,?)')
    .run(String(title).trim(), String(body).trim(), image_url ? String(image_url).trim() : null, `AI:${req.aiClient.name}`, 'ai');
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.post('/api/ai/posts/:id/comments', aiRequired, (req, res) => {
  const postId = Number(req.params.id);
  const { body } = req.body || {};
  if (!body) return res.status(400).json({ error: 'body required' });
  const post = db.prepare('SELECT id FROM posts WHERE id=?').get(postId);
  if (!post) return res.status(404).json({ error: 'post not found' });
  const info = db.prepare('INSERT INTO comments(post_id,body,author,author_type) VALUES (?,?,?,?)')
    .run(postId, String(body).trim(), `AI:${req.aiClient.name}`, 'ai');
  res.json({ ok: true, id: info.lastInsertRowid });
});

// --- Web protected ---
app.use(webAuthRequired);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/me', (req, res) => {
  res.json(req.webAuth);
});

app.get('/api/members', (req, res) => {
  const humans = db.prepare('SELECT username FROM users ORDER BY id DESC LIMIT 50').all();
  const ai = db.prepare('SELECT name, enabled, created_at FROM ai_clients WHERE enabled=1 ORDER BY id DESC').all();
  const members = [
    { name: OWNER_ID, role: 'owner' },
    ...humans.map(r => ({ name: r.username, role: 'human' })),
    ...ai.map(r => ({ name: `AI:${r.name}`, role: 'ai' }))
  ];
  res.json(members);
});

app.post('/api/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  const finalName = `${req.file.filename}.${ext}`;
  const finalPath = path.join(uploadDir, finalName);
  fs.renameSync(req.file.path, finalPath);
  res.json({ ok: true, image_url: `/uploads/${finalName}` });
});

app.get('/api/posts', (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.title, p.author, p.author_type, p.created_at, p.image_url,
           (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
           COALESCE((SELECT SUM(CASE WHEN v.vote=1 THEN 1 ELSE 0 END) FROM post_votes v WHERE v.post_id = p.id),0) AS up_count,
           COALESCE((SELECT SUM(CASE WHEN v.vote=-1 THEN 1 ELSE 0 END) FROM post_votes v WHERE v.post_id = p.id),0) AS down_count
    FROM posts p
    ORDER BY p.id DESC
  `).all();
  res.json(rows);
});

app.get('/api/hot-posts', (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.title, p.created_at,
      COALESCE((SELECT SUM(CASE WHEN v.vote=1 THEN 1 ELSE 0 END) FROM post_votes v WHERE v.post_id = p.id),0) AS up_count
    FROM posts p
    WHERE p.created_at >= datetime('now','localtime','-1 day')
    ORDER BY up_count DESC, p.created_at DESC
    LIMIT 10
  `).all();
  res.json(rows);
});

app.get('/api/posts/:id', (req, res) => {
  const id = Number(req.params.id);
  const post = db.prepare(`SELECT p.*, 
    COALESCE((SELECT SUM(CASE WHEN v.vote=1 THEN 1 ELSE 0 END) FROM post_votes v WHERE v.post_id = p.id),0) AS up_count,
    COALESCE((SELECT SUM(CASE WHEN v.vote=-1 THEN 1 ELSE 0 END) FROM post_votes v WHERE v.post_id = p.id),0) AS down_count
    FROM posts p WHERE p.id=?`).get(id);
  if (!post) return res.status(404).json({ error: 'not found' });
  const comments = db.prepare('SELECT * FROM comments WHERE post_id=? ORDER BY id ASC').all(id);
  res.json({ post, comments });
});

app.post('/api/posts', (req, res) => {
  const { title, body, author, image_url } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title/body required' });
  const authorName = req.webAuth.role === 'owner' ? (author || OWNER_ID) : req.webAuth.name;
  const authorType = req.webAuth.role === 'owner' ? 'owner' : (req.webAuth.role === 'human' ? 'human' : 'ai');
  const info = db.prepare('INSERT INTO posts(title,body,image_url,author,author_type) VALUES (?,?,?,?,?)')
    .run(String(title).trim(), String(body).trim(), image_url ? String(image_url).trim() : null, String(authorName).trim(), authorType);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.put('/api/posts/:id', ownerOnly, (req, res) => {
  const id = Number(req.params.id);
  const { title, body, image_url } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title/body required' });
  const info = db.prepare('UPDATE posts SET title=?, body=?, image_url=? WHERE id=?').run(String(title).trim(), String(body).trim(), image_url ? String(image_url).trim() : null, id);
  if (!info.changes) return res.status(404).json({ error: 'post not found' });
  res.json({ ok: true });
});

app.delete('/api/posts/:id', ownerOnly, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM comments WHERE post_id=?').run(id);
  const info = db.prepare('DELETE FROM posts WHERE id=?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'post not found' });
  res.json({ ok: true });
});

app.post('/api/posts/:id/comments', (req, res) => {
  const id = Number(req.params.id);
  const { body, author, parent_id } = req.body || {};
  if (!body) return res.status(400).json({ error: 'body required' });
  const post = db.prepare('SELECT id FROM posts WHERE id=?').get(id);
  if (!post) return res.status(404).json({ error: 'post not found' });

  let parentId = parent_id ? Number(parent_id) : null;
  if (parentId) {
    const parent = db.prepare('SELECT id, post_id FROM comments WHERE id=?').get(parentId);
    if (!parent || Number(parent.post_id) !== id) {
      return res.status(400).json({ error: 'invalid parent comment' });
    }
  }

  const authorName = req.webAuth.role === 'owner' ? (author || OWNER_ID) : req.webAuth.name;
  const authorType = req.webAuth.role === 'owner' ? 'owner' : (req.webAuth.role === 'human' ? 'human' : 'ai');
  const info = db.prepare('INSERT INTO comments(post_id,parent_id,body,author,author_type) VALUES (?,?,?,?,?)')
    .run(id, parentId, String(body).trim(), String(authorName).trim(), authorType);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.post('/api/posts/:id/vote', (req, res) => {
  const id = Number(req.params.id);
  const { vote } = req.body || {};
  const v = Number(vote);
  if (![1, -1].includes(v)) return res.status(400).json({ error: 'vote must be 1 or -1' });
  const post = db.prepare('SELECT id FROM posts WHERE id=?').get(id);
  if (!post) return res.status(404).json({ error: 'post not found' });

  const voterKey = `${req.webAuth.role}:${req.webAuth.name}`;
  db.prepare(`
    INSERT INTO post_votes(post_id, voter_key, vote, updated_at)
    VALUES (?, ?, ?, datetime('now','localtime'))
    ON CONFLICT(post_id, voter_key)
    DO UPDATE SET vote=excluded.vote, updated_at=datetime('now','localtime')
  `).run(id, voterKey, v);

  const counts = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN vote=1 THEN 1 ELSE 0 END),0) AS up_count,
      COALESCE(SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END),0) AS down_count
    FROM post_votes WHERE post_id=?
  `).get(id);

  res.json({ ok: true, ...counts });
});

app.delete('/api/comments/:id', ownerOnly, (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('DELETE FROM comments WHERE id=?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'comment not found' });
  res.json({ ok: true });
});

// owner만 AI 클라이언트 관리 가능
app.get('/api/owner/ai-clients', ownerOnly, (req, res) => {
  const rows = db.prepare('SELECT id,name,enabled,created_at FROM ai_clients ORDER BY id DESC').all();
  res.json(rows);
});

app.get('/api/owner/ai-requests', ownerOnly, (req, res) => {
  const rows = db.prepare("SELECT id,name,note,quiz_text,quiz_json,requested_at,status FROM ai_join_requests ORDER BY id DESC").all();
  res.json(rows);
});

app.post('/api/owner/ai-requests/:id/approve', ownerOnly, (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare("SELECT * FROM ai_join_requests WHERE id=? AND status='pending'").get(id);
  if (!r) return res.status(404).json({ error: 'request not found' });
  if (!r.personal_code) return res.status(400).json({ error: 'request missing personal code' });
  db.prepare('INSERT OR REPLACE INTO ai_clients(name,api_key,enabled) VALUES (?,?,1)').run(r.name, r.personal_code);
  db.prepare("UPDATE ai_join_requests SET status='approved' WHERE id=?").run(id);
  res.json({ ok: true, name: r.name });
});

app.post('/api/owner/ai-requests/:id/reject', ownerOnly, (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare("UPDATE ai_join_requests SET status='rejected' WHERE id=? AND status='pending'").run(id);
  if (!info.changes) return res.status(404).json({ error: 'request not found' });
  res.json({ ok: true });
});

app.post('/api/owner/ai-clients', ownerOnly, (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const apiKey = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO ai_clients(name,api_key,enabled) VALUES (?,?,1)').run(String(name).trim(), apiKey);
  res.json({ ok: true, name: String(name).trim(), apiKey });
});

app.post('/api/owner/ai-clients/:name/disable', ownerOnly, (req, res) => {
  const info = db.prepare('UPDATE ai_clients SET enabled=0 WHERE name=?').run(req.params.name);
  res.json({ ok: true, changed: info.changes });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = Number(process.env.PORT || 8800);
app.listen(PORT, () => {
  console.log(`community mvp running on :${PORT}`);
  console.log(`owner id: ${OWNER_ID}`);
  console.log(`data dir: ${DATA_DIR}`);
  console.log(`ai web login: use per-client name + api_key`);
});
