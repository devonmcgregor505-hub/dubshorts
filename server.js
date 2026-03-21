require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const cors = require('cors');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 200 * 1024 * 1024 }
});

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/translate', upload.single('video'), async (req, res) => {
  const videoPath = req.file.path;
  const timestamp = Date.now();
  const audioPath = `uploads/spanish_audio_${timestamp}.mp3`;
  const outputPath = `uploads/final_${timestamp}.mp4`;

  console.log('File received:', req.file.originalname);

  try {
    console.log('Step 1: Sending to ElevenLabs...');
    const form = new FormData();
    form.append('file', fs.createReadStream(videoPath), {
      filename: req.file.originalname,
      contentType: req.file.mimetype
    });
    form.append('source_lang', 'en');
    form.append('target_lang', 'es');
    form.append('num_speakers', '0');
    form.append('watermark', 'false');

    const startRes = await axios.post(
      'https://api.elevenlabs.io/v1/dubbing',
      form,
      {
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          ...form.getHeaders()
        },
        timeout: 600000
      }
    );

    const dubbingId = startRes.data.dubbing_id;
    console.log('Dubbing started, ID:', dubbingId);

    console.log('Step 2: Waiting for ElevenLabs...');
    let status = 'dubbing';
    let attempts = 0;
    while (status === 'dubbing' && attempts < 30) {
      await new Promise(r => setTimeout(r, 10000));
      attempts++;
      const checkRes = await axios.get(
        `https://api.elevenlabs.io/v1/dubbing/${dubbingId}`,
        { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
      );
      status = checkRes.data.status;
      console.log('Check ' + attempts + ': ' + status);
    }

    if (status !== 'dubbed') throw new Error('Dubbing failed: ' + status);
    console.log('Dubbing complete!');

    console.log('Step 3: Downloading Spanish audio...');
    const audioRes = await axios.get(
      `https://api.elevenlabs.io/v1/dubbing/${dubbingId}/audio/es`,
      {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
        responseType: 'arraybuffer'
      }
    );
    fs.writeFileSync(audioPath, audioRes.data);
    console.log('Audio saved!');

    await axios.delete(
      `https://api.elevenlabs.io/v1/dubbing/${dubbingId}`,
      { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
    ).catch(() => {});

    console.log('Step 4: Merging with FFmpeg...');
    execSync(
      `ffmpeg -i "${videoPath}" -i "${audioPath}" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "${outputPath}"`,
      { stdio: 'inherit' }
    );
    console.log('Merge complete!');

    const token = Date.now().toString();
    app.get('/download/' + token, (req, res) => {
      res.download(outputPath, 'spanish_dubbed.mp4', () => {
        [videoPath, audioPath, outputPath].forEach(f => {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        });
        console.log('Files cleaned up');
      });
    });

    res.json({ success: true, downloadUrl: '/download/' + token });

  } catch (err) {
    console.error('Error:', err.message);
    if (err.response) console.error('ElevenLabs:', JSON.stringify(err.response.data));
    [videoPath, audioPath, outputPath].forEach(f => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('DubShorts running at http://localhost:' + PORT);
});
