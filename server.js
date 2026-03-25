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

// ── QUEUE ─────────────────────────────────────────────────────────────────────
const queue = [];
let activeJobs = 0;
const MAX_CONCURRENT = 2;

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

// ── CACHE ─────────────────────────────────────────────────────────────────────
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

// ── CAPTIONS ──────────────────────────────────────────────────────────────────
async function burnCaptionsOnFrames(framesDir, cues, vidW, vidH, fps, style) {
  style = style || {};
  const yPct = (style.yPct !== undefined ? style.yPct : 75) / 100;
  const fontSizePct = (style.fontSize || 5) / 100;
  const fontSize = Math.max(10, Math.round(vidH * fontSizePct));
  const fontFamily = fs.existsSync(fontPath) ? 'CaptionFont' : 'sans-serif';
  const textStyle = style.textStyle || 'bold';
  const textColor = style.textColor || '#ffffff';
  const outlineColor = style.outlineColor || '#000000';
  const outlineWidthPct = (style.outlineWidth || 15) / 100;
  const textCase = style.textCase || 'upper';
  const shadowSize = style.shadowSize || 0;
  const captionMode = style.captionMode || 'single';
  const highlightColor = style.highlightColor || '#f5e132';

  const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
  console.log(`Burning captions: ${frames.length} frames, ${fontSize}px, y=${Math.round(yPct*100)}%`);

  function getChunkAtTime(t) {
    if (captionMode === 'single') {
      const cue = cues.find(c => t >= c.start && t < c.end);
      return cue ? { words: [{ text: cue.text, highlight: true }] } : null;
    }
    const idx = cues.findIndex(c => t >= c.start && t < c.end);
    if (idx < 0) return null;
    return buildChunk(idx, vidW, fontSize, fontFamily, textStyle);
  }

  function buildChunk(activeIdx, w, fs, ff, ts) {
    let start = activeIdx;
    while (start > 0) {
      const prev = cues[start - 1];
      const curr = cues[start];
      if (curr.start - prev.end > 0.5) break;
      start--;
    }
    const words = [];
    const canvas = createCanvas(w, 100);
    const ctx = canvas.getContext('2d');
    ctx.font = `${ts} ${fs}px ${ff}`;
    let lineW = 0;
    let lines = 1;
    for (let i = start; i < cues.length; i++) {
      const word = cues[i];
      const wordW = ctx.measureText(word.text + ' ').width;
      if (lineW + wordW > w * 0.85) {
        lines++;
        lineW = wordW;
        if (lines > 2) break;
      } else {
        lineW += wordW;
      }
      words.push({ text: word.text, highlight: i === activeIdx, start: word.start, end: word.end });
      if (i > activeIdx && words.length > 0 && word.start > cues[activeIdx].end + 0.1) break;
    }
    return { words };
  }

  for (let i = 0; i < frames.length; i++) {
    const t = i / fps;
    const chunk = getChunkAtTime(t);
    if (!chunk) continue;

    const framePath = path.join(framesDir, frames[i]);
    const img = await loadImage(framePath);
    const canvas = createCanvas(vidW, vidH);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, vidW, vidH);

    const x = vidW / 2;
    const y = yPct * vidH;
    ctx.font = `${textStyle} ${fontSize}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (captionMode === 'single') {
      let txt = chunk.words[0].text;
      if (textCase === 'upper') txt = txt.toUpperCase();
      else if (textCase === 'lower') txt = txt.toLowerCase();
      if (shadowSize > 0) { ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = shadowSize * fontSize; ctx.shadowOffsetY = shadowSize * fontSize * 0.3; }
      if (outlineWidthPct > 0) { ctx.lineWidth = fontSize * outlineWidthPct; ctx.strokeStyle = outlineColor; ctx.lineJoin = 'round'; ctx.strokeText(txt, x, y); }
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.fillStyle = textColor; ctx.fillText(txt, x, y);
    } else {
      const words = chunk.words.map(w => {
        let txt = w.text;
        if (textCase === 'upper') txt = txt.toUpperCase();
        else if (textCase === 'lower') txt = txt.toLowerCase();
        return { ...w, txt };
      });
      const wordWidths = words.map(w => ctx.measureText(w.txt + ' ').width);
      const lines = [];
      let currentLine = [], currentW = 0;
      words.forEach((w, i) => {
        if (currentW + wordWidths[i] > vidW * 0.85 && currentLine.length > 0) {
          lines.push(currentLine); currentLine = [w]; currentW = wordWidths[i];
        } else { currentLine.push(w); currentW += wordWidths[i]; }
      });
      if (currentLine.length) lines.push(currentLine);
      const lineH = fontSize * 1.3;
      const startY = y - ((lines.length - 1) * lineH) / 2;
      lines.forEach((line, li) => {
        const lineW = line.reduce((acc, w, i) => acc + ctx.measureText(w.txt + ' ').width, 0);
        let curX = vidW / 2 - lineW / 2;
        const lineY = startY + li * lineH;
        line.forEach(w => {
          const ww = ctx.measureText(w.txt + ' ').width;
          const cx = curX + ww / 2 - ctx.measureText(' ').width / 2;
          const color = (captionMode === 'highlight' && w.highlight) ? highlightColor : textColor;
          if (shadowSize > 0) { ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = shadowSize * fontSize; ctx.shadowOffsetY = shadowSize * fontSize * 0.3; }
          if (outlineWidthPct > 0) { ctx.lineWidth = fontSize * outlineWidthPct; ctx.strokeStyle = outlineColor; ctx.lineJoin = 'round'; ctx.strokeText(w.txt, cx, lineY); }
          ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
          ctx.fillStyle = color; ctx.fillText(w.txt, cx, lineY);
          curX += ww;
        });
      });
    }
    fs.writeFileSync(framePath, canvas.toBuffer('image/jpeg', { quality: 0.92 }));
    if (i % 30 === 0) console.log(`Captioned ${i}/${frames.length}`);
  }
  console.log('All frames captioned!');
}

// ── GROQ STT ──────────────────────────────────────────────────────────────────
async function transcribeWithGroq(audioPath) {
  const FormDataNode = require('form-data');
  const form = new FormDataNode();
  form.append('file', fs.createReadStream(audioPath), { filename: 'audio.mp3', contentType: 'audio/mp3' });
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('language', 'es');
  const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
    headers: { ...form.getHeaders(), 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
    timeout: 60000
  });
  return res.data;
}

// ── ELEVENLABS ────────────────────────────────────────────────────────────────
// ElevenLabs flow:
// 1. Re-encode video to h264 so ElevenLabs accepts it
// 2. Upload file directly to ElevenLabs dubbing API
// 3. Poll until status === 'dubbed'
// 4. Download audio from /audio/{lang} endpoint (returns audio-only mp3)
// 5. Save as audioPath
// Then in main: merge cleanVideoPath (video) + audioPath (dubbed audio) = output
async function dubWithElevenLabs(targetLang, localVideoPath, timestamp) {
  const langMap = { es: 'es', hi: 'hi', pt: 'pt', ja: 'ja', fr: 'fr', pl: 'pl' };
  const lang = langMap[targetLang] || 'es';

  // Re-encode to h264/aac so ElevenLabs can process it
  const encodedPath = path.resolve('uploads/eleven_encoded_'+timestamp+'.mp4');
  runFFmpeg(['-y','-i',localVideoPath,'-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=44100','-c:v','libx264','-preset','ultrafast','-crf','23','-c:a','aac','-b:a','128k','-shortest',encodedPath], 60000);
  console.log('Re-encoded video for ElevenLabs');

  const elevenForm = new FormData();
  elevenForm.append('file', fs.createReadStream(encodedPath), { filename: 'video.mp4', contentType: 'video/mp4' });
  elevenForm.append('target_lang', lang);
  elevenForm.append('source_lang', 'en');
  elevenForm.append('mode', 'automatic');
  elevenForm.append('num_speakers', '0');
  elevenForm.append('watermark', 'false');

  const startRes = await axios.post('https://api.elevenlabs.io/v1/dubbing', elevenForm, {
    headers: { ...elevenForm.getHeaders(), 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    timeout: 120000, maxContentLength: Infinity, maxBodyLength: Infinity
  });

  try { fs.unlinkSync(encodedPath); } catch(e) {}

  const dubbingId = startRes.data.dubbing_id;
  console.log('ElevenLabs dubbing ID:', dubbingId);

  // Poll for completion
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const status = await axios.get(`https://api.elevenlabs.io/v1/dubbing/${dubbingId}`, {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
    });
    console.log(`ElevenLabs poll ${i+1}: ${status.data.status}`);
    if (status.data.status === 'dubbed') {
      // Download dubbed AUDIO (this endpoint returns audio only - mp3)
      const dlRes = await axios.get(`https://api.elevenlabs.io/v1/dubbing/${dubbingId}/audio/${lang}`, {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
        responseType: 'arraybuffer', timeout: 120000
      });
      console.log('ElevenLabs audio downloaded, size:', dlRes.data.byteLength);
      return dlRes.data; // This is audio-only mp3 data
    }
    if (status.data.status === 'failed') throw new Error('ElevenLabs dubbing failed');
  }
  throw new Error('ElevenLabs dubbing timed out');
}

