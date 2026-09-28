const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const settings = require('./settings');
const panelHtml = require('./panelHtml');

const PASSWORD = process.env.PANEL_PASSWORD;
const PORT = process.env.PORT || 3000;

if (!PASSWORD) {
  console.warn('[!] PANEL_PASSWORD is not set - the web panel is DISABLED. Add it as a variable to enable it.');
  return;
}

const app = express();

// ---------- Password protection (browser login popup) ----------
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

app.use((req, res, next) => {
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    if (safeEqual(pass, PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Verification Bot Panel"');
  res.status(401).send('Login required');
});

app.use(express.json());
app.get('/', (req, res) => res.type('html').send(panelHtml));

// ---------- Upload handling ----------
const ALLOWED_EXT = ['.mp3', '.wav', '.ogg', '.m4a', '.flac'];
const upload = multer({
  storage: multer.diskStorage({
    destination: settings.MUSIC_DIR,
    filename: (req, file, cb) =>
      cb(null, `music-${Date.now()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (req, file, cb) => {
    const ok = ALLOWED_EXT.includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Only mp3, wav, ogg, m4a or flac files are allowed'), ok);
  },
});

function removeOldMusic(exceptFile) {
  const old = settings.get().musicFile;
  if (old && old !== exceptFile) {
    fs.rm(path.join(settings.MUSIC_DIR, old), { force: true }, () => {});
  }
}

function publicSettings() {
  const s = settings.get();
  return {
    welcomeMessage: s.welcomeMessage,
    additionalMessage: s.additionalMessage,
    musicVolume: s.musicVolume,
    welcomeVolume: s.welcomeVolume,
    persistent: settings.PERSISTENT,
    hasMusic: !!settings.getMusicPath(),
    musicName: s.musicName || (settings.getMusicPath() ? 'Default waiting music' : null),
  };
}

// ---------- API ----------
app.get('/api/settings', (req, res) => res.json(publicSettings()));

app.post('/api/settings', (req, res) => {
  const { welcomeMessage, additionalMessage, musicVolume, welcomeVolume } = req.body || {};
  const patch = {};

  for (const [key, value] of [['welcomeMessage', welcomeMessage], ['additionalMessage', additionalMessage]]) {
    if (value === undefined) continue;
    const text = String(value).trim();
    if (!text) return res.status(400).json({ error: 'Messages cannot be empty' });
    if (text.length > 200) return res.status(400).json({ error: 'Messages must be 200 characters or less' });
    patch[key] = text;
  }
  if (musicVolume !== undefined) patch.musicVolume = Math.min(1, Math.max(0, Number(musicVolume) || 0));
  if (welcomeVolume !== undefined) patch.welcomeVolume = Math.min(2, Math.max(0, Number(welcomeVolume) || 0));

  settings.update(patch);
  res.json(publicSettings());
});

app.post('/api/music', (req, res) => {
  upload.single('song')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    removeOldMusic(req.file.filename);
    settings.update({ musicFile: req.file.filename, musicName: req.file.originalname });
    res.json(publicSettings());
  });
});

app.delete('/api/music', (req, res) => {
  removeOldMusic(null);
  settings.update({ musicFile: null, musicName: null });
  res.json(publicSettings());
});

app.get('/api/music/file', (req, res) => {
  const p = settings.getMusicPath();
  if (!p) return res.status(404).end();
  res.sendFile(p);
});

app.listen(PORT, () => console.log(`Control panel running on port ${PORT}`));
