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


// ── SPEAKER SPLIT TEST ────────────────────────────────────────────────────────
// Extracts audio, detects speakers, splits into individual audio files, returns them all
app.post('/split-speakers', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  const workDir = path.resolve('outputs/split_'+timestamp);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    if (!process.env.ASSEMBLYAI_API_KEY) throw new Error('ASSEMBLYAI_API_KEY not set');

    // Step 1: Extract audio
    console.log('Step 1: Extracting audio...');
    const audioPath = path.resolve(workDir, 'full_audio.mp3');
    runFFmpeg(['-y','-i',videoPath,'-vn','-ac','1','-ar','16000','-c:a','mp3',audioPath], 60000);
    console.log('Audio extracted:', fs.statSync(audioPath).size, 'bytes');

    // Step 2: Upload to AssemblyAI + diarize
    console.log('Step 2: Detecting speakers with AssemblyAI...');
    const audioBuffer = fs.readFileSync(audioPath);
    const uploadRes = await axios.post('https://api.assemblyai.com/v2/upload', audioBuffer, {
      headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY, 'content-type': 'application/octet-stream' },
      timeout: 60000
    });
    const jobRes = await axios.post('https://api.assemblyai.com/v2/transcript', {
      audio_url: uploadRes.data.upload_url,
      speaker_labels: true,
      speech_model: 'universal-2'
    }, { headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }, timeout: 30000 });

    console.log('Diarization job:', jobRes.data.id);
    let utterances = [];
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const poll = await axios.get('https://api.assemblyai.com/v2/transcript/'+jobRes.data.id, {
        headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }, timeout: 15000
      });
      console.log('Poll', i+1, ':', poll.data.status);
      if (poll.data.status === 'completed') { utterances = poll.data.utterances || []; break; }
      if (poll.data.status === 'error') throw new Error('AssemblyAI: ' + poll.data.error);
    }
    if (utterances.length === 0) throw new Error('No utterances detected');

    const speakers = [...new Set(utterances.map(u => u.speaker))];
    console.log('Speakers found:', speakers.join(', '), '| Segments:', utterances.length);

    // Step 3: Cut audio per utterance
    console.log('Step 3: Cutting audio segments...');
    const clips = [];
    for (let i = 0; i < utterances.length; i++) {
      const u = utterances[i];
      const start = u.start / 1000;
      const dur = (u.end - u.start) / 1000;
      if (dur < 0.3) continue;
      const clipName = `speaker_${u.speaker}_seg${String(i).padStart(3,'0')}_${start.toFixed(1)}s.mp3`;
      const clipPath = path.resolve(workDir, clipName);
      try {
        runFFmpeg(['-y','-ss',String(start),'-i',audioPath,'-t',String(dur),'-c:a','mp3',clipPath], 30000);
        if (fs.existsSync(clipPath) && fs.statSync(clipPath).size > 500) {
          clips.push({ name: clipName, speaker: u.speaker, start: start.toFixed(2), dur: dur.toFixed(2), text: u.text, url: '/outputs/split_'+timestamp+'/'+clipName });
          console.log(`  Seg ${i}: Speaker ${u.speaker} [${start.toFixed(1)}s, ${dur.toFixed(1)}s] "${u.text.slice(0,40)}"`);
        }
      } catch(e) { console.log(`  Seg ${i} failed:`, e.message); }
    }

    console.log('Done! Cut', clips.length, 'audio segments');
    try { fs.unlinkSync(videoPath); } catch(e) {}

    // Auto-delete after 10 mins
    setTimeout(() => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e) {} }, 600000);

    res.json({ success: true, speakers, segments: clips });
  } catch(err) {
    console.error('split-speakers error:', err.message);
    if (err.response) console.error('API error:', JSON.stringify(err.response.data).slice(0,300));
    try { fs.unlinkSync(videoPath); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DUB SPEAKERS ─────────────────────────────────────────────────────────────
// Full pipeline: extract audio → diarize → split → dub each → stitch → put over video
app.post('/dub-speakers', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  const targetLang = req.body.language || 'es';
  const workDir = path.resolve('outputs/dub_'+timestamp);
  const outputPath = path.resolve('outputs/final_dubbed_'+timestamp+'.mp4');
  const zipPath = path.resolve('outputs/dubbed_clips_'+timestamp+'.zip');
  fs.mkdirSync(workDir, { recursive: true });

  try {
    if (!process.env.ASSEMBLYAI_API_KEY) throw new Error('ASSEMBLYAI_API_KEY not set');
    if (!process.env.MODELSLAB_API_KEY) throw new Error('MODELSLAB_API_KEY not set');

    // Step 1: Extract audio
    console.log('Step 1: Extracting audio...');
    const audioPath = path.resolve(workDir, 'full_audio.mp3');
    runFFmpeg(['-y','-i',videoPath,'-vn','-ac','1','-ar','16000','-c:a','mp3',audioPath], 60000);

    // Step 2: AssemblyAI diarization
    console.log('Step 2: Diarizing...');
    const audioBuffer = fs.readFileSync(audioPath);
    const uploadRes = await axios.post('https://api.assemblyai.com/v2/upload', audioBuffer, {
      headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY, 'content-type': 'application/octet-stream' },
      timeout: 60000
    });
    const jobRes = await axios.post('https://api.assemblyai.com/v2/transcript', {
      audio_url: uploadRes.data.upload_url,
      speaker_labels: true,
      speech_model: 'universal-2'
    }, { headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }, timeout: 30000 });

    let utterances = [];
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const poll = await axios.get('https://api.assemblyai.com/v2/transcript/'+jobRes.data.id, {
        headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }, timeout: 15000
      });
      console.log('Poll', i+1, ':', poll.data.status);
      if (poll.data.status === 'completed') { utterances = poll.data.utterances || []; break; }
      if (poll.data.status === 'error') throw new Error('AssemblyAI: ' + poll.data.error);
    }
    if (utterances.length === 0) throw new Error('No utterances detected');

    const speakers = [...new Set(utterances.map(u => u.speaker))];
    console.log('Speakers:', speakers.join(', '), '| Segments:', utterances.length);

    if (speakers.length < 2) {
      console.log('Only 1 speaker - falling back to full video dub');
      const r2Key = 'dub_input_'+timestamp+'.mp4';
      const videoUrl = await uploadToR2(videoPath, r2Key);
      const videoData = await dubWithModelsLab(videoUrl, targetLang);
      fs.writeFileSync(outputPath, videoData);
      try { fs.unlinkSync(videoPath); } catch(e) {}
      setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e) {} }, 600000);
      return res.json({ success: true, videoUrl: '/outputs/final_dubbed_'+timestamp+'.mp4', singleSpeaker: true });
    }

    // Step 3: Cut audio segments
    console.log('Step 3: Cutting', utterances.length, 'audio segments...');
    const segList = [];
    for (let i = 0; i < utterances.length; i++) {
      const u = utterances[i];
      const start = u.start / 1000;
      const dur = (u.end - u.start) / 1000;
      if (dur < 0.3) continue;
      const segName = 'seg_'+String(i).padStart(3,'0')+'_spk_'+u.speaker+'.mp3';
      const segPath = path.resolve(workDir, segName);
      try {
        runFFmpeg(['-y','-ss',String(start),'-i',audioPath,'-t',String(dur),'-c:a','mp3',segPath], 30000);
        if (fs.existsSync(segPath) && fs.statSync(segPath).size > 500) {
          segList.push({ path: segPath, name: segName, speaker: u.speaker, start, dur, text: u.text });
        }
      } catch(e) { console.log('Seg', i, 'cut failed:', e.message); }
    }
    console.log('Cut', segList.length, 'segments');

    // Step 4: Dub each segment via ModelsLab
    console.log('Step 4: Dubbing segments...');
    const dubbedSegs = [];
    for (let i = 0; i < segList.length; i++) {
      const seg = segList[i];
      console.log(`Dubbing seg ${i+1}/${segList.length}: Speaker ${seg.speaker}`);
      try {
        // Wrap audio in video for ModelsLab
        const wrapPath = path.resolve(workDir, 'wrap_'+i+'.mp4');
        runFFmpeg(['-y','-f','lavfi','-i','color=c=black:s=256x256:r=10',
          '-i',seg.path,'-c:v','libx264','-preset','ultrafast',
          '-c:a','aac','-shortest',wrapPath], 30000);

        const r2Key = 'seg_'+timestamp+'_'+i+'.mp4';
        const segUrl = await uploadToR2(wrapPath, r2Key);
        try { fs.unlinkSync(wrapPath); } catch(e) {}

        const videoData = await dubWithModelsLab(segUrl, targetLang);
        const dubbedPath = path.resolve(workDir, 'dubbed_'+seg.name.replace('.mp3','.mp4'));
        fs.writeFileSync(dubbedPath, videoData);

        // Extract audio from dubbed video
        const dubbedAudioPath = path.resolve(workDir, 'dubbed_'+seg.name);
        runFFmpeg(['-y','-i',dubbedPath,'-vn','-c:a','mp3',dubbedAudioPath], 30000);
        try { fs.unlinkSync(dubbedPath); } catch(e) {}

        console.log(`  Seg ${i+1} dubbed OK`);
        dubbedSegs.push({ ...seg, dubbedPath: dubbedAudioPath, dubbedName: 'dubbed_'+seg.name });
      } catch(e) {
        console.log(`  Seg ${i+1} dub failed:`, e.message, '- using original');
        dubbedSegs.push({ ...seg, dubbedPath: seg.path, dubbedName: seg.name });
      }
    }

    // Step 5: Stitch audio back together using adelay to preserve timing
    console.log('Step 5: Stitching audio...');
    const stitchArgs = ['-y'];
    dubbedSegs.forEach(s => stitchArgs.push('-i', s.dubbedPath));
    const filters = dubbedSegs.map((s, i) => `[${i}]adelay=${Math.round(s.start*1000)}|${Math.round(s.start*1000)}[d${i}]`);
    const mixIn = dubbedSegs.map((_,i) => `[d${i}]`).join('');
    stitchArgs.push('-filter_complex', filters.join(';')+`;${mixIn}amix=inputs=${dubbedSegs.length}:normalize=0[aout]`);
    const finalAudioPath = path.resolve(workDir, 'final_audio.mp3');
    stitchArgs.push('-map','[aout]','-c:a','mp3',finalAudioPath);
    runFFmpeg(stitchArgs, 120000);
    console.log('Audio stitched:', fs.statSync(finalAudioPath).size, 'bytes');

    // Step 6: Put audio over original muted video
    console.log('Step 6: Merging audio over original video...');
    runFFmpeg(['-y','-i',videoPath,'-i',finalAudioPath,
      '-map','0:v','-map','1:a',
      '-c:v','libx264','-preset','ultrafast','-crf','23',
      '-c:a','aac','-shortest',outputPath], 180000);
    console.log('Done! Output:', fs.statSync(outputPath).size, 'bytes');

    // Zip dubbed audio clips
    const archiver = require('archiver');
    const zipOut = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    await new Promise((resolve, reject) => {
      zipOut.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(zipOut);
      dubbedSegs.forEach(s => archive.file(s.dubbedPath, { name: s.dubbedName }));
      archive.finalize();
    });

    const speakerMap = {};
    dubbedSegs.forEach(s => {
      if (!speakerMap[s.speaker]) speakerMap[s.speaker] = [];
      speakerMap[s.speaker].push({ url: '/outputs/dub_'+timestamp+'/'+s.dubbedName, text: s.text, start: s.start.toFixed(1), dur: s.dur.toFixed(1) });
    });

    try { fs.unlinkSync(videoPath); } catch(e) {}
    setTimeout(() => { try { fs.rmSync(workDir, { recursive: true, force: true }); fs.unlinkSync(outputPath); fs.unlinkSync(zipPath); } catch(e) {} }, 600000);

    res.json({ success: true, videoUrl: '/outputs/final_dubbed_'+timestamp+'.mp4', zipUrl: '/outputs/dubbed_clips_'+timestamp+'.zip', speakers: speakerMap });

  } catch(err) {
    console.error('dub-speakers error:', err.message);
    if (err.response) console.error('API error:', JSON.stringify(err.response.data).slice(0,300));
    try { fs.unlinkSync(videoPath); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── SPEAKER SPLIT TEST ────────────────────────────────────────────────────────
// Extracts audio, detects speakers, splits into individual audio files, returns them all
app.post('/split-speakers', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  const workDir = path.resolve('outputs/split_'+timestamp);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    if (!process.env.ASSEMBLYAI_API_KEY) throw new Error('ASSEMBLYAI_API_KEY not set');

    // Step 1: Extract audio
    console.log('Step 1: Extracting audio...');
    const audioPath = path.resolve(workDir, 'full_audio.mp3');
    runFFmpeg(['-y','-i',videoPath,'-vn','-ac','1','-ar','16000','-c:a','mp3',audioPath], 60000);
    console.log('Audio extracted:', fs.statSync(audioPath).size, 'bytes');

    // Step 2: Upload to AssemblyAI + diarize
    console.log('Step 2: Detecting speakers with AssemblyAI...');
    const audioBuffer = fs.readFileSync(audioPath);
    const uploadRes = await axios.post('https://api.assemblyai.com/v2/upload', audioBuffer, {
      headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY, 'content-type': 'application/octet-stream' },
      timeout: 60000
    });
    const jobRes = await axios.post('https://api.assemblyai.com/v2/transcript', {
      audio_url: uploadRes.data.upload_url,
      speaker_labels: true,
      speech_model: 'universal-2'
    }, { headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }, timeout: 30000 });

    console.log('Diarization job:', jobRes.data.id);
    let utterances = [];
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const poll = await axios.get('https://api.assemblyai.com/v2/transcript/'+jobRes.data.id, {
        headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }, timeout: 15000
      });
      console.log('Poll', i+1, ':', poll.data.status);
      if (poll.data.status === 'completed') { utterances = poll.data.utterances || []; break; }
      if (poll.data.status === 'error') throw new Error('AssemblyAI: ' + poll.data.error);
    }
    if (utterances.length === 0) throw new Error('No utterances detected');

    const speakers = [...new Set(utterances.map(u => u.speaker))];
    console.log('Speakers found:', speakers.join(', '), '| Segments:', utterances.length);

    // Step 3: Cut audio per utterance
    console.log('Step 3: Cutting audio segments...');
    const clips = [];
    for (let i = 0; i < utterances.length; i++) {
      const u = utterances[i];
      const start = u.start / 1000;
      const dur = (u.end - u.start) / 1000;
      if (dur < 0.3) continue;
      const clipName = `speaker_${u.speaker}_seg${String(i).padStart(3,'0')}_${start.toFixed(1)}s.mp3`;
      const clipPath = path.resolve(workDir, clipName);
      try {
        runFFmpeg(['-y','-ss',String(start),'-i',audioPath,'-t',String(dur),'-c:a','mp3',clipPath], 30000);
        if (fs.existsSync(clipPath) && fs.statSync(clipPath).size > 500) {
          clips.push({ name: clipName, speaker: u.speaker, start: start.toFixed(2), dur: dur.toFixed(2), text: u.text, url: '/outputs/split_'+timestamp+'/'+clipName });
          console.log(`  Seg ${i}: Speaker ${u.speaker} [${start.toFixed(1)}s, ${dur.toFixed(1)}s] "${u.text.slice(0,40)}"`);
        }
      } catch(e) { console.log(`  Seg ${i} failed:`, e.message); }
    }

    console.log('Done! Cut', clips.length, 'audio segments');
    try { fs.unlinkSync(videoPath); } catch(e) {}

    // Auto-delete after 10 mins
    setTimeout(() => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e) {} }, 600000);

    res.json({ success: true, speakers, segments: clips });
  } catch(err) {
    console.error('split-speakers error:', err.message);
    if (err.response) console.error('API error:', JSON.stringify(err.response.data).slice(0,300));
    try { fs.unlinkSync(videoPath); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DUB SPEAKERS ─────────────────────────────────────────────────────────────
// Full pipeline: extract audio → diarize → split → dub each → stitch → put over video
app.post('/dub-speakers', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  const targetLang = req.body.language || 'es';
  const workDir = path.resolve('outputs/dub_'+timestamp);
  const outputPath = path.resolve('outputs/final_dubbed_'+timestamp+'.mp4');
  const zipPath = path.resolve('outputs/dubbed_clips_'+timestamp+'.zip');
  fs.mkdirSync(workDir, { recursive: true });

  try {
    if (!process.env.ASSEMBLYAI_API_KEY) throw new Error('ASSEMBLYAI_API_KEY not set');
    if (!process.env.MODELSLAB_API_KEY) throw new Error('MODELSLAB_API_KEY not set');

    // Step 1: Extract audio
    console.log('Step 1: Extracting audio...');
    const audioPath = path.resolve(workDir, 'full_audio.mp3');
    runFFmpeg(['-y','-i',videoPath,'-vn','-ac','1','-ar','16000','-c:a','mp3',audioPath], 60000);

    // Step 2: AssemblyAI diarization
    console.log('Step 2: Diarizing...');
    const audioBuffer = fs.readFileSync(audioPath);
    const uploadRes = await axios.post('https://api.assemblyai.com/v2/upload', audioBuffer, {
      headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY, 'content-type': 'application/octet-stream' },
      timeout: 60000
    });
    const jobRes = await axios.post('https://api.assemblyai.com/v2/transcript', {
      audio_url: uploadRes.data.upload_url,
      speaker_labels: true,
      speech_model: 'universal-2'
    }, { headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }, timeout: 30000 });

    let utterances = [];
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const poll = await axios.get('https://api.assemblyai.com/v2/transcript/'+jobRes.data.id, {
        headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }, timeout: 15000
      });
      console.log('Poll', i+1, ':', poll.data.status);
      if (poll.data.status === 'completed') { utterances = poll.data.utterances || []; break; }
      if (poll.data.status === 'error') throw new Error('AssemblyAI: ' + poll.data.error);
    }
    if (utterances.length === 0) throw new Error('No utterances detected');

    const speakers = [...new Set(utterances.map(u => u.speaker))];
    console.log('Speakers:', speakers.join(', '), '| Segments:', utterances.length);

    if (speakers.length < 2) {
      console.log('Only 1 speaker - falling back to full video dub');
      const r2Key = 'dub_input_'+timestamp+'.mp4';
      const videoUrl = await uploadToR2(videoPath, r2Key);
      const videoData = await dubWithModelsLab(videoUrl, targetLang);
      fs.writeFileSync(outputPath, videoData);
      try { fs.unlinkSync(videoPath); } catch(e) {}
      setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e) {} }, 600000);
      return res.json({ success: true, videoUrl: '/outputs/final_dubbed_'+timestamp+'.mp4', singleSpeaker: true });
    }

    // Step 3: Cut audio segments
    console.log('Step 3: Cutting', utterances.length, 'audio segments...');
    const segList = [];
    for (let i = 0; i < utterances.length; i++) {
      const u = utterances[i];
      const start = u.start / 1000;
      const dur = (u.end - u.start) / 1000;
      if (dur < 0.3) continue;
      const segName = 'seg_'+String(i).padStart(3,'0')+'_spk_'+u.speaker+'.mp3';
      const segPath = path.resolve(workDir, segName);
      try {
        runFFmpeg(['-y','-ss',String(start),'-i',audioPath,'-t',String(dur),'-c:a','mp3',segPath], 30000);
        if (fs.existsSync(segPath) && fs.statSync(segPath).size > 500) {
          segList.push({ path: segPath, name: segName, speaker: u.speaker, start, dur, text: u.text });
        }
      } catch(e) { console.log('Seg', i, 'cut failed:', e.message); }
    }
    console.log('Cut', segList.length, 'segments');

    // Step 4: Dub each segment via ModelsLab
    console.log('Step 4: Dubbing segments...');
    const dubbedSegs = [];
    for (let i = 0; i < segList.length; i++) {
      const seg = segList[i];
      console.log(`Dubbing seg ${i+1}/${segList.length}: Speaker ${seg.speaker}`);
      try {
        // Wrap audio in video for ModelsLab
        const wrapPath = path.resolve(workDir, 'wrap_'+i+'.mp4');
        runFFmpeg(['-y','-f','lavfi','-i','color=c=black:s=256x256:r=10',
          '-i',seg.path,'-c:v','libx264','-preset','ultrafast',
          '-c:a','aac','-shortest',wrapPath], 30000);

        const r2Key = 'seg_'+timestamp+'_'+i+'.mp4';
        const segUrl = await uploadToR2(wrapPath, r2Key);
        try { fs.unlinkSync(wrapPath); } catch(e) {}

        const videoData = await dubWithModelsLab(segUrl, targetLang);
        const dubbedPath = path.resolve(workDir, 'dubbed_'+seg.name.replace('.mp3','.mp4'));
        fs.writeFileSync(dubbedPath, videoData);

        // Extract audio from dubbed video
        const dubbedAudioPath = path.resolve(workDir, 'dubbed_'+seg.name);
        runFFmpeg(['-y','-i',dubbedPath,'-vn','-c:a','mp3',dubbedAudioPath], 30000);
        try { fs.unlinkSync(dubbedPath); } catch(e) {}

        console.log(`  Seg ${i+1} dubbed OK`);
        dubbedSegs.push({ ...seg, dubbedPath: dubbedAudioPath, dubbedName: 'dubbed_'+seg.name });
      } catch(e) {
        console.log(`  Seg ${i+1} dub failed:`, e.message, '- using original');
        dubbedSegs.push({ ...seg, dubbedPath: seg.path, dubbedName: seg.name });
      }
    }

    // Step 5: Stitch audio back together using adelay to preserve timing
    console.log('Step 5: Stitching audio...');
    const stitchArgs = ['-y'];
    dubbedSegs.forEach(s => stitchArgs.push('-i', s.dubbedPath));
    const filters = dubbedSegs.map((s, i) => `[${i}]adelay=${Math.round(s.start*1000)}|${Math.round(s.start*1000)}[d${i}]`);
    const mixIn = dubbedSegs.map((_,i) => `[d${i}]`).join('');
    stitchArgs.push('-filter_complex', filters.join(';')+`;${mixIn}amix=inputs=${dubbedSegs.length}:normalize=0[aout]`);
    const finalAudioPath = path.resolve(workDir, 'final_audio.mp3');
    stitchArgs.push('-map','[aout]','-c:a','mp3',finalAudioPath);
    runFFmpeg(stitchArgs, 120000);
    console.log('Audio stitched:', fs.statSync(finalAudioPath).size, 'bytes');

    // Step 6: Put audio over original muted video
    console.log('Step 6: Merging audio over original video...');
    runFFmpeg(['-y','-i',videoPath,'-i',finalAudioPath,
      '-map','0:v','-map','1:a',
      '-c:v','libx264','-preset','ultrafast','-crf','23',
      '-c:a','aac','-shortest',outputPath], 180000);
    console.log('Done! Output:', fs.statSync(outputPath).size, 'bytes');

    // Zip dubbed audio clips
    const archiver = require('archiver');
    const zipOut = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    await new Promise((resolve, reject) => {
      zipOut.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(zipOut);
      dubbedSegs.forEach(s => archive.file(s.dubbedPath, { name: s.dubbedName }));
      archive.finalize();
    });

    const speakerMap = {};
    dubbedSegs.forEach(s => {
      if (!speakerMap[s.speaker]) speakerMap[s.speaker] = [];
      speakerMap[s.speaker].push({ url: '/outputs/dub_'+timestamp+'/'+s.dubbedName, text: s.text, start: s.start.toFixed(1), dur: s.dur.toFixed(1) });
    });

    try { fs.unlinkSync(videoPath); } catch(e) {}
    setTimeout(() => { try { fs.rmSync(workDir, { recursive: true, force: true }); fs.unlinkSync(outputPath); fs.unlinkSync(zipPath); } catch(e) {} }, 600000);

    res.json({ success: true, videoUrl: '/outputs/final_dubbed_'+timestamp+'.mp4', zipUrl: '/outputs/dubbed_clips_'+timestamp+'.zip', speakers: speakerMap });

  } catch(err) {
    console.error('dub-speakers error:', err.message);
    if (err.response) console.error('API error:', JSON.stringify(err.response.data).slice(0,300));
    try { fs.unlinkSync(videoPath); } catch(e) {}
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
