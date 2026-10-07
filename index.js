require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const FFMPEG = require('ffmpeg-static') || 'ffmpeg';
process.env.FFMPEG_PATH = FFMPEG;
const { Client, GatewayIntentBits, Events } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  StreamType,
} = require('@discordjs/voice');
const googleTTS = require('google-tts-api');
const config = require('./config');
const settings = require('./settings');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// ---------- State ----------
let connection = null;
let player = null;
let queue = []; // messages waiting to be spoken: 'first' or 'additional'
let playingWelcome = false;

// ---------- Audio helpers ----------
let connecting = null; // promise while we are joining, so simultaneous joins wait for the same connection
let currentStartedAt = 0;
let currentKind = null; // 'music' | 'welcome'
let quickMusicEnds = 0; // how many times in a row the music ended almost instantly

// Decode any audio (file path or Buffer) to raw PCM ourselves, so ffmpeg errors show up in the logs
function makeResource(input, volume) {
  const isBuffer = Buffer.isBuffer(input);
  const args = ['-hide_banner', '-loglevel', 'error', '-i', isBuffer ? 'pipe:0' : input,
    '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'];
  const proc = spawn(FFMPEG, args, { stdio: [isBuffer ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  proc.on('error', (e) => console.error(`[!] ffmpeg failed to start (${FFMPEG}):`, e.message));
  proc.on('close', (code) => {
    if (code) console.error(`[!] ffmpeg exited with code ${code}:`, stderr.trim().slice(0, 500));
  });
  if (isBuffer) {
    proc.stdin.on('error', () => {}); // ignore EPIPE if playback is stopped early
    proc.stdin.end(input);
  }
  proc.stdout.once('close', () => proc.kill('SIGKILL'));
  const resource = createAudioResource(proc.stdout, { inputType: StreamType.Raw, inlineVolume: true });
  resource.volume.setVolume(volume);
  return resource;
}

function playMusic() {
  const musicPath = settings.getMusicPath();
  if (!musicPath) {
    console.warn('[!] No music set - upload one in the panel or add music/waiting.mp3. Skipping music.');
    return;
  }
  if (quickMusicEnds >= 3) {
    console.error('[!] Music keeps ending instantly - giving up so it does not loop. Check the file and ffmpeg errors above.');
    return;
  }
  let size = 0;
  try { size = fs.statSync(musicPath).size; } catch {}
  if (!size) {
    console.error('[!] Music file is missing or empty:', musicPath, '- re-upload it in the panel.');
    return;
  }
  console.log('Playing music:', musicPath, `(${size} bytes)`);
  currentKind = 'music';
  currentStartedAt = Date.now();
  player.play(makeResource(musicPath, settings.get().musicVolume));
}

async function playWelcome(kind) {
  playingWelcome = true;
  const text = kind === 'additional' ? settings.get().additionalMessage : settings.get().welcomeMessage;
  try {
    const b64 = await googleTTS.getAudioBase64(text, {
      lang: config.TTS_LANG,
      slow: false,
      host: 'https://translate.google.com',
      timeout: 10000,
    });
    if (!player) return; // bot left while we were downloading
    const resource = makeResource(Buffer.from(b64, 'base64'), settings.get().welcomeVolume);
    console.log('Playing welcome message...');
    currentKind = 'welcome';
    currentStartedAt = Date.now();
    player.play(resource);
  } catch (err) {
    console.error('[!] TTS failed:', err.message);
    playingWelcome = false;
    if (player) playMusic();
  }
}

// Decides what to play next: queued welcome first, otherwise looping music
function playNext() {
  if (!player) return;
  if (queue.length > 0) {
    // Playing a new resource stops the music; when the phrase ends, the music restarts from the beginning
    playWelcome(queue.shift());
  } else {
    playingWelcome = false;
    playMusic();
  }
}

// ---------- Connection helpers ----------
async function ensureConnected(guild, channel) {
  if (connecting) return connecting;
  if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) return;
  connecting = doConnect(guild, channel).finally(() => { connecting = null; });
  return connecting;
}

async function doConnect(guild, channel) {
  quickMusicEnds = 0;

  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });

  player.on('stateChange', (o, n) => console.log(`Player: ${o.status} -> ${n.status}`));
  player.on(AudioPlayerStatus.Idle, () => {
    if (currentKind === 'music') {
      quickMusicEnds = Date.now() - currentStartedAt < 1500 ? quickMusicEnds + 1 : 0;
    }
    playNext();
  });
  player.on('error', (err) => {
    console.error('Player error:', err.message);
    if (currentKind === 'music') quickMusicEnds++;
    playNext();
  });

  connection.on('stateChange', (o, n) => console.log(`Voice connection: ${o.status} -> ${n.status}`));
  connection.subscribe(player);

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // Try to reconnect if Discord is just moving/reconnecting us
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      cleanup();
    }
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  console.log('Joined verification VC.');
}

function cleanup() {
  queue = [];
  playingWelcome = false;
  if (player) {
    player.removeAllListeners();
    player.stop(true);
    player = null;
  }
  if (connection) {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    connection = null;
  }
  console.log('Left verification VC.');
}

function humanCount(channel) {
  return channel.members.filter((m) => !m.user.bot).size;
}

async function handleJoin(guild, channel) {
  // First person in an empty VC gets the full welcome; anyone after gets the short message
  const alreadyConnected = connection && connection.state.status !== VoiceConnectionStatus.Destroyed;
  try {
    await ensureConnected(guild, channel);
  } catch (err) {
    console.error('Could not join VC:', err);
    cleanup();
    return;
  }
  queue.push(alreadyConnected ? 'additional' : 'first');
  // If we're not already in the middle of a welcome, interrupt the music and greet
  if (!playingWelcome) playNext();
}

// ---------- Events ----------
client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  // If people are already in the VC when the bot starts, greet them
  try {
    const channel = await c.channels.fetch(config.VERIFICATION_VC_ID);
    if (channel && channel.isVoiceBased()) {
      const humans = channel.members.filter((m) => !m.user.bot);
      for (let i = 0; i < humans.size; i++) await handleJoin(channel.guild, channel);
    }
  } catch (err) {
    console.error('Startup check failed:', err.message);
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  const target = config.VERIFICATION_VC_ID;
  const joinedTarget = newState.channelId === target && oldState.channelId !== target;
  const leftTarget = oldState.channelId === target && newState.channelId !== target;

  if (joinedTarget) {
    await handleJoin(newState.guild, newState.channel);
  } else if (leftTarget) {
    // Person got moved out (or left) - disconnect if nobody is waiting anymore
    const channel = oldState.channel;
    if (channel && humanCount(channel) === 0) cleanup();
  }
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

require('./server'); // web control panel

client.login(process.env.DISCORD_TOKEN);
