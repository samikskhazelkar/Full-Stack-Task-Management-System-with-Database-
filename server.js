import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
const SECRET = process.env.JWT_SECRET;
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(helmet());
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

/* ---------- Auth ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DUMMY = bcrypt.hashSync('dummy', 12);
const sign = (u) => jwt.sign({}, SECRET, { subject: String(u.id), expiresIn: '12h', algorithm: 'HS256' });

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
app.use('/api/auth', limiter);

app.post('/api/auth/register', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'Email already registered' });
  const hash = await bcrypt.hash(password, 12);
  const { lastInsertRowid } = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, hash);
  res.status(201).json({ token: sign({ id: lastInsertRowid }), email });
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = await bcrypt.compare(String(req.body?.password || ''), user?.password_hash || DUMMY);
  if (!user || !ok) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: sign(user), email });
});

function auth(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.userId = Number(jwt.verify(token, SECRET, { algorithms: ['HS256'] }).sub);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/* ---------- Tasks ---------- */
const STATUS = ['todo', 'in_progress', 'done'];
const PRIORITY = ['low', 'medium', 'high'];

function clean(b = {}, partial = false) {
  const o = {};
  if (!partial || 'title' in b) {
    const t = String(b.title ?? '').trim();
    if (!t || t.length > 200) return { error: 'Title is required (max 200 characters)' };
    o.title = t;
  }
  if ('description' in b) o.description = String(b.description ?? '').slice(0, 2000);
  if ('status' in b) { if (!STATUS.includes(b.status)) return { error: 'Invalid status' }; o.status = b.status; }
  if ('priority' in b) { if (!PRIORITY.includes(b.priority)) return { error: 'Invalid priority' }; o.priority = b.priority; }
  if ('due_date' in b) {
    if (!b.due_date) o.due_date = null;
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(b.due_date)) return { error: 'due_date must be YYYY-MM-DD' };
    else o.due_date = b.due_date;
  }
  return { value: o };
}

const tasks = express.Router();
tasks.use(auth);

tasks.get('/', (req, res) => {
  const where = ['user_id = @userId'];
  const params = { userId: req.userId };
  if (STATUS.includes(req.query.status)) { where.push('status = @status'); params.status = req.query.status; }
  if (PRIORITY.includes(req.query.priority)) { where.push('priority = @priority'); params.priority = req.query.priority; }
  if (req.query.q) { where.push('(title LIKE @q OR description LIKE @q)'); params.q = `%${String(req.query.q).slice(0, 100)}%`; }
  const rows = db.prepare(`
    SELECT * FROM tasks WHERE ${where.join(' AND ')}
    ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
             due_date IS NULL, due_date, id DESC`).all(params);
  res.json({ tasks: rows });
});

tasks.post('/', (req, res) => {
  const { value, error } = clean(req.body);
  if (error) return res.status(400).json({ error });
  const cols = Object.keys(value); // keys come from the fixed whitelist in clean()
  const info = db.prepare(
    `INSERT INTO tasks (user_id, ${cols.join(', ')}) VALUES (@userId, ${cols.map((c) => '@' + c).join(', ')})`
  ).run({ userId: req.userId, ...value });
  res.status(201).json({ task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid) });
});

tasks.patch('/:id', (req, res) => {
  const { value, error } = clean(req.body, true);
  if (error) return res.status(400).json({ error });
  const cols = Object.keys(value);
  if (!cols.length) return res.status(400).json({ error: 'Nothing to update' });
  const info = db.prepare(
    `UPDATE tasks SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = CURRENT_TIMESTAMP
     WHERE id = @id AND user_id = @userId`
  ).run({ id: Number(req.params.id), userId: req.userId, ...value });
  if (!info.changes) return res.status(404).json({ error: 'Task not found' });
  res.json({ task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id)) });
});

tasks.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.userId);
  if (!info.changes) return res.status(404).json({ error: 'Task not found' });
  res.status(204).end();
});

app.use('/api/tasks', tasks);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.type === 'entity.parse.failed' ? 400 : 500).json({ error: 'Request failed' });
});

app.listen(PORT, () => console.log(`Task Manager running at http://localhost:${PORT}`));
