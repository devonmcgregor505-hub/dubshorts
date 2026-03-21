require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static('.'));
const upload = multer({ dest: 'uploads/', limits: { fileSize: 200 * 1024 * 1024 } });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
app.post('/translate', upload.single('video'), async (req, res) => {
  const videoPath = req.file.path;
  console.log('File received:', req.file.originalname);
  try {
    console.log('Step 1: Sending to ElevenLabs...');
    const form = new FormData();
    form.append('file', fs.createReadStream(videoPath), { filename: req.file.originalname, contentType: req.file.mimetype });
    form.append('source_lang', 'en');
    form.append('target_lang', 'es');
    form.append('num_speakers', '0');
    form.append('watermark', 'false');
    const startRes = await axios.post('https://api.elevenlabs.io/v1/dubbing', form, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, ...form.getHeaders() }, timeout: 600000 });
    const dubbingId = startRes.data.dubbing_id;
    console.log('Dubbing started, ID:', dubbingId);
    let status = 'dubbing';
    let attempts = 0;
    while (status === 'dubbing' && attempts < 30) {
      await new Promise(r => setTimeout(r, 10000));
      attempts++;
      const checkRes = await axios.get(`https://api.elevenlabs.io/v1/dubbing/${dubbingId}`, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
      status = checkRes.data.status;
      console.log('Check ' + attempts + ': ' + status);
    }
    if (status !== 'dubbed') throw new Error('Dubbing failed with status: ' + status);
    console.log('Dubbing complete!');
    const videoRes = await axios.get(`https://api.elevenlabs.io/v1/dubbing/${dubbingId}/audio/es`, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, responseType: 'arraybuffer' });
    const outputPath = 'uploads/dubbed_' + Date.now() + '.mp4';
    fs.writeFileSync(outputPath, videoRes.data);
    console.log('Video saved!');
    await axios.delete(`https://api.elevenlabs.io/v1/dubbing/${dubbingId}`, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }).catch(() => {});
    const token = Date.now().toString();
    app.get('/download/' + token, (req, res) => {
      res.download(outputPath, 'spanish_dubbed.mp4', () => {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      });
    });
    res.json({ success: true, downloadUrl: '/download/' + token });
  } catch (err) {
    console.error('Error:', err.message);
    if (err.response) console.error('ElevenLabs said:', JSON.stringify(err.response.data));
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    res.status(500).json({ success: false, error: err.message });
  }
});
app.listen(PORT, () => { console.log('DubShorts running at http://localhost:' + PORT); });
