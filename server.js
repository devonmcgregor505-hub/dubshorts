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
    const cleanOutput = await replicate.run('hjunior29/video-text-remover:247c8385f3c6c322110a6787bd2d257acc3a3d60b9ed7da1726a628f72a42c4d', { input: { video: videoUrl, method: 'hybrid', conf_threshold: 0.25, margin: 5 } });
    const cleanVideoUrl = cleanOutput?.href || (typeof cleanOutput === 'string' ? cleanOutput : videoUrl);
    console.log('Captions removed URL:', cleanVideoUrl);
    console.log('Step 3: Sending to ElevenLabs...');
    const form = new FormData();
    form.append('source_url', cleanVideoUrl);
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
      console.log('Check ' + attempts + ': ' + status);
    }
    if (status !== 'dubbed') throw new Error('Dubbing failed: ' + status);
    const audioRes = await axios.get('https://api.elevenlabs.io/v1/dubbing/' + dubbingId + '/audio/es', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, responseType: 'arraybuffer' });
    fs.writeFileSync(audioPath, audioRes.data);
    await axios.delete('https://api.elevenlabs.io/v1/dubbing/' + dubbingId, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }).catch(() => {});
    await new Promise((resolve, reject) => {
      ffmpeg().input(cleanVideoUrl).input(audioPath).outputOptions(['-map 0:v', '-map 1:a', '-c:v copy', '-c:a aac', '-shortest']).output(outputPath).on('end', resolve).on('error', reject).run();
    });
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    const token = Date.now().toString();
    app.get('/download/' + token, (req, res) => { res.download(outputPath, 'spanish_dubbed.mp4', () => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); }); });
    res.json({ success: true, downloadUrl: '/download/' + token });
  } catch (err) {
    console.error('Error:', err.message);
    if (err.response) console.error('API error:', JSON.stringify(err.response.data));
    [videoPath, audioPath, outputPath].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    res.status(500).json({ success: false, error: err.message });
  }
});
app.listen(PORT, () => { console.log('DubShorts running at http://localhost:' + PORT); });
