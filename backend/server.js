import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';

const app = express();
const db = new Database('data.db');
const SECRET = process.env.JWT_SECRET || 'dev-secret';
const PORT = process.env.PORT || 3001;

db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cities (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT, country TEXT,
  lat REAL, lon REAL, note TEXT DEFAULT ''
);`);

app.use(cors());
app.use(express.json());

// ---------- helpers ----------
const sign = (u) => jwt.sign({ id: u.id, email: u.email }, SECRET, { expiresIn: '7d' });
const auth = (req, res, next) => {
  try {
    req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
};
const getJson = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Upstream error ${r.status}`);
  return r.json();
};

// ---------- auth ----------
app.post('/api/auth/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 6)
    return res.status(400).json({ error: 'Valid email and 6+ char password required' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const { lastInsertRowid } = db.prepare('INSERT INTO users (email, password) VALUES (?, ?)').run(email, hash);
    res.status(201).json({ token: sign({ id: lastInsertRowid, email }), email });
  } catch {
    res.status(409).json({ error: 'Email already registered' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password || '', user.password))
    return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: sign(user), email: user.email });
});

// ---------- external API: city search (Open-Meteo geocoding) ----------
app.get('/api/search', auth, async (req, res) => {
  try {
    const q = encodeURIComponent(req.query.q || '');
    const data = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=5`);
    res.json((data.results || []).map((c) => ({
      name: c.name, country: c.country, lat: c.latitude, lon: c.longitude,
    })));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- cities CRUD ----------
app.get('/api/cities', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM cities WHERE user_id = ? ORDER BY id DESC').all(req.user.id));
});

app.post('/api/cities', auth, (req, res) => {
  const { name, country, lat, lon } = req.body;
  if (!name || lat == null || lon == null) return res.status(400).json({ error: 'Missing fields' });
  const { lastInsertRowid } = db
    .prepare('INSERT INTO cities (user_id, name, country, lat, lon) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, name, country, lat, lon);
  res.status(201).json(db.prepare('SELECT * FROM cities WHERE id = ?').get(lastInsertRowid));
});

app.patch('/api/cities/:id', auth, (req, res) => {
  const r = db.prepare('UPDATE cities SET note = ? WHERE id = ? AND user_id = ?')
    .run(req.body.note ?? '', req.params.id, req.user.id);
  r.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
});

app.delete('/api/cities/:id', auth, (req, res) => {
  const r = db.prepare('DELETE FROM cities WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  r.changes ? res.status(204).end() : res.status(404).json({ error: 'Not found' });
});

// ---------- external API: live weather (Open-Meteo forecast) ----------
app.get('/api/cities/:id/weather', auth, async (req, res) => {
  const city = db.prepare('SELECT * FROM cities WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!city) return res.status(404).json({ error: 'Not found' });
  try {
    const d = await getJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
      `&current=temperature_2m,wind_speed_10m,relative_humidity_2m`
    );
    res.json(d.current);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
