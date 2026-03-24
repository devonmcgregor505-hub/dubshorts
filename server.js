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

// ── QUEUE ────────────────────────────────────────────────────────────────────
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

// ── CACHE ────────────────────────────────────────────────────────────────────
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

// ── CAPTIONS ─────────────────────────────────────────────────────────────────
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
  const captionMode = style.captionMode || 'single'; // 'single' | 'multi' | 'highlight'
  const highlightColor = style.highlightColor || '#f5e132';

  const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
  console.log(`Burning captions: ${frames.length} frames, ${fontSize}px, y=${Math.round(yPct*100)}%`);

  // Group cues into chunks for multi/highlight mode
  function getChunkAtTime(t) {
    if (captionMode === 'single') {
      const cue = cues.find(c => t >= c.start && t < c.end);
      return cue ? { words: [{ text: cue.text, highlight: true }] } : null;
    }
    // For multi/highlight: find which chunk contains t
    const idx = cues.findIndex(c => t >= c.start && t < c.end);
    if (idx < 0) return null;
    // Build chunk: go back to start of line, collect words that fit
    const chunk = buildChunk(idx, vidW, fontSize, fontFamily, textStyle);
    return chunk;
  }

  function buildChunk(activeIdx, w, fs, ff, ts) {
    // Find start of this chunk
    let start = activeIdx;
    while (start > 0) {
      const prev = cues[start - 1];
      const curr = cues[start];
      // New chunk if gap > 0.5s
      if (curr.start - prev.end > 0.5) break;
      start--;
    }
    // Collect words that fit on ~2 lines
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

      // Shadow
      if (shadowSize > 0) {
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = shadowSize * fontSize;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = shadowSize * fontSize * 0.3;
      }
      if (outlineWidthPct > 0) {
        ctx.lineWidth = fontSize * outlineWidthPct;
        ctx.strokeStyle = outlineColor;
        ctx.lineJoin = 'round';
        ctx.strokeText(txt, x, y);
      }
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.fillStyle = textColor;
      ctx.fillText(txt, x, y);
    } else {
      // Multi / highlight mode - render words on up to 2 lines
      const words = chunk.words.map(w => {
        let txt = w.text;
        if (textCase === 'upper') txt = txt.toUpperCase();
        else if (textCase === 'lower') txt = txt.toLowerCase();
        return { ...w, txt };
      });

      // Calculate total width for centering
      const wordWidths = words.map(w => ctx.measureText(w.txt + ' ').width);
      const totalW = wordWidths.reduce((a, b) => a + b, 0);

      // Wrap into lines
      const lines = [];
      let currentLine = [];
      let currentW = 0;
      words.forEach((w, i) => {
        if (currentW + wordWidths[i] > vidW * 0.85 && currentLine.length > 0) {
          lines.push(currentLine);
          currentLine = [w];
          currentW = wordWidths[i];
        } else {
          currentLine.push(w);
          currentW += wordWidths[i];
        }
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

          if (shadowSize > 0) {
            ctx.shadowColor = 'rgba(0,0,0,0.9)';
            ctx.shadowBlur = shadowSize * fontSize;
            ctx.shadowOffsetY = shadowSize * fontSize * 0.3;
          }
          if (outlineWidthPct > 0) {
            ctx.lineWidth = fontSize * outlineWidthPct;
            ctx.strokeStyle = outlineColor;
            ctx.lineJoin = 'round';
            ctx.strokeText(w.txt, cx, lineY);
          }
          ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
          ctx.fillStyle = color;
          ctx.fillText(w.txt, cx, lineY);
          curX += ww;
        });
      });
    }

    fs.writeFileSync(framePath, canvas.toBuffer('image/jpeg', { quality: 0.92 }));
    if (i % 30 === 0) console.log(`Captioned ${i}/${frames.length}`);
  }
  console.log('All frames captioned!');
}

// ── GROQ STT ─────────────────────────────────────────────────────────────────
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

