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
  const audioPath = 'uploads/spanish_' + timestamp + '.mp3';
  const srtPath = 'uploads/spanish_' + timestamp + '.srt';
  const outputPath = 'uploads/final_' + timestamp + '.mp4';
  console.log('File received:', req.file.originalname);
  let captionBox = null;
  if (req.body.captionBox) {
    try { captionBox = JSON.parse(req.body.captionBox); console.log('Caption box:', captionBox); } catch(e) {}
  }
  try {
    console.log('Step 1: Sending to ElevenLabs...');
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

    // Get Spanish audio
    const audioRes = await axios.get('https://api.elevenlabs.io/v1/dubbing/' + dubbingId + '/audio/es', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, responseType: 'arraybuffer' });
    fs.writeFileSync(audioPath, audioRes.data);

    // Get Spanish SRT transcript
    console.log('Fetching Spanish subtitles...');
    let hasSrt = false;
    try {
      const srtRes = await axios.get('https://api.elevenlabs.io/v1/dubbing/' + dubbingId + '/transcript/es?format_type=srt', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
      if (srtRes.data && srtRes.data.length > 10) {
        fs.writeFileSync(srtPath, srtRes.data);
        hasSrt = true;
        console.log('Spanish SRT saved!');
      }
    } catch(e) { console.log('SRT fetch failed, continuing without subtitles:', e.message); }

    await axios.delete('https://api.elevenlabs.io/v1/dubbing/' + dubbingId, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }).catch(() => {});

    console.log('Step 2: Merging video + audio + subtitles...');
    await new Promise((resolve, reject) => {
      let cmd = ffmpeg(videoPath).input(audioPath);
      if (hasSrt) cmd = cmd.input(srtPath);

      let filters = [];
      let mapV = '0:v';

      if (captionBox) {
        const { x, y, w, h } = captionBox;
        filters.push(`[0:v]split[original][forblur];[forblur]crop=iw*${w.toFixed(4)}:ih*${h.toFixed(4)}:iw*${x.toFixed(4)}:ih*${y.toFixed(4)},gblur=sigma=25[blurred];[original][blurred]overlay=W*${x.toFixed(4)}:H*${y.toFixed(4)}[blurred_out]`);
        mapV = '[blurred_out]';
      }

      if (hasSrt) {
        const srtInput = captionBox ? '[blurred_out]' : '[0:v]';
        const srtInputRef = captionBox ? '' : '[0:v]';
        filters.push(`${captionBox ? '[blurred_out]' : '[0:v]'}subtitles=${srtPath}:force_style='FontName=Arial,FontSize=14,PrimaryColour=&Hffffff&,OutlineColour=&H000000&,Outline=2,Bold=1,Alignment=2'[final_v]`);
        mapV = '[final_v]';
      }

      const outputOpts = [];
      if (filters.length > 0) {
        outputOpts.push('-filter_complex', filters.join(';'));
        outputOpts.push('-map', mapV);
      } else {
        outputOpts.push('-map', '0:v');
      }
      outputOpts.push('-map', '1:a');
      outputOpts.push('-c:v', 'libx264');
      outputOpts.push('-preset', 'ultrafast');
      outputOpts.push('-crf', '28');
      outputOpts.push('-c:a', 'aac');
      outputOpts.push('-shortest');
      outputOpts.push('-threads', '2');

      cmd.outputOptions(outputOpts).output(outputPath).on('end', resolve).on('error', reject).run();
    });

    console.log('Done!');
    [videoPath, audioPath, srtPath].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });
    const token = Date.now().toString();
    app.get('/download/' + token, (req, res) => { res.download(outputPath, 'spanish_dubbed.mp4', () => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); }); });
    res.json({ success: true, downloadUrl: '/download/' + token });
  } catch (err) {
    console.error('Error:', err.message);
    if (err.response) console.error('API error:', JSON.stringify(err.response.data));
    [videoPath, audioPath, srtPath, outputPath].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });
    res.status(500).json({ success: false, error: err.message });
  }
});
app.listen(PORT, () => { console.log('DubShorts running at http://localhost:' + PORT); });
