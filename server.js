require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const cors = require('cors');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegStatic);
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.post('/translate', upload.single('video'), async (req, res) => {
  const videoPath = req.file.path;
  const timestamp = Date.now();
  const cleanPath = 'uploads/clean_' + timestamp + '.mp4';
  const audioPath = 'uploads/spanish_' + timestamp + '.mp3';
  const outputPath = 'uploads/final_' + timestamp + '.mp4';
  console.log('File received:', req.file.originalname);
  try {
    console.log('Step 1: Blurring caption area with FFmpeg...');
    await new Promise((resolve, reject) => {
      ffmpeg().input(videoPath)
        .videoFilters('boxblur=20:1:cr=0:ar=0,crop=iw:ih*0.25:0:ih*0.65,boxblur=20:1')
        .outputOptions(['-filter_complex', '[0:v]crop=iw:ih*0.3:0:ih*0.65,boxblur=30:5[blurred];[0:v][blurred]overlay=0:H*0.65[v]', '-map', '[v]', '-map', '0:a', '-c:a', 'copy'])
        .output(cleanPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    console.log('Caption area blurred!');
    console.log('Step 2: Sending to ElevenLabs...');
    const form = new FormData();
    form.append('file', fs.createReadStream(videoPath), { filename: req.file.originalname, contentType: 'video/mp4' });
    form.append('source_lang', 'en');
    form.append('target_lang', 'es');
    form.append('num_speakers', '0');
    form.append('watermark', 'false');
    const startRes = await axios.post('https://api.elevenlabs.io/v1/dubbing', form, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, ...form.getHeaders() }, timeout: 600000 });
    const dubbingId = startRes.data.dubbing_id;
    console.log('Dubbing started:', dubbingId);
    let status = 'dubbing';
    let attempts = 0;
    while (status === 'dubbing' && attempts < 30) {
      await new Promise(r => setTimeout(r, 10000));
      attempts++;
      const checkRes = await axios.get('https://api.elevenlabs.io/v1/dubbing/' + dubbingId, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
      status = checkRes.data.status;
      console.log('ElevenLabs check ' + attempts + ': ' + status);
    }
    if (status !== 'dubbed') throw new Error('Dubbing failed: ' + status);
    console.log('Dubbing complete!');
    const audioRes = await axios.get('https://api.elevenlabs.io/v1/dubbing/' + dubbingId + '/audio/es', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, responseType: 'arraybuffer' });
    fs.writeFileSync(audioPath, audioRes.data);
    await axios.delete('https://api.elevenlabs.io/v1/dubbing/' + dubbingId, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }).catch(() => {});
    console.log('Step 3: Merging blurred video + Spanish audio...');
    await new Promise((resolve, reject) => {
      ffmpeg().input(cleanPath).input(audioPath).outputOptions(['-map 0:v', '-map 1:a', '-c:v copy', '-c:a aac', '-shortest']).output(outputPath).on('end', resolve).on('error', reject).run();
    });
    console.log('Done!');
    [videoPath, cleanPath, audioPath].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    const token = Date.now().toString();
    app.get('/download/' + token, (req, res) => { res.download(outputPath, 'spanish_dubbed.mp4', () => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); }); });
    res.json({ success: true, downloadUrl: '/download/' + token });
  } catch (err) {
    console.error('Error:', err.message);
    if (err.response) console.error('API error:', JSON.stringify(err.response.data));
    [videoPath, cleanPath, audioPath, outputPath].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    res.status(500).json({ success: false, error: err.message });
  }
});
app.listen(PORT, () => { console.log('DubShorts running at http://localhost:' + PORT); });
