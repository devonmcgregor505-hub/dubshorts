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
      console.log('Only 1 speaker - skipping speaker separation');
      return null;
    }
    console.log(`${speakers.length} speakers, ${speakerSegments.length} segments - splitting and stitching`);

    const clipsDir = path.resolve('uploads/clips_'+timestamp);
    fs.mkdirSync(clipsDir, { recursive: true });
    const clips = [];

    for (let i = 0; i < speakerSegments.length; i++) {
      const seg = speakerSegments[i];
      const dur = seg.end - seg.start;
      if (dur < 0.3) continue;

      const clipPath = path.resolve(clipsDir, `clip_${String(i).padStart(4,'0')}.mp4`);
      console.log(`Cutting clip ${i+1}/${speakerSegments.length}: Speaker ${seg.speaker} [${seg.start.toFixed(1)}-${seg.end.toFixed(1)}s]`);

      runFFmpeg(['-y','-ss', String(seg.start), '-i', videoPath, '-t', String(dur),
        '-c:v','libx264','-preset','ultrafast','-crf','23','-c:a','aac',
        '-avoid_negative_ts','make_zero', clipPath], 60000);

      if (fs.existsSync(clipPath) && fs.statSync(clipPath).size > 1000) {
        clips.push(clipPath);
        console.log(`  Clip ${i+1} OK (${dur.toFixed(1)}s)`);
      } else {
        console.log(`  Clip ${i+1} failed`);
      }
    }

    if (clips.length === 0) {
      console.log('No clips cut');
      try { fs.rmSync(clipsDir, { recursive: true }); } catch(e) {}
      return null;
    }

    // Stitch all clips together
    console.log(`Stitching ${clips.length} clips...`);
    const concatFile = path.resolve(clipsDir, 'concat.txt');
    fs.writeFileSync(concatFile, clips.map(p => 'file \'' + p + '\'').join('\n'));
    const stitchedPath = path.resolve(clipsDir, 'stitched.mp4');
    runFFmpeg(['-y','-f','concat','-safe','0','-i',concatFile,
      '-c:v','libx264','-preset','ultrafast','-crf','23','-c:a','aac',
      stitchedPath], 300000);

    try { fs.rmSync(clipsDir, { recursive: true, force: true }); } catch(e) {}

    if (fs.existsSync(stitchedPath)) {
      console.log('Stitching done!');
      return stitchedPath;
    }
    return null;
  } catch(e) {
    console.log('dubWithSpeakerSeparation error:', e.message);
    return null;
  }
}




app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
