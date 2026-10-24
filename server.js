import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import OpenAI from 'openai';

const app = express();
const port = Number(process.env.PORT || 8080);
const openaiKey = process.env.OPENAI_API_KEY;
const mysqlApiUrl = process.env.MYSQL_API_URL;
const maxAudioMb = Math.min(Math.max(Number(process.env.MAX_AUDIO_MB || 20), 1), 24);
if (!openaiKey) throw new Error('OPENAI_API_KEY is required in server environment');
if (!mysqlApiUrl) throw new Error('MYSQL_API_URL is required in server environment');
const openai = new OpenAI({ apiKey: openaiKey });

const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.disable('x-powered-by');
app.use(cors({ origin(origin, callback) {
  // Native Android requests often have no Origin header; authentication is still required.
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error('Origin not allowed by CORS'));
}, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type'] }));
app.use(express.json({ limit: '16kb' }));
app.use('/v1/transcribe', rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: true, legacyHeaders: false }));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxAudioMb * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['audio/wav', 'audio/x-wav', 'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/m4a', 'application/octet-stream']);
    cb(allowed.has(file.mimetype) ? null : new Error('Unsupported audio MIME type'), allowed.has(file.mimetype));
  }
});

async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'Sign in required.' });
  try {
    // Validate the existing Sehchari session with its own API; do not trust a UID sent by the app.
    const meUrl = new URL(mysqlApiUrl);
    meUrl.searchParams.set('route', 'me');
    const response = await fetch(meUrl, { headers: { Authorization: `Bearer ${match[1]}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok || !body?.user?.uid) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    req.appUser = { uid: String(body.user.uid) };
    next();
  } catch {
    return res.status(503).json({ error: 'Authentication service temporarily unavailable.' });
  }
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/v1/transcribe', authenticate, upload.single('audio'), async (req, res) => {
  if (!req.file?.buffer?.length) return res.status(400).json({ error: 'Audio file is required.' });
  const extByMime = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/m4a': 'm4a', 'application/octet-stream': 'wav' };
  const ext = extByMime[req.file.mimetype] || 'wav';
  try {
    const transcript = await openai.audio.transcriptions.create({
      file: new File([req.file.buffer], `jap-audio.${ext}`, { type: req.file.mimetype }),
      model: 'gpt-transcribe',
      response_format: 'json',
      languages: ['hi', 'sa'],
      prompt: 'Hindu devotional mantra chanting. Common words include Radha, Krishna, Ram, Narayan, Hari, Vishnu, Radha Vallabh Shri Harivansh, Saamb Sadashiv. Transcribe what is actually spoken; do not add words.'
    });
    // Do not log audio or transcript; return only what the app needs.
    return res.json({ text: (transcript.text || '').trim() });
  } catch (err) {
    console.error('Transcription request failed', { status: err?.status, code: err?.code });
    return res.status(502).json({ error: 'Transcription failed. Please try again.' });
  }
});
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Audio must be under ${maxAudioMb} MB.` : 'Invalid upload.' });
  if (err?.message === 'Origin not allowed by CORS') return res.status(403).json({ error: 'Origin not allowed.' });
  if (err) return res.status(400).json({ error: err.message || 'Invalid request.' });
  return res.status(500).json({ error: 'Unexpected server error.' });
});
app.listen(port, '0.0.0.0', () => console.log(`Transcription API listening on ${port}`));
