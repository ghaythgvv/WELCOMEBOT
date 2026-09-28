# Verification VC Bot

When someone joins the verification voice channel, the bot joins, says a welcome
message (TTS) and then loops waiting music. If another person joins, it repeats the
welcome message and goes back to the music. When everyone has been moved out or left,
the bot disconnects.

## Setup

1. Install [Node.js 18+](https://nodejs.org).
2. Put your waiting music at `music/waiting.mp3` (any mp3 you have rights to use).
3. Copy `.env.example` to `.env` and paste your bot token.
4. Install and run:
   ```
   npm install
   npm start
   ```

## Discord Developer Portal

- Create the bot at https://discord.com/developers/applications
- No privileged intents are needed.
- Invite it with the `bot` scope and these permissions: **View Channel, Connect, Speak**.

## Customising

Edit `config.js` to change the welcome message, voice accent, music file, or volumes.
The verification channel ID is already set to `1513904254535073883`.

## Notes

- The TTS uses Google Translate's speech endpoint, so the host needs internet access.
- The welcome message must stay under 200 characters.
