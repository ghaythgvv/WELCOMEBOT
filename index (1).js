require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
} = require('@discordjs/voice');
const { Readable } = require('stream');
const googleTTS = require('google-tts-api');
const config = require('./config');
const settings = require('./settings');

process.env.FFMPEG_PATH = require('ffmpeg-static');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// ---------- State ----------
let connection = null;
let player = null;
let pendingWelcomes = 0; // how many welcome messages are still queued
let playingWelcome = false;

// ---------- Audio helpers ----------
function playMusic() {
  const musicPath = settings.getMusicPath();
  if (!musicPath) {
    console.warn('[!] No music set - upload one in the panel or add music/waiting.mp3. Skipping music.');
    return;
  }
  const resource = createAudioResource(musicPath, { inlineVolume: true });
  resource.volume.setVolume(settings.get().musicVolume);
  console.log('Playing music:', musicPath);
  player.play(resource);
}

async function playWelcome() {
  playingWelcome = true;
  try {
    const b64 = await googleTTS.getAudioBase64(settings.get().welcomeMessage, {
      lang: config.TTS_LANG,
      slow: false,
      host: 'https://translate.google.com',
      timeout: 10000,
    });
    if (!player) return; // bot left while we were downloading
    const resource = createAudioResource(Readable.from(Buffer.from(b64, 'base64')), {
      inlineVolume: true,
    });
    resource.volume.setVolume(settings.get().welcomeVolume);
    console.log('Playing welcome message...');
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
  if (pendingWelcomes > 0) {
    pendingWelcomes--;
    playWelcome();
  } else {
    playingWelcome = false;
    playMusic();
  }
}

// ---------- Connection helpers ----------
async function ensureConnected(guild, channel) {
  if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) return;

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
  player.on(AudioPlayerStatus.Idle, () => playNext());
  player.on('error', (err) => {
    console.error('Player error:', err.message);
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
  pendingWelcomes = 0;
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
  try {
    await ensureConnected(guild, channel);
  } catch (err) {
    console.error('Could not join VC:', err);
    cleanup();
    return;
  }
  pendingWelcomes++;
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