// ── ELEVENLABS DUBBING ────────────────────────────────────────────────────────
async function dubWithElevenLabs(videoUrl, targetLang, localVideoPath) {
  const langMap = { es: 'es', hi: 'hi', pt: 'pt', ja: 'ja', fr: 'fr', pl: 'pl' };
  const lang = langMap[targetLang] || 'es';

  // ElevenLabs needs a reliable URL - upload directly as file
  const elevenUploadForm = new FormData();
  elevenUploadForm.append('file', fs.createReadStream(localVideoPath), { filename: 'video.mp4', contentType: 'video/mp4' });
  const elevenFileRes = await axios.post('https://file.io/?expires=1d', elevenUploadForm, {
    headers: elevenUploadForm.getHeaders(), timeout: 120000
  });
  console.log('file.io response:', JSON.stringify(elevenFileRes.data).slice(0,200));
  const elevenVideoUrl = elevenFileRes.data.link || elevenFileRes.data.url;
  console.log('ElevenLabs video URL:', elevenVideoUrl);

  const elevenForm = new FormData();
  elevenForm.append('source_url', elevenVideoUrl);
  elevenForm.append('target_lang', lang);
  elevenForm.append('source_lang', 'en');
  elevenForm.append('mode', 'automatic');
  elevenForm.append('num_speakers', '0');
  elevenForm.append('watermark', 'false');
  const startRes = await axios.post('https://api.elevenlabs.io/v1/dubbing', elevenForm, {
    headers: { ...elevenForm.getHeaders(), 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    timeout: 30000
  });

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
      // Download
      const dlRes = await axios.get(`https://api.elevenlabs.io/v1/dubbing/${dubbingId}/audio/${lang}`, {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
        responseType: 'arraybuffer',
        timeout: 120000
      });
      return dlRes.data;
    }
    if (status.data.status === 'failed') throw new Error('ElevenLabs dubbing failed');
  }
  throw new Error('ElevenLabs dubbing timed out');
}

