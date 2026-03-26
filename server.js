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
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// Import the dubbing pipeline (will add later)
// const runDubbingPipeline = require('./dubbing_pipeline.js');

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function uploadToR2(filePath, key) {
  const fileBuffer = fs.readFileSync(filePath);
  await r2.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: fileBuffer,
    ContentType: 'video/mp4',
  }));
  const url = `https://pub-c068534d6a23426592ffab06501be7a4.r2.dev/${key}`;
  console.log('Uploaded to R2:', key);
  return url;
}

const ffmpegStatic = require('ffmpeg-static');
const { createCanvas, loadImage, registerFont } = require('canvas');

const fontPath = path.join(__dirname, 'DejaVuSans-Bold.ttf');
if (fs.existsSync(fontPath)) {
  registerFont(fontPath, { family: 'CaptionFont', weight: 'bold' });
  console.log('Font registered:', fontPath);
}

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
const PORT = process.env.PORT || 3000;
app.use(cors());
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

// Queue system
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

// Cache functions
function getCacheKey(fileBuffer, lang, provider) {
  return crypto.createHash('md5').update(fileBuffer).update(lang).update(provider).digest('hex');
}
function getCachedResult(key) {
  const p = path.join('cache', key + '.mp4');
  return fs.existsSync(p) ? p : null;
}
function setCachedResult(key, outputPath) {
  try { fs.copyFileSync(outputPath, path.join('cache', key + '.mp4')); } catch(e) {}
}

// ModelsLab dubbing function
async function dubWithModelsLab(videoUrl, targetLang) {
  const langMap = {
    es: 'es', hi: 'hi', pt: 'pt-br', ja: 'ja', fr: 'fr', pl: 'pl',
    it: 'it', zh: 'zh', 'en-us': 'en-us', 'en-gb': 'en-gb', en: 'en-us'
  };
  const lang = langMap[targetLang] || targetLang;

  const dubRes = await axios.post('https://modelslab.com/api/v6/voice/create_dubbing', {
    key: process.env.MODELSLAB_API_KEY,
    init_video: videoUrl,
    source_lang: 'en',
    output_lang: lang,
    speed: 1.0,
    num_speakers: 0,
    file_prefix: 'dub_' + lang + '_' + Date.now() + '_' + Math.random().toString(36).slice(2),
    base64: false, webhook: null, track_id: null
  }, { headers: { 'Content-Type': 'application/json' }, timeout: 120000 });

  console.log('ModelsLab response:', JSON.stringify(dubRes.data).slice(0, 300));

  if (dubRes.data.status === 'success' && dubRes.data.output?.[0]) {
    const dlRes = await axios.get(dubRes.data.output[0], { responseType: 'arraybuffer', timeout: 120000 });
    return dlRes.data;
  }

  if (dubRes.data.status === 'processing' && dubRes.data.fetch_result) {
    for (let attempts = 0; attempts < 180; attempts++) {
      await new Promise(r => setTimeout(r, 5000));
      const poll = await axios.post(dubRes.data.fetch_result, { key: process.env.MODELSLAB_API_KEY }, {
        headers: { 'Content-Type': 'application/json' }, timeout: 30000
      });
      console.log(`Poll ${attempts + 1}: ${poll.data.status}`);
      if (poll.data.status === 'success' && poll.data.output?.[0]) {
        const dlRes = await axios.get(poll.data.output[0], { responseType: 'arraybuffer', timeout: 120000 });
        return dlRes.data;
      }
      if (poll.data.status === 'failed') {
        throw new Error('ModelsLab dubbing failed: ' + JSON.stringify(poll.data).slice(0, 200));
      }
    }
  }
  throw new Error('ModelsLab dubbing failed or timed out: ' + JSON.stringify(dubRes.data).slice(0, 200));
}

app.post('/translate', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  const dubbedVideoPath = path.resolve('uploads/dubbed_video_' + timestamp + '.mp4');
  const outputPath = path.resolve('outputs/final_' + timestamp + '.mp4');
  const allFiles = [videoPath, dubbedVideoPath];

  const targetLang = req.body.language || 'es';

  const fileBuffer = fs.readFileSync(videoPath);
  const cacheKey = getCacheKey(fileBuffer, targetLang, 'modelslab');
  const cached = getCachedResult(cacheKey);
  
  if (cached) {
    console.log('Cache hit!');
    const cachedOut = path.resolve('outputs/final_' + timestamp + '.mp4');
    fs.copyFileSync(cached, cachedOut);
    return res.json({ success: true, videoUrl: '/outputs/final_' + timestamp + '.mp4', cached: true });
  }

  try {
    const result = await enqueue(async () => {
      if (targetLang !== 'none') {
        const r2Key = 'dub_input_' + timestamp + '.mp4';
        const videoUrl = await uploadToR2(videoPath, r2Key);
        const videoData = await dubWithModelsLab(videoUrl, targetLang);
        fs.writeFileSync(dubbedVideoPath, videoData);
      } else {
        fs.copyFileSync(videoPath, dubbedVideoPath);
      }

      runFFmpeg(['-y', '-i', dubbedVideoPath, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'aac', outputPath], 180000);

      setCachedResult(cacheKey, outputPath);
      allFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });
      return { success: true, videoUrl: '/outputs/final_' + timestamp + '.mp4' };
    });

    res.json(result);
  } catch(err) {
    console.error('Error:', err.message);
    allFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/queue', (req, res) => {
  res.json({ active: activeJobs, waiting: queue.length, max: MAX_CONCURRENT });
});

app.listen(PORT, () => { console.log('DubShorts running at http://localhost:' + PORT); });

process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') return;
  console.error('Uncaught exception:', err.message);
});
