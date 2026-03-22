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
const Replicate = require('replicate');
ffmpeg.setFfmpegPath(ffmpegStatic);
const app = express();
const PORT = process.env.PORT || 3000;
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
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
    console.log('Step 1: Uploading to temp storage...');
    const uploadForm = new FormData();
    uploadForm.append('file', fs.createReadStream(videoPath), { filename: req.file.originalname, contentType: req.file.mimetype });
    const tmpRes = await axios.post('https://tmpfiles.org/api/v1/upload', uploadForm, { headers: uploadForm.getHeaders() });
    const videoUrl = tmpRes.data.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
    console.log('Video URL:', videoUrl);
    console.log('Step 2: Removing captions with Replicate...');
    let cleanVideoPath = null;
    try {
      const prediction = await replicate.predictions.create({ version: '247c8385f3c6c322110a6787bd2d257acc3a3d60b9ed7da1726a628f72a42c4d', input: { video: videoUrl, method: 'hybrid', conf_threshold: 0.15, margin: 10 } });
      console.log('Prediction created:', prediction.id);
      let completed = await replicate.predictions.get(prediction.id);
      let polls = 0;
      while (completed.status !== 'succeeded' && completed.status !== 'failed' && polls < 60) {
        await new Promise(r => setTimeout(r, 5000));
        polls++;
        completed = await replicate.predictions.get(prediction.id);
        console.log('Replicate poll ' + polls + ': ' + completed.status);
      }
      if (completed.status === 'succeeded' && completed.output) {
        const output = completed.output;
        let replicateUrl = typeof output === 'string' ? output : (Array.isArray(output) ? String(output[0]) : (output.url || output.video || null));
        if (replicateUrl) {
          console.log('Downloading clean video from:', replicateUrl);
          const dlRes = await axios.get(replicateUrl, { responseType: 'arraybuffer' });
          fs.writeFileSync(cleanPath, dlRes.data);
          cleanVideoPath = cleanPath;
          console.log('Clean video saved (no captions, no audio)');
        }
      }
    } catch (repErr) { console.error('Replicate error (skipping):', repErr.message); }
    console.log('Step 3: Sending ORIGINAL video to ElevenLabs for dubbing...');
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
    const videoSource = cleanVideoPath || videoPath;
    console.log('Step 4: Merging clean video + Spanish audio...');
    await new Promise((resolve, reject) => {
      ffmpeg().input(videoSource).input(audioPath).outputOptions(['-map 0:v', '-map 1:a', '-c:v copy', '-c:a aac', '-shortest']).output(outputPath).on('end', resolve).on('error', reject).run();
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