// ── MODELSLAB DUBBING ─────────────────────────────────────────────────────────
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
    base64: false,
    webhook: null,
    track_id: null
  }, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });

  console.log('ModelsLab response:', JSON.stringify(dubRes.data).slice(0, 300));

  if (dubRes.data.status === 'success' && dubRes.data.output?.[0]) {
    const dlRes = await axios.get(dubRes.data.output[0], { responseType: 'arraybuffer', timeout: 120000 });
    return dlRes.data;
  }

  if (dubRes.data.status === 'processing' && dubRes.data.fetch_result) {
    for (let attempts = 0; attempts < 120; attempts++) {
      await new Promise(r => setTimeout(r, 5000));
      const poll = await axios.post(dubRes.data.fetch_result, { key: process.env.MODELSLAB_API_KEY }, {
        headers: { 'Content-Type': 'application/json' }
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
  const audioPath = path.resolve('uploads/dubbed_'+timestamp+'.mp4');
  const blurredPath = path.resolve('uploads/blurred_'+timestamp+'.mp4');
  const framesDir = path.resolve('uploads/frames_'+timestamp);
  const captionedPath = path.resolve('uploads/captioned_'+timestamp+'.mp4');
  const outputPath = path.resolve('outputs/final_'+timestamp+'.mp4');
  const allFiles = [videoPath, audioPath, blurredPath, captionedPath];

  console.log('File received:', req.file.originalname);

  let captionBox = null;
  if (req.body.captionBox) { try { captionBox = JSON.parse(req.body.captionBox); } catch(e) {} }
  let captionStyle = null;
  if (req.body.captionStyle) { try { captionStyle = JSON.parse(req.body.captionStyle); } catch(e) {} }
  const provider = req.body.provider || 'modelslab';
  const targetLang = req.body.language || 'es';

  // Check cache
  const fileBuffer = fs.readFileSync(videoPath);
  const cacheKey = getCacheKey(fileBuffer, targetLang, provider);
  const cached = getCachedResult(cacheKey);
  if (cached) {
    console.log('Cache hit! Returning cached result');
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
        cleanVideoPath = path.resolve('uploads/clean_'+timestamp+'.mp4');
        const result = spawnSync('python3', [
          path.join(__dirname, 'inpaint.py'),
          videoPath, cleanVideoPath,
          String(x), String(y), String(w), String(h)
        ], { encoding: 'utf8', timeout: 1200000, maxBuffer: 100*1024*1024 });
        console.log('Inpaint stdout:', result.stdout?.slice(-500) || 'EMPTY');
        if (result.status !== 0 || !fs.existsSync(cleanVideoPath)) {
          console.log('Inpaint failed, using original');
          cleanVideoPath = videoPath;
        } else {
          console.log('Caption removal done!');
        }
      }

      // Upload to tmpfiles
      console.log('Uploading to temp storage...');
      const uploadForm = new FormData();
      uploadForm.append('file', fs.createReadStream(cleanVideoPath), { filename: req.file.originalname, contentType: req.file.mimetype });
      const tmpRes = await axios.post('https://tmpfiles.org/api/v1/upload', uploadForm, { headers: uploadForm.getHeaders() });
      const videoUrl = tmpRes.data.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
      console.log('Video URL:', videoUrl);

      // Dubbing
      console.log(`Dubbing with ${provider}...`);
      let dubbedData;
      if (provider === 'elevenlabs') {
        dubbedData = await dubWithElevenLabs(videoUrl, targetLang, cleanVideoPath);
      } else {
        dubbedData = await dubWithModelsLab(videoUrl, targetLang);
      }
      fs.writeFileSync(audioPath, dubbedData);
      console.log('Dubbing complete!');

      // Transcription with Groq
      let cues = [];
      if (captionStyle && captionStyle.enabled) {
        try {
          console.log('Transcribing with Groq...');
          const dubbedAudioPath = path.resolve('uploads/dubbed_audio_'+timestamp+'.mp3');
          runFFmpeg(['-y','-i',audioPath,'-vn','-ar','16000','-ac','1','-b:a','64k',dubbedAudioPath], 60000);
          const groqData = await transcribeWithGroq(dubbedAudioPath);
          try { fs.unlinkSync(dubbedAudioPath); } catch(e) {}
          console.log('Groq transcript:', groqData.text?.slice(0,100));

          if (groqData.words && groqData.words.length > 0) {
            // Use word-level timestamps from Groq
            groqData.words.forEach(w => {
              cues.push({ start: w.start, end: w.end, text: w.word.trim() });
            });
            console.log(`Built ${cues.length} word-level cues from Groq`);
          } else if (groqData.text) {
            // Fallback: even distribution
            const probeResult = spawnSync(FFMPEG_PATH, ['-i', audioPath, '-f', 'null', '-'], { encoding: 'utf8' });
            const durMatch = (probeResult.stderr||'').match(/Duration: (\d+):(\d+):(\d+\.?\d*)/);
            const totalDur = durMatch ? parseInt(durMatch[1])*3600+parseInt(durMatch[2])*60+parseFloat(durMatch[3]) : 30;
            const words = groqData.text.trim().split(/\s+/).filter(w => w.length > 0);
            const wordDur = totalDur / words.length;
            words.forEach((word, i) => {
              cues.push({ start: i*wordDur, end: (i+1)*wordDur, text: word });
            });
            console.log(`Built ${cues.length} evenly-spaced cues`);
          }
        } catch(e) { console.log('Transcription failed:', e.message); }
      }

      let videoForMerge = audioPath;

      if (cues.length > 0) {
        console.log('Extracting frames...');
        fs.mkdirSync(framesDir, { recursive: true });
        const captionFps = Math.min(fps, 24);
        runFFmpeg(['-y','-i',videoForMerge,'-vf',`fps=${captionFps}`,'-q:v','3','-threads','2',path.join(framesDir,'frame%06d.jpg')], 300000);
        console.log('Burning captions...');
        await burnCaptionsOnFrames(framesDir, cues, vidW, vidH, captionFps, captionStyle);
        console.log('Reassembling...');
        runFFmpeg(['-y','-framerate',String(captionFps),'-i',path.join(framesDir,'frame%06d.jpg'),'-c:v','libx264','-preset','ultrafast','-crf','28','-pix_fmt','yuv420p','-threads','2',captionedPath], 300000);
        try { fs.readdirSync(framesDir).forEach(f=>fs.unlinkSync(path.join(framesDir,f))); fs.rmdirSync(framesDir); } catch(e){}
        videoForMerge = captionedPath;
        console.log('Captions burned!');
      }

      console.log('Final merge...');
      runFFmpeg(['-y','-i',videoForMerge,'-i',audioPath,'-map','0:v','-map','1:a?','-c:v','copy','-c:a','aac','-shortest',outputPath]);
      console.log('Done!');

      // Cache result
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

// Queue status endpoint
app.get('/queue', (req, res) => {
  res.json({ active: activeJobs, waiting: queue.length, max: MAX_CONCURRENT });
});

app.listen(PORT, ()=>{ console.log('DubShorts running at http://localhost:'+PORT); });
