const fs = require('fs');
const path = require('path');
const config = require('./config');

// On Railway, mount a volume at /data and set DATA_DIR=/data so changes survive redeploys
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MUSIC_DIR = path.join(DATA_DIR, 'music');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

fs.mkdirSync(MUSIC_DIR, { recursive: true });

const defaults = {
  welcomeMessage: config.WELCOME_MESSAGE,
  musicVolume: config.MUSIC_VOLUME,
  welcomeVolume: config.WELCOME_VOLUME,
  musicFile: null, // filename inside MUSIC_DIR (set by panel upload)
  musicName: null, // original filename, for display
};

function load() {
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { ...defaults };
  }
}

let current = load();

function get() {
  return current;
}

function update(patch) {
  current = { ...current, ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(current, null, 2));
  return current;
}

// Uploaded song if there is one, otherwise the bundled music/waiting.mp3, otherwise null
function getMusicPath() {
  if (current.musicFile) {
    const p = path.join(MUSIC_DIR, current.musicFile);
    if (fs.existsSync(p)) return p;
  }
  const fallback = path.join(__dirname, config.MUSIC_FILE);
  return fs.existsSync(fallback) ? fallback : null;
}

module.exports = { get, update, getMusicPath, MUSIC_DIR, DATA_DIR };
