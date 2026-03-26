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
const { registerFont } = require('canvas');

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

app.post('/dub-speakers', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  const targetLang = req.body.language || 'es';
  const outputPath = path.resolve('outputs/final_dubbed_' + timestamp + '.mp4');

  const fileBuffer = fs.readFileSync(videoPath);
  const cacheKey = getCacheKey(fileBuffer, targetLang);
  const cached = getCachedResult(cacheKey);
  if (cached) {
    console.log('Cache hit!');
    fs.copyFileSync(cached, outputPath);
    try { fs.unlinkSync(videoPath); } catch(e) {}
    return res.json({ success: true, videoUrl: '/outputs/final_dubbed_' + timestamp + '.mp4', cached: true });
  }

  const removeCaption = req.body.removeCaption === 'true';
  const captionBox = req.body.captionBox ? JSON.parse(req.body.captionBox) : null;

  try {
    const result = await enqueue(async () => {
      // Step 0: Remove captions via LaMa inpainting if requested
      let activeVideoPath = videoPath;
      if (removeCaption && captionBox) {
        console.log('Step 0: Removing captions via LaMa...');
        const inpaintDir = path.resolve('outputs/inpaint_' + timestamp);
        fs.mkdirSync(inpaintDir, { recursive: true });
        const inpainted540 = path.resolve(inpaintDir, 'inpainted_540.mp4');
        const inpaintedFinal = path.resolve(inpaintDir, 'inpainted_final.mp4');
        runInpaint(videoPath, inpainted540, captionBox);
        runFFmpeg([
          '-y', '-i', inpainted540, '-i', videoPath,
          '-map', '0:v:0', '-map', '1:a:0',
          '-vf', 'scale=1080:-2',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
          '-c:a', 'aac', '-shortest', inpaintedFinal,
        ], 300000);
        activeVideoPath = inpaintedFinal;
      }

      if (targetLang === 'none') {
        runFFmpeg(['-y', '-i', activeVideoPath, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'aac', outputPath], 180000);
      } else {
        const { data: videoData } = await dubWithElevenLabs(activeVideoPath, targetLang);
        const rawDubPath = path.resolve('uploads/raw_dub_' + timestamp + '.bin');
        fs.writeFileSync(rawDubPath, videoData);

        const probe = spawnSync(FFMPEG_PATH, ['-i', rawDubPath], { encoding: 'utf8' });
        const hasVideo = (probe.stderr || '').includes('Video:');

        // always use original video to avoid 11labs watermark
        if (false) {
          runFFmpeg(['-y', '-i', rawDubPath, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'aac', outputPath], 180000);
        } else {
          // Audio only — overlay on original video (also removes any watermark)
          runFFmpeg([
            '-y', '-i', videoPath, '-i', rawDubPath,
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
            '-c:a', 'aac', '-ac', '2', '-shortest',
            outputPath,
          ], 180000);
        }
        try { fs.unlinkSync(rawDubPath); } catch(e) {}
      }

      console.log('Done! Output:', fs.statSync(outputPath).size, 'bytes');
      setCachedResult(cacheKey, outputPath);
      try { fs.unlinkSync(videoPath); } catch(e) {}
      setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e) {} }, 600000);
      return { success: true, videoUrl: '/outputs/final_dubbed_' + timestamp + '.mp4' };
    });

    res.json(result);
  } catch(err) {
    console.error('dub-speakers error:', err.message);
    if (err.response) console.error('API response:', JSON.stringify(err.response.data).slice(0, 300));
    try { fs.unlinkSync(videoPath); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/translate', upload.single('video'), async (req, res) => {
  req.url = '/dub-speakers';
  app._router.handle(req, res, () => {});
});

