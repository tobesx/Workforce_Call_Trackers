const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');

const AUDIO_DIR = path.join(__dirname, '../audio');
const CLEANUP_DELAY = 5 * 60 * 1000;

async function synthesize(text) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.1 },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`ElevenLabs ${response.status}: ${await response.text()}`);
  }

  const buffer = await response.arrayBuffer();
  const filename = `${uuid()}.mp3`;
  const filepath = path.join(AUDIO_DIR, filename);
  fs.writeFileSync(filepath, Buffer.from(buffer));

  setTimeout(() => {
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  }, CLEANUP_DELAY);

  return filename;
}

module.exports = { synthesize };
