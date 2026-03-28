require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ffmpegStatic = require('ffmpeg-static');

let FFMPEG_PATH = ffmpegStatic;
try {
  const r = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  if (r.stdout && r.stdout.trim()) { FFMPEG_PATH = r.stdout.trim(); console.log('Using system ffmpeg:', FFMPEG_PATH); }
  else console.log('Using ffmpeg-static:', FFMPEG_PATH);
} catch(e) { console.log('Using ffmpeg-static:', FFMPEG_PATH); }

function runFFmpeg(args, timeout = 180000) {
  const result = spawnSync(FFMPEG_PATH, args, { timeout, maxBuffer: 100 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('FFmpeg failed: ' + (result.stderr || result.stdout || Buffer.from('')).toString().slice(-400));
}

const app = express();
app.use((req, res, next) => { req.setTimeout(0); res.setTimeout(0); next(); });
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.static(__dirname));
app.use(express.json());
app.use('/outputs', express.static('outputs'));
const upload = multer({ dest: 'uploads/', limits: { fileSize: 200 * 1024 * 1024 } });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('outputs')) fs.mkdirSync('outputs');
if (!fs.existsSync('cache')) fs.mkdirSync('cache');

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/clear-cache', (req, res) => {
  try {
    const files = fs.readdirSync('cache');
    files.forEach(f => fs.unlinkSync(path.join('cache', f)));
    res.send('Cache cleared: ' + files.length + ' files deleted');
  } catch(e) { res.send('Cache clear error: ' + e.message); }
});

const queue = [];
let activeJobs = 0;
const MAX_CONCURRENT = 8;

function enqueue(job) {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (activeJobs >= MAX_CONCURRENT || queue.length === 0) return;
  activeJobs++;
  const { job, resolve, reject } = queue.shift();
  try { resolve(await job()); } catch(e) { reject(e); } finally { activeJobs--; processQueue(); }
}

function getCacheKey(fileBuffer, lang) {
  return crypto.createHash('md5').update(fileBuffer).update(lang).update('elevenlabs').digest('hex');
}
function getCachedResult(key) {
  const p = path.join('cache', key + '.mp4');
  return fs.existsSync(p) ? p : null;
}
function setCachedResult(key, outputPath) {
  try { fs.copyFileSync(outputPath, path.join('cache', key + '.mp4')); } catch(e) {}
}

const ELEVEN_LANG_MAP = { es:'es', hi:'hi', pt:'pt', ja:'ja', fr:'fr', pl:'pl', it:'it', zh:'zh', en:'en' };

async function dubWithElevenLabs(videoPath, targetLang) {
  const lang = ELEVEN_LANG_MAP[targetLang] || targetLang;
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');

  console.log('ElevenLabs: submitting dub job ->', lang);
  const form = new FormData();
  form.append('file', fs.createReadStream(videoPath), { filename: 'input.mp4', contentType: 'video/mp4' });
  form.append('target_lang', lang);
  form.append('source_lang', 'en');
  form.append('num_speakers', '0');
  form.append('watermark', 'true');

  const submitRes = await axios.post('https://api.elevenlabs.io/v1/dubbing', form, {
    headers: { 'xi-api-key': apiKey, ...form.getHeaders() },
    timeout: 120000, maxContentLength: Infinity, maxBodyLength: Infinity,
  });

  const dubbingId = submitRes.data.dubbing_id;
  const expectedDuration = submitRes.data.expected_duration_sec || 300;
  if (!dubbingId) throw new Error('ElevenLabs: no dubbing_id — ' + JSON.stringify(submitRes.data).slice(0, 200));
  console.log('ElevenLabs: job submitted. id=' + dubbingId + ' expected=' + expectedDuration + 's');

  const maxAttempts = Math.ceil((expectedDuration * 3 * 1000) / 5000) + 20;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await axios.get('https://api.elevenlabs.io/v1/dubbing/' + dubbingId, {
      headers: { 'xi-api-key': apiKey }, timeout: 15000,
    });
    const { status, error } = statusRes.data;
    console.log('Poll ' + (i+1) + '/' + maxAttempts + ': ' + status);
    if (status === 'dubbed') break;
    if (status === 'failed') throw new Error('ElevenLabs dubbing failed: ' + (error || 'unknown'));
  }

  console.log('ElevenLabs: downloading result...');
  const downloadRes = await axios.get('https://api.elevenlabs.io/v1/dubbing/' + dubbingId + '/audio/' + lang, {
    headers: { 'xi-api-key': apiKey },
    responseType: 'arraybuffer',
    timeout: 120000,
  });

  return { data: downloadRes.data, dubbingId };
}


app.post('/remove-captions', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  const outputPath = path.resolve('outputs/clean_' + timestamp + '.mp4');
  
  try {
    console.log('Sending to WaveSpeed API...');
    
    const fs = require('fs');
    const axios = require('axios');
    const FormData = require('form-data');
    
    const form = new FormData();
    form.append('input_video', fs.createReadStream(videoPath));
    
    const response = await axios.post('https://api.wavespeed.ai/api/v3/wavespeed-ai/video-watermark-remover', form, {
      headers: {
        ...form.getHeaders(),
        'Authorization': 'Bearer ' + process.env.WAVESPEED_API_KEY
      }
    });
    
    const outputUrl = response.data.output;
    
    if (outputUrl) {
      const videoResponse = await axios.get(outputUrl, { responseType: 'arraybuffer' });
      fs.writeFileSync(outputPath, videoResponse.data);
      try { fs.unlinkSync(videoPath); } catch(e) {}
      res.json({ success: true, videoUrl: '/outputs/clean_' + timestamp + '.mp4' });
    } else {
      throw new Error('No output URL in response');
    }
    
  } catch(err) {
    console.error('WaveSpeed error:', err.message);
    try { fs.unlinkSync(videoPath); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});


app.listen(PORT, () => { console.log('DubShorts running at http://localhost:' + PORT); });

process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') return;
  console.error('Uncaught exception:', err.message);
});
