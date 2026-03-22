require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const cors = require('cors');
const path = require('path');
const { execSync } = require('child_process');
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

async function detectCaptionRegion(videoPath, timestamp) {
  const framePath = 'uploads/frame_' + timestamp + '.png';
  try {
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .screenshots({ timestamps: ['50%'], filename: path.basename(framePath), folder: 'uploads', size: '640x?' })
        .on('end', resolve)
        .on('error', reject);
    });

    // Use ffprobe to get frame dimensions
    const heightInfo = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "${videoPath}"`).toString().trim();
    const frameHeight = parseInt(heightInfo) || 1080;

    // Extract pixel rows and look for bright horizontal bands
    // Uses ffmpeg to get mean brightness per row slice
    const slices = 20; // divide video into 20 horizontal slices
    const sliceHeight = Math.floor(frameHeight / slices);
    let brightestSlice = 12; // default to lower middle
    let maxBrightness = 0;

    for (let i = 8; i < 18; i++) { // only check middle portion
      const y = i * sliceHeight;
      const h = sliceHeight;
      try {
        const result = execSync(
          `ffmpeg -i "${framePath}" -vf "crop=iw:${h}:0:${y},scale=1:1" -frames:v 1 -f rawvideo -pix_fmt gray - 2>/dev/null | od -An -tu1 | awk '{s+=$1; n++} END {print s/n}'`,
          { timeout: 5000 }
        ).toString().trim();
        const brightness = parseFloat(result);
        if (brightness > maxBrightness) {
          maxBrightness = brightness;
          brightestSlice = i;
        }
      } catch(e) {}
    }

    const padding = 2; // slices of padding
    const ySlice = Math.max(0, brightestSlice - padding);
    const hSlice = padding * 2 + 3;
    const yPos = (ySlice * sliceHeight) / frameHeight;
    const hPos = Math.min(1 - yPos, (hSlice * sliceHeight) / frameHeight);

    console.log(`Detected caption region: y=${yPos.toFixed(2)}, h=${hPos.toFixed(2)}, brightness=${maxBrightness.toFixed(1)}`);
    return { y: yPos, h: hPos };

  } catch (err) {
    console.error('Detection error:', err.message);
    return { y: 0.55, h: 0.2 };
  } finally {
    try { if (fs.existsSync(framePath)) fs.unlinkSync(framePath); } catch(e) {}
  }
}

app.post('/translate', upload.single('video'), async (req, res) => {
  const videoPath = req.file.path;
  const timestamp = Date.now();
  const audioPath = 'uploads/spanish_' + timestamp + '.mp3';
  const outputPath = 'uploads/final_' + timestamp + '.mp4';
  console.log('File received:', req.file.originalname);
  try {
    console.log('Step 1: Detecting caption region...');
    const region = await detectCaptionRegion(videoPath, timestamp);
    console.log('Caption region:', region);

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

    console.log('Step 3: Merging + blurring caption region...');
    const blurFilter = `[0:v]split[original][forblur];[forblur]crop=iw:ih*${region.h.toFixed(3)}:0:ih*${region.y.toFixed(3)},gblur=sigma=25[blurred];[original][blurred]overlay=0:H*${region.y.toFixed(3)}[v]`;
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .input(audioPath)
        .outputOptions([
          '-filter_complex', blurFilter,
          '-map', '[v]',
          '-map', '1:a',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '28',
          '-c:a', 'aac',
          '-shortest',
          '-threads', '2'
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    console.log('Done!');
    [videoPath, audioPath].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
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
