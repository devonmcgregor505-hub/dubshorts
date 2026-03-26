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
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

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
  // Generate a signed URL valid for 1 hour
  const url = await getSignedUrl(r2, new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
  }), { expiresIn: 3600 });
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

// ── QUEUE ─────────────────────────────────────────────────────────────────────
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
  const fontFamily = style.fontFamily || (fs.existsSync(fontPath) ? 'CaptionFont' : 'sans-serif');
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

  function buildChunk(activeIdx) {
    // Find the line that contains the active word (15 char max per line)
    // Build lines greedily from the start of the transcript
    const lines = [];
    let i = 0;
    let activeLine = 0;
    while (i < cues.length) {
      const line = [];
      let charCount = 0;
      while (i < cues.length) {
        const word = cues[i];
        const wordLen = word.text.length;
        if (line.length > 0 && charCount + 1 + wordLen > 15) break;
        line.push({ text: word.text, highlight: i === activeIdx, start: word.start, end: word.end });
        charCount += (line.length === 1 ? 0 : 1) + wordLen;
        if (i === activeIdx) activeLine = lines.length;
        i++;
      }
      lines.push(line);
    }
    // Return only the line containing the active word
    return { words: lines[activeLine] || [] };
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
    canvas.width = 0; canvas.height = 0;
    if (i % 30 === 0) { console.log(`Captioned ${i}/${frames.length}`); await new Promise(r => setTimeout(r, 1)); }
  }
  console.log('All frames captioned!');
}




async function dubWithSpeakerSeparation(videoPath, targetLang, speakerSegments, timestamp) {
  try {
    const speakers = [...new Set(speakerSegments.map(s => s.speaker))];
    if (speakers.length < 2) {
      console.log('Only 1 speaker detected, skipping speaker separation');
      return null;
    }
    console.log(`Multi-speaker dubbing: ${speakers.length} speakers, ${speakerSegments.length} segments`);

    const langMap = { es: 'es', hi: 'hi', pt: 'pt', ja: 'ja', fr: 'fr', pl: 'pl' };
    const lang = langMap[targetLang] || 'es';
    const dubbedClips = [];

    for (let i = 0; i < speakerSegments.length; i++) {
      const seg = speakerSegments[i];
      const clipPath = path.resolve(`uploads/spk_clip_${timestamp}_${i}.mp4`);
      const dubbedClipPath = path.resolve(`uploads/spk_dub_${timestamp}_${i}.mp4`);

      // Cut clip
      const duration = seg.end - seg.start;
      if (duration < 0.5) {
        console.log(`Segment ${i} too short (${duration}s), copying as-is`);
        runFFmpeg(['-y','-i',videoPath,'-ss',String(seg.start),'-t',String(duration),
          '-c:v','libx264','-preset','ultrafast','-c:a','aac',clipPath], 60000);
        dubbedClips.push(clipPath);
        continue;
      }

      runFFmpeg(['-y','-i',videoPath,'-ss',String(seg.start),'-t',String(duration),
        '-c:v','libx264','-preset','ultrafast','-c:a','aac',clipPath], 60000);
      console.log(`Segment ${i} cut: speaker=${seg.speaker} ${seg.start}s–${seg.end}s`);

      // Upload clip
      const uploadForm = new FormData();
      uploadForm.append('file', fs.createReadStream(clipPath), { filename: `clip_${i}.mp4`, contentType: 'video/mp4' });
      const tmpRes = await axios.post('https://tmpfiles.org/api/v1/upload', uploadForm, {
        headers: uploadForm.getHeaders(), timeout: 60000
      });
      const clipUrl = tmpRes.data.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
      console.log(`Segment ${i} uploaded:`, clipUrl);

      // Dub clip
      let dubbedUrl = null;
      try {
        const dubRes = await axios.post('https://modelslab.com/api/v6/voice/create_dubbing', {
          key: process.env.MODELSLAB_API_KEY,
          init_video: clipUrl,
          source_lang: 'en',
          output_lang: lang,
          num_speakers: 1,
          speed: 1.0,
          file_prefix: `spk_${i}_${lang}_${Date.now()}`,
          base64: false, webhook: null, track_id: null
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 120000 });

        console.log(`Segment ${i} ModelsLab:`, dubRes.data.status);

        if (dubRes.data.status === 'success' && dubRes.data.output?.[0]) {
          dubbedUrl = dubRes.data.output[0];
        } else if (dubRes.data.status === 'processing' && dubRes.data.fetch_result) {
          for (let p = 0; p < 40; p++) {
            await new Promise(r => setTimeout(r, 5000));
            const poll = await axios.post(dubRes.data.fetch_result, { key: process.env.MODELSLAB_API_KEY }, {
              headers: { 'Content-Type': 'application/json' }, timeout: 30000
            });
            console.log(`Segment ${i} poll ${p+1}:`, poll.data.status);
            if (poll.data.status === 'success' && poll.data.output?.[0]) {
              dubbedUrl = poll.data.output[0]; break;
            }
          }
        }
      } catch(e) {
        console.log(`Segment ${i} dub failed:`, e.message);
      }

      if (dubbedUrl) {
        const dlRes = await axios.get(dubbedUrl, { responseType: 'arraybuffer', timeout: 120000 });
        fs.writeFileSync(dubbedClipPath, dlRes.data);
        console.log(`Segment ${i} dubbed! Size:`, dlRes.data.byteLength);
        dubbedClips.push(dubbedClipPath);
      } else {
        console.log(`Segment ${i} dubbing failed, using original clip`);
        dubbedClips.push(clipPath);
      }

      try { fs.unlinkSync(clipPath); } catch(e) {}
    }

    // Stitch all clips together
    console.log('Stitching', dubbedClips.length, 'clips...');
    const concatList = path.resolve(`uploads/concat_${timestamp}.txt`);
    fs.writeFileSync(concatList, dubbedClips.map(p => `file '${p}'`).join('\n'));
    const stitchedPath = path.resolve(`uploads/stitched_${timestamp}.mp4`);
    runFFmpeg(['-y','-f','concat','-safe','0','-i',concatList,
      '-c:v','libx264','-preset','ultrafast','-c:a','aac',stitchedPath], 180000);
    try { fs.unlinkSync(concatList); } catch(e) {}
    dubbedClips.forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });

    console.log('Stitching complete!');
    return stitchedPath;
  } catch(e) {
    console.log('dubWithSpeakerSeparation error:', e.message);
    return null;
  }
}