app.post('/split-speakers', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  const workDir = path.resolve('outputs/split_' + timestamp);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    if (!process.env.ASSEMBLYAI_API_KEY) throw new Error('ASSEMBLYAI_API_KEY not set');
    const audioPath = path.resolve(workDir, 'full_audio.mp3');
    runFFmpeg(['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'mp3', audioPath], 60000);
    const audioBuffer = fs.readFileSync(audioPath);
    const uploadRes = await axios.post('https://api.assemblyai.com/v2/upload', audioBuffer, {
      headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY, 'content-type': 'application/octet-stream' }, timeout: 60000
    });
    const jobRes = await axios.post('https://api.assemblyai.com/v2/transcript', {
      audio_url: uploadRes.data.upload_url, speaker_labels: true
    }, { headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }, timeout: 30000 });
    let utterances = [];
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const poll = await axios.get('https://api.assemblyai.com/v2/transcript/' + jobRes.data.id, {
        headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }, timeout: 15000
      });
      if (poll.data.status === 'completed') { utterances = poll.data.utterances || []; break; }
      if (poll.data.status === 'error') throw new Error('AssemblyAI: ' + poll.data.error);
    }
    if (utterances.length === 0) throw new Error('No utterances detected');
    const speakers = [...new Set(utterances.map(u => u.speaker))];
    const clips = [];
    for (let i = 0; i < utterances.length; i++) {
      const u = utterances[i];
      const start = u.start / 1000;
      const dur = (u.end - u.start) / 1000;
      if (dur < 0.3) continue;
      const clipName = 'speaker_' + u.speaker + '_seg' + String(i).padStart(3,'0') + '_' + start.toFixed(1) + 's.mp3';
      const clipPath = path.resolve(workDir, clipName);
      try {
        runFFmpeg(['-y', '-ss', String(start), '-i', audioPath, '-t', String(dur), '-c:a', 'mp3', clipPath], 30000);
        if (fs.existsSync(clipPath) && fs.statSync(clipPath).size > 500) {
          clips.push({ name: clipName, speaker: u.speaker, start: start.toFixed(2), dur: dur.toFixed(2), text: u.text, url: '/outputs/split_' + timestamp + '/' + clipName });
        }
      } catch(e) { console.log('Seg', i, 'failed:', e.message); }
    }
    try { fs.unlinkSync(videoPath); } catch(e) {}
    setTimeout(() => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e) {} }, 600000);
    res.json({ success: true, speakers, segments: clips });
  } catch(err) {
    console.error('split-speakers error:', err.message);
    try { fs.unlinkSync(videoPath); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/queue', (req, res) => {
  res.json({ active: activeJobs, waiting: queue.length, max: MAX_CONCURRENT });
});

app.listen(PORT, () => { console.log('DubShorts running at http://localhost:' + PORT);
});

process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') return;
  console.error('Uncaught exception:', err.message);
});

// ── Caption removal via LaMa ──────────────────────────────────────────────────
function runInpaint(videoIn, videoOut, box) {
  const python = path.join(__dirname, 'venv/bin/python');
  const script = path.join(__dirname, 'inpaint_captions.py');
  const result = spawnSync(python, [script, videoIn, videoOut, JSON.stringify(box)], {
    timeout: 600000,
    maxBuffer: 100 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = (result.stdout || '').toString();
  const err = (result.stderr || '').toString();
  if (out) console.log('[inpaint]', out.trim());
  if (result.status !== 0) throw new Error('Inpaint failed: ' + err.slice(-400));
}

app.post('/remove-captions', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  const box = JSON.parse(req.body.captionBox || '{}');
  if (!box.x && box.x !== 0) return res.status(400).json({ success: false, error: 'No captionBox provided' });

  const workDir = path.resolve('outputs/inpaint_' + timestamp);
  fs.mkdirSync(workDir, { recursive: true });

  const inpainted540 = path.resolve(workDir, 'inpainted_540.mp4');
  const outputPath   = path.resolve('outputs/clean_' + timestamp + '.mp4');

  try {
    await enqueue(async () => {
      console.log('Step 1: Inpainting captions at 540p...');
      runInpaint(videoPath, inpainted540, box);

      console.log('Step 2: Upscaling to 1080p + merging original audio...');
      runFFmpeg([
        '-y',
        '-i', inpainted540,   // inpainted video (no audio)
        '-i', videoPath,       // original (for audio)
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-vf', 'scale=1080:-2',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-c:a', 'aac', '-ac', '2',
        '-shortest',
        outputPath,
      ], 300000);

      try { fs.unlinkSync(videoPath); } catch(e) {}
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e) {}
      setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e) {} }, 600000);
    });

    res.json({ success: true, videoUrl: '/outputs/clean_' + timestamp + '.mp4' });
  } catch(err) {
    console.error('remove-captions error:', err.message);
    try { fs.unlinkSync(videoPath); } catch(e) {}
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});