// ── MODELSLAB ─────────────────────────────────────────────────────────────────
async function dubWithModelsLab(videoUrl, targetLang) {
  const langMap = { es: 'es', hi: 'hi', pt: 'pt', ja: 'ja', fr: 'fr', pl: 'pl' };
  const lang = langMap[targetLang] || 'es';

  const dubRes = await axios.post('https://modelslab.com/api/v6/voice/create_dubbing', {
    key: process.env.MODELSLAB_API_KEY,
    init_video: videoUrl,
    source_lang: 'en',
    output_lang: lang,
    speed: 1.0,
    file_prefix: 'dub_'+lang+'_'+Date.now()+'_'+Math.random().toString(36).slice(2),
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
      console.log(`Poll ${attempts+1}: ${poll.data.status}`);
      if (poll.data.status === 'success' && poll.data.output?.[0]) {
        const dlRes = await axios.get(poll.data.output[0], { responseType: 'arraybuffer', timeout: 120000 });
        return dlRes.data;
      }
    }
  }
  throw new Error('ModelsLab dubbing failed or timed out');
}

// ── MAIN ROUTE ────────────────────────────────────────────────────────────────
app.post('/translate', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  // audioPath = dubbed audio (mp3 for elevenlabs, mp4 for modelslab)
  const audioPath = path.resolve('uploads/dubbed_audio_'+timestamp+'.mp3');
  // videoWithAudioPath = for modelslab this is the full dubbed video mp4
  const dubbedVideoPath = path.resolve('uploads/dubbed_video_'+timestamp+'.mp4');
  const framesDir = path.resolve('uploads/frames_'+timestamp);
  const captionedPath = path.resolve('uploads/captioned_'+timestamp+'.mp4');
  const outputPath = path.resolve('outputs/final_'+timestamp+'.mp4');
  const allFiles = [videoPath, audioPath, dubbedVideoPath, captionedPath, path.resolve('uploads/raw_inpaint_'+timestamp+'.mp4')];

  console.log('File received:', req.file.originalname);

  let captionBox = null;
  if (req.body.captionBox) { try { captionBox = JSON.parse(req.body.captionBox); } catch(e) {} }
  let captionStyle = null;
  if (req.body.captionStyle) { try { captionStyle = JSON.parse(req.body.captionStyle); } catch(e) {} }
  const provider = req.body.provider || 'modelslab';
  const targetLang = req.body.language || 'es';

  // Cache check
  const fileBuffer = fs.readFileSync(videoPath);
  const cacheKey = getCacheKey(fileBuffer, targetLang, provider);
  const cached = getCachedResult(cacheKey);
  if (cached) {
    console.log('Cache hit!');
    const cachedOut = path.resolve('outputs/final_'+timestamp+'.mp4');
    fs.copyFileSync(cached, cachedOut);
    setTimeout(()=>{ try { if(fs.existsSync(cachedOut)) fs.unlinkSync(cachedOut); } catch(e){} }, 600000);
    return res.json({ success: true, videoUrl: '/outputs/final_'+timestamp+'.mp4', cached: true });
  }

  try {
    const result = await enqueue(async () => {
      let vidW=1080, vidH=1920, fps=24;
      try {
        const probe = spawnSync(FFMPEG_PATH, ['-i', videoPath], { encoding: 'utf8' });
        const dim = (probe.stderr||'').match(/(\d{3,4})x(\d{3,4})/);
        const fpsM = (probe.stderr||'').match(/(\d+(?:\.\d+)?) fps/);
        if (dim) { vidW=parseInt(dim[1]); vidH=parseInt(dim[2]); }
        if (fpsM) fps=Math.min(parseFloat(fpsM[1]), 24);
        const durCheck = (probe.stderr||'').match(/Duration: (\d+):(\d+):(\d+\.?\d*)/);
        if (durCheck) {
          const durSecs = parseInt(durCheck[1])*3600+parseInt(durCheck[2])*60+parseFloat(durCheck[3]);
          if (durSecs > 120) throw new Error('Video must be under 2 minutes');
        }
        console.log('Video:', vidW, 'x', vidH, '@', fps, 'fps');
      } catch(e) { if (e.message.includes('under 2 minutes')) throw e; }

      // Caption removal
      let cleanVideoPath = videoPath;
      if (captionBox) {
        console.log('OpenCV caption removal...');
        const { x, y, w, h } = captionBox;
        const cleanPath = path.resolve('uploads/clean_'+timestamp+'.mp4');
        const rawInpaintPath = path.resolve('uploads/raw_inpaint_'+timestamp+'.mp4');
        const inpaintResult = spawnSync('python3', [
          path.join(__dirname, 'inpaint.py'),
          videoPath, rawInpaintPath,
          String(x), String(y), String(w), String(h)
        ], { encoding: 'utf8', timeout: 1200000, maxBuffer: 100*1024*1024 });
        console.log('Inpaint stdout:', inpaintResult.stdout?.slice(-300) || 'EMPTY');
        if (inpaintResult.status !== 0 || !fs.existsSync(rawInpaintPath)) {
          console.log('Inpaint failed, using original');
        } else {
          runFFmpeg(['-y','-i',rawInpaintPath,'-i',videoPath,'-map','0:v','-map','1:a?','-c:v','libx264','-preset','ultrafast','-crf','23','-c:a','aac','-shortest',cleanPath], 120000);
          try { fs.unlinkSync(rawInpaintPath); } catch(e) {}
          cleanVideoPath = cleanPath;
          console.log('Caption removal done!');
        }
      }

      // Dub
      if (targetLang === 'none') {
        fs.copyFileSync(cleanVideoPath, dubbedVideoPath);
        console.log('No translation selected');
      } else if (provider === 'elevenlabs') {
        const audioData = await dubWithElevenLabs(targetLang, cleanVideoPath, timestamp);
        fs.writeFileSync(audioPath, audioData);
        console.log('ElevenLabs dubbing complete!');
      } else if (provider === 'modelslab') {
        console.log('Uploading to temp storage...');
        const uploadForm = new FormData();
        uploadForm.append('file', fs.createReadStream(cleanVideoPath), { filename: req.file.originalname, contentType: req.file.mimetype });
        const tmpRes = await axios.post('https://tmpfiles.org/api/v1/upload', uploadForm, { headers: uploadForm.getHeaders() });
        const videoUrl = tmpRes.data.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
        console.log('Video URL:', videoUrl);
        const videoData = await dubWithModelsLab(videoUrl, targetLang);
        fs.writeFileSync(dubbedVideoPath, videoData);
        console.log('ModelsLab dubbing complete!');
      } else {
        // No translation selected
        fs.copyFileSync(cleanVideoPath, dubbedVideoPath);
        console.log('No dubbing - using original video');
      }

      // For transcription/captions: extract audio from dubbed content
      let cues = [];

      // VIDEO SOURCE for frame extraction and final merge
      // For elevenlabs: cleanVideoPath has the video (no audio)
      // For modelslab: dubbedVideoPath has video+audio
      const videoSource = provider === 'modelslab' ? dubbedVideoPath : cleanVideoPath;
      let videoForMerge = videoSource;

      // AssemblyAI transcription - fast word-level captions
      if (req.body.addCaption === 'true' && process.env.ASSEMBLYAI_API_KEY) {
        try {
          console.log('Extracting audio for AssemblyAI...');
          const aaiAudioPath = path.resolve('uploads/aai_audio_'+timestamp+'.mp3');
          runFFmpeg(['-y','-i',videoSource,'-vn','-ac','1','-ar','16000','-c:a','mp3',aaiAudioPath], 60000);

          const audioBuffer = fs.readFileSync(aaiAudioPath);
          const uploadRes = await axios.post('https://api.assemblyai.com/v2/upload', audioBuffer, {
            headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY, 'content-type': 'application/octet-stream' },
            timeout: 60000
          });
          console.log('Audio uploaded to AssemblyAI');
          try { fs.unlinkSync(aaiAudioPath); } catch(e) {}

          const transcriptRes = await axios.post('https://api.assemblyai.com/v2/transcript', {
            audio_url: uploadRes.data.upload_url,
          }, {
            headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY },
            timeout: 30000
          });

          const transcriptId = transcriptRes.data.id;
          console.log('AssemblyAI job:', transcriptId);

          for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const pollRes = await axios.get('https://api.assemblyai.com/v2/transcript/'+transcriptId, {
              headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }, timeout: 15000
            });
            console.log('AssemblyAI poll', i+1, ':', pollRes.data.status);
            if (pollRes.data.status === 'completed') {
              cues = (pollRes.data.words || []).map(w => ({
                start: w.start / 1000,
                end: w.end / 1000,
                text: w.text
              }));
              console.log('AssemblyAI done,', cues.length, 'word cues');
              break;
            } else if (pollRes.data.status === 'error') {
              console.log('AssemblyAI error:', pollRes.data.error);
              break;
            }
          }
        } catch(e) {
          console.log('Caption generation failed:', e.message);
        }
      }

      // Burn captions if needed
      if (cues.length > 0) {
        console.log('Extracting frames...');
        fs.mkdirSync(framesDir, { recursive: true });
        const captionFps = Math.min(fps, 24);
        runFFmpeg(['-y','-i',videoSource,'-vf',`fps=${captionFps}`,'-q:v','3','-threads','2',path.join(framesDir,'frame%06d.jpg')], 300000);
        console.log('Burning captions...');
        await burnCaptionsOnFrames(framesDir, cues, vidW, vidH, captionFps, captionStyle);
        console.log('Reassembling...');
        runFFmpeg(['-y','-framerate',String(captionFps),'-i',path.join(framesDir,'frame%06d.jpg'),'-c:v','libx264','-preset','ultrafast','-crf','28','-pix_fmt','yuv420p','-threads','2',captionedPath], 300000);
        try { fs.readdirSync(framesDir).forEach(f=>fs.unlinkSync(path.join(framesDir,f))); fs.rmdirSync(framesDir); } catch(e){}
        videoForMerge = captionedPath;
        console.log('Captions burned!');
      }

      // Final merge
      console.log('Final merge...');
      if (targetLang === 'none') {
        fs.copyFileSync(cleanVideoPath, dubbedVideoPath);
        console.log('No translation selected');
      } else if (provider === 'elevenlabs') {
        // videoForMerge = captioned video (no audio) OR cleanVideoPath
        // audioPath = dubbed audio mp3 from ElevenLabs
        console.log('Merging video + ElevenLabs audio...');
        runFFmpeg(['-y','-i',videoForMerge,'-i',audioPath,'-map','0:v','-map','1:a','-c:v','libx264','-preset','ultrafast','-crf','23','-c:a','aac','-b:a','128k','-shortest',outputPath], 180000);
      } else if (provider === 'modelslab') {
        // dubbedVideoPath already has video+audio from ModelsLab
        runFFmpeg(['-y','-i',dubbedVideoPath,'-c:v','libx264','-preset','ultrafast','-crf','23','-c:a','aac',outputPath], 180000);
      } else {
        // No dubbing - merge video with original audio
        runFFmpeg(['-y','-i',videoForMerge,'-i',videoPath,'-map','0:v','-map','1:a?','-c:v','libx264','-preset','ultrafast','-crf','23','-c:a','aac','-shortest',outputPath], 180000);
      }
      console.log('Done!');

      setCachedResult(cacheKey, outputPath);
      allFiles.forEach(f=>{ try { if(fs.existsSync(f)) fs.unlinkSync(f); } catch(e){} });
      setTimeout(()=>{ try { if(fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch(e){} }, 600000);
      return { success: true, videoUrl: '/outputs/final_'+timestamp+'.mp4' };
    });

    res.json(result);
  } catch(err) {
    console.error('Error:', err.message);
    if (err.response) console.error('API error:', JSON.stringify(err.response.data).slice(0,300));
    allFiles.concat([outputPath]).forEach(f=>{ try { if(fs.existsSync(f)) fs.unlinkSync(f); } catch(e){} });
    try { if(fs.existsSync(framesDir)){ fs.readdirSync(framesDir).forEach(f=>fs.unlinkSync(path.join(framesDir,f))); fs.rmdirSync(framesDir); } } catch(e){}
    res.status(500).json({ success: false, error: err.message });
  }
});

const SETTINGS_FILE = path.resolve('settings.json');

app.get('/settings', (req, res) => {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      res.json(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
    } else {
      res.json({});
    }
  } catch(e) { res.json({}); }
});

app.post('/settings', express.json(), (req, res) => {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false }); }
});

app.get('/queue', (req, res) => {
  res.json({ active: activeJobs, waiting: queue.length, max: MAX_CONCURRENT });
});

app.listen(PORT, ()=>{ console.log('DubShorts running at http://localhost:'+PORT); });

// TEMP: serve last audio for debugging
app.get('/test-audio', (req, res) => {
  const files = require('fs').readdirSync('uploads').filter(f => f.startsWith('dubbed_audio'));
  if (files.length === 0) return res.send('no audio files');
  const latest = files.sort().pop();
  res.setHeader('Content-Type', 'audio/mpeg');
  require('fs').createReadStream('uploads/' + latest).pipe(res);
});