// ── MAIN ROUTE ────────────────────────────────────────────────────────────────
app.post('/translate', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  const audioPath = path.resolve('uploads/dubbed_audio_'+timestamp+'.mp3');
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
  const targetLang = req.body.language || 'es';
  const provider = req.body.provider || 'modelslab';

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
        console.log('Caption removal done!');
        cleanVideoPath = cleanPath;
        }
      }

      // Dubbing with speaker separation
      if (targetLang !== 'none') {
        try {
          // First get speaker segments from AssemblyAI
          let speakerSegments = [];
          try {
            console.log('Getting speaker diarization...');
            const diarAudioPath = path.resolve('uploads/diar_'+timestamp+'.mp3');
            runFFmpeg(['-y','-i',cleanVideoPath,'-vn','-ac','1','-ar','16000','-c:a','mp3',diarAudioPath], 60000);
            const diarBuffer = fs.readFileSync(diarAudioPath);
            const diarUpload = await axios.post('https://api.assemblyai.com/v2/upload', diarBuffer, {
              headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY, 'content-type': 'application/octet-stream' },
              timeout: 60000
            });
            try { fs.unlinkSync(diarAudioPath); } catch(e) {}
            const diarJob = await axios.post('https://api.assemblyai.com/v2/transcript', {
              audio_url: diarUpload.data.upload_url,
              speaker_labels: true
            }, { headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }, timeout: 30000 });
            for (let i = 0; i < 30; i++) {
              await new Promise(r => setTimeout(r, 3000));
              const poll = await axios.get('https://api.assemblyai.com/v2/transcript/'+diarJob.data.id, {
                headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }, timeout: 15000
              });
              if (poll.data.status === 'completed') {
                speakerSegments = (poll.data.utterances || []).map(u => ({
                  speaker: u.speaker, text: u.text, start: u.start/1000, end: u.end/1000
                }));
                console.log('Got', speakerSegments.length, 'speaker segments');
                break;
              }
              if (poll.data.status === 'error') break;
            }
          } catch(e) { console.log('Diarization failed:', e.message); }

          if (speakerSegments.length > 0) {
            // Use speaker-separated dubbing
            const mixedAudio = await dubWithSpeakerSeparation(cleanVideoPath, targetLang, speakerSegments, timestamp);
            if (mixedAudio) {
              runFFmpeg(['-y','-i',cleanVideoPath,'-i',mixedAudio,'-map','0:v','-map','1:a',
                '-c:v','copy','-c:a','aac','-shortest',dubbedVideoPath], 120000);
              try { fs.unlinkSync(mixedAudio); } catch(e) {}
              console.log('Speaker-separated dubbing complete!');
            } else {
              console.log('Speaker dubbing failed, falling back to full video dubbing...');
              speakerSegments = []; // trigger fallback below
            }
          }

          if (speakerSegments.length === 0) {
            // Fallback: dub full video
            console.log('Uploading to temp storage for dubbing...');
          const uploadForm = new FormData();
          uploadForm.append('file', fs.createReadStream(cleanVideoPath), { filename: req.file.originalname, contentType: req.file.mimetype });
          const tmpRes = await axios.post('https://tmpfiles.org/api/v1/upload', uploadForm, { headers: uploadForm.getHeaders() });
          const videoUrl = tmpRes.data.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
          console.log('Video URL:', videoUrl);

          const langMap = { es: 'es', hi: 'hi', pt: 'pt', ja: 'ja', fr: 'fr', pl: 'pl' };
          const lang = langMap[targetLang] || 'es';
          const dubRes = await axios.post('https://modelslab.com/api/v6/voice/create_dubbing', {
            key: process.env.MODELSLAB_API_KEY,
            init_video: videoUrl,
            source_lang: 'en',
            output_lang: lang,
            num_speakers: 0,
            speed: 1.0,
            file_prefix: 'dub_'+lang+'_'+Date.now()+'_'+Math.random().toString(36).slice(2),
            base64: false, webhook: null, track_id: null
          }, { headers: { 'Content-Type': 'application/json' }, timeout: 120000 });

          console.log('ModelsLab response:', JSON.stringify(dubRes.data).slice(0, 200));

          let dubbedUrl = null;
          if (dubRes.data.status === 'success' && dubRes.data.output?.[0]) {
            dubbedUrl = dubRes.data.output[0];
          } else if (dubRes.data.status === 'processing' && dubRes.data.fetch_result) {
            for (let attempts = 0; attempts < 60; attempts++) {
              await new Promise(r => setTimeout(r, 5000));
              const poll = await axios.post(dubRes.data.fetch_result, { key: process.env.MODELSLAB_API_KEY }, {
                headers: { 'Content-Type': 'application/json' }, timeout: 30000
              });
              console.log('Poll ' + (attempts+1) + ': ' + poll.data.status);
              if (poll.data.status === 'success' && poll.data.output?.[0]) {
                dubbedUrl = poll.data.output[0];
                break;
              }
            }
          }

          if (dubbedUrl) {
            const dlRes = await axios.get(dubbedUrl, { responseType: 'arraybuffer', timeout: 120000 });
            fs.writeFileSync(dubbedVideoPath, dlRes.data);
            console.log('Dubbing complete! Size:', dlRes.data.byteLength);
          } else {
            console.log('Dubbing failed or timed out - using original audio');
            fs.copyFileSync(cleanVideoPath, dubbedVideoPath);
          }
          } // end single speaker fallback
        } catch(e) {
          console.log('Dubbing error:', e.message);
          fs.copyFileSync(cleanVideoPath, dubbedVideoPath);
        }
      } else {
        fs.copyFileSync(cleanVideoPath, dubbedVideoPath);
      }

            // For transcription/captions: extract audio from dubbed content
      let cues = [];

      // VIDEO SOURCE for frame extraction and final merge
      // For elevenlabs: cleanVideoPath has the video (no audio)
      // Use dubbedVideoPath only if dubbing actually ran
      const dubbingRan = targetLang !== 'none' && fs.existsSync(dubbedVideoPath) && fs.statSync(dubbedVideoPath).size > 1000;
      const videoSource = dubbingRan ? dubbedVideoPath : cleanVideoPath;
      console.log('videoSource:', dubbingRan ? 'dubbed' : 'clean', fs.existsSync(videoSource) ? fs.statSync(videoSource).size+'b' : 'MISSING');
      let videoForMerge = videoSource;

      // AssemblyAI transcription - fast word-level captions
      if (req.body.addCaption === 'true') {
        try {
          console.log('AAI key:', !!process.env.ASSEMBLYAI_API_KEY);
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
            speech_models: ['universal-2'],
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
              const rawWords = pollRes.data.words || [];
              cues = rawWords.map((w, i) => ({
                start: w.start / 1000,
                end: rawWords[i+1] ? rawWords[i+1].start / 1000 : w.end / 1000 + 0.5,
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
          if (e.response) console.log('AAI error body:', JSON.stringify(e.response.data).slice(0,300));
        }
      }

      // Burn captions if needed
      console.log('captionStyle:', JSON.stringify(captionStyle));
      console.log('cues.length:', cues.length);
      if (cues.length > 0) {
        console.log('Burning captions with Python...');
        // Scale to 720p for burning to save RAM, upscale after
        const burnH = Math.min(vidH, 720);
        const burnW = Math.round(vidW * burnH / vidH) & ~1;
        const scaledForBurn = path.resolve('uploads/scaled_'+timestamp+'.mp4');
        const scaledStyle = Object.assign({}, captionStyle, { yPct: captionStyle.yPct !== undefined ? captionStyle.yPct : 70 });
        runFFmpeg(['-y','-i',videoSource,'-vf',`scale=${burnW}:${burnH}`,'-c:v','libx264','-preset','ultrafast','-crf','23',scaledForBurn], 120000);
        const burnSource = fs.existsSync(scaledForBurn) ? scaledForBurn : videoSource;
        const pyResult = spawnSync('python3', [
          path.join(__dirname, 'burn_captions.py'),
          burnSource, captionedPath,
          JSON.stringify(cues), JSON.stringify(scaledStyle)
        ], { encoding: 'utf8', timeout: 600000, maxBuffer: 100*1024*1024 });
        try { fs.unlinkSync(scaledForBurn); } catch(e) {}
        console.log('Python stdout:', pyResult.stdout?.slice(-300));
        if (pyResult.stderr) console.log('Python stderr:', pyResult.stderr?.slice(-200));
        if (pyResult.status === 0 && fs.existsSync(captionedPath)) {
          // Upscale back to original resolution
          if (burnH < vidH) {
            const upscaledPath = path.resolve('uploads/upscaled_'+timestamp+'.mp4');
            runFFmpeg(['-y','-i',captionedPath,'-vf',`scale=${vidW}:${vidH}`,'-c:v','libx264','-preset','ultrafast','-crf','23',upscaledPath], 120000);
            if (fs.existsSync(upscaledPath)) {
              try { fs.unlinkSync(captionedPath); } catch(e) {}
              fs.renameSync(upscaledPath, captionedPath);
            }
          }
          videoForMerge = captionedPath;
          console.log('Captions burned!');
        } else {
          console.log('Caption burning failed, skipping captions');
        }
      }

      // Final merge
      console.log('Final merge...');
      if (targetLang === 'none') {
        console.log('No translation - merging with original audio...');
        runFFmpeg(['-y','-i',videoForMerge,'-i',videoPath,'-map','0:v','-map','1:a?','-c:v','libx264','-preset','ultrafast','-crf','23','-c:a','aac','-shortest',outputPath], 180000);
      } else {
        // Use original video stream + dubbed audio to avoid freeze artifacts from re-encoding
        runFFmpeg(['-y','-i',videoPath,'-i',dubbedVideoPath,'-map','0:v','-map','1:a','-c:v','copy','-c:a','aac','-shortest',outputPath], 180000);
      }
      const outSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
      console.log('Done! Output size:', outSize, 'bytes');

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
