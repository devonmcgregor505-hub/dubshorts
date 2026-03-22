require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const cors = require('cors');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const { createCanvas, loadImage, registerFont } = require('canvas');

const fonts = [
  { file: 'DejaVuSans-Bold.ttf', family: 'DejaVu', weight: 'bold' },
  { file: 'Poppins-Bold.ttf', family: 'Poppins', weight: 'bold' },
  { file: 'BebasNeue.ttf', family: 'BebasNeue', weight: 'normal' },
  { file: 'Montserrat-Bold.ttf', family: 'Montserrat', weight: 'bold' },
];
for (const f of fonts) {
  const fp = path.join(__dirname, f.file);
  if (fs.existsSync(fp)) {
    try {
      registerFont(fp, { family: f.family, weight: f.weight });
      console.log('Font registered:', f.family);
    } catch(e) {
      console.log('Font error:', f.family, e.message);
    }
  } else {
    console.log('Font missing:', f.file);
  }
}

let FFMPEG_PATH = ffmpegStatic;
try {
  const r = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  if (r.stdout && r.stdout.trim()) { FFMPEG_PATH = r.stdout.trim(); console.log('Using system ffmpeg:', FFMPEG_PATH); }
  else { console.log('Using ffmpeg-static:', FFMPEG_PATH); }
} catch(e) { console.log('Using ffmpeg-static:', FFMPEG_PATH); }

function runFFmpeg(args, timeout) {
  timeout = timeout || 180000;
  const result = spawnSync(FFMPEG_PATH, args, { timeout: timeout, maxBuffer: 100 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('FFmpeg failed: ' + (result.stderr || result.stdout || Buffer.from('')).toString().slice(-400));
}

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use('/outputs', express.static('outputs'));
const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('outputs')) fs.mkdirSync('outputs');
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

function srtTimeToSeconds(t) {
  const parts = t.split(':');
  const rest = parts[2].split(',');
  return parseInt(parts[0])*3600 + parseInt(parts[1])*60 + parseInt(rest[0]) + parseInt(rest[1])/1000;
}

function parseSrtToCues(srtContent) {
  const cues = [];
  const blocks = srtContent.trim().split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;
    const timeLine = lines[1];
    if (!timeLine.includes('-->')) continue;
    const parts = timeLine.split('-->');
    const startSec = srtTimeToSeconds(parts[0].trim());
    const endSec = srtTimeToSeconds(parts[1].trim());
    const text = lines.slice(2).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!text) continue;
    const words = text.split(/\s+/).filter(function(w) { return w.length > 0; });
    const dur = (endSec - startSec) / words.length;
    for (let i = 0; i < words.length; i++) {
      cues.push({ start: startSec + i * dur, end: startSec + (i+1) * dur, text: words[i] });
    }
  }
  return cues;
}

async function burnCaptionsOnFrames(framesDir, cues, vidW, vidH, fps, style) {
  if (!style) style = {};
  const fontSize = Math.round(vidH * ((style.fontSize || 5) / 100));
  const fontFamily = style.fontFamily || 'DejaVu';
  const textColor = style.textColor || '#ffffff';
  const outlineColor = style.outlineColor || '#000000';
  const outlineWidth = Math.max(1, fontSize * ((style.outlineWidth || 15) / 100));
  const yPos = style.yPos || 0.78;
  const textCase = style.textCase || 'upper';
  const frames = fs.readdirSync(framesDir).filter(function(f) { return f.endsWith('.jpg'); }).sort();
  console.log('Burning captions: ' + frames.length + ' frames, ' + fontSize + 'px ' + fontFamily);
  for (let i = 0; i < frames.length; i++) {
    const t = i / fps;
    const cue = cues.find(function(c) { return t >= c.start && t < c.end; });
    if (!cue) continue;
    const framePath = path.join(framesDir, frames[i]);
    const img = await loadImage(framePath);
    const canvas = createCanvas(vidW, vidH);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, vidW, vidH);
    let text = cue.text;
    if (textCase === 'upper') text = text.toUpperCase();
    else if (textCase === 'lower') text = text.toLowerCase();
    ctx.font = 'bold ' + fontSize + 'px "' + fontFamily + '"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const x = vidW / 2;
    const y = vidH * yPos;
    ctx.lineWidth = outlineWidth;
    ctx.strokeStyle = outlineColor;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = textColor;
    ctx.fillText(text, x, y);
    fs.writeFileSync(framePath, canvas.toBuffer('image/jpeg', { quality: 0.92 }));
    if (i % 50 === 0) console.log('Captioned ' + i + '/' + frames.length);
  }
  console.log('All frames captioned!');
}

app.post('/translate', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  const audioPath = path.resolve('uploads/spanish_' + timestamp + '.mp3');
  const blurredPath = path.resolve('uploads/blurred_' + timestamp + '.mp4');
  const framesDir = path.resolve('uploads/frames_' + timestamp);
  const captionedPath = path.resolve('uploads/captioned_' + timestamp + '.mp4');
  const outputPath = path.resolve('outputs/final_' + timestamp + '.mp4');
  const allFiles = [videoPath, audioPath, blurredPath, captionedPath];
  console.log('File received:', req.file.originalname);
  let captionBox = null;
  let captionStyle = null;
  if (req.body.captionBox) { try { captionBox = JSON.parse(req.body.captionBox); } catch(e) {} }
  if (req.body.captionStyle) { try { captionStyle = JSON.parse(req.body.captionStyle); } catch(e) {} }
  try {
    let vidW = 1080, vidH = 1920, fps = 30;
    try {
      const probe = spawnSync(FFMPEG_PATH, ['-i', videoPath], { encoding: 'utf8' });
      const dim = (probe.stderr || '').match(/(\d{3,4})x(\d{3,4})/);
      const fpsM = (probe.stderr || '').match(/(\d+(?:\.\d+)?) fps/);
      if (dim) { vidW = parseInt(dim[1]); vidH = parseInt(dim[2]); }
      if (fpsM) fps = Math.min(parseFloat(fpsM[1]), 24);
      console.log('Video:', vidW, 'x', vidH, '@', fps, 'fps');
    } catch(e) {}
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
    let status = 'dubbing', attempts = 0;
    while (status === 'dubbing' && attempts < 30) {
      await new Promise(function(r) { setTimeout(r, 10000); });
      attempts++;
      const checkRes = await axios.get('https://api.elevenlabs.io/v1/dubbing/' + dubbingId, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
      status = checkRes.data.status;
      console.log('ElevenLabs check ' + attempts + ': ' + status);
    }
    if (status !== 'dubbed') throw new Error('Dubbing failed: ' + status);
    console.log('Dubbing complete!');
    const audioRes = await axios.get('https://api.elevenlabs.io/v1/dubbing/' + dubbingId + '/audio/es', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, responseType: 'arraybuffer' });
    fs.writeFileSync(audioPath, audioRes.data);
    let cues = [];
    if (captionStyle && captionStyle.addCaptions) {
      try {
        const srtRes = await axios.get('https://api.elevenlabs.io/v1/dubbing/' + dubbingId + '/transcript/es?format_type=srt', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
        if (srtRes.data && srtRes.data.length > 10) {
          cues = parseSrtToCues(srtRes.data);
          console.log('Got ' + cues.length + ' word cues');
        }
      } catch(e) { console.log('SRT failed:', e.message); }
    }
    await axios.delete('https://api.elevenlabs.io/v1/dubbing/' + dubbingId, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }).catch(function() {});
    let videoForMerge = videoPath;
    if (captionBox) {
      console.log('Blurring caption region...');
      const x = captionBox.x, y = captionBox.y, w = captionBox.w, h = captionBox.h;
      const blurFilter = '[0:v]split[original][forblur];[forblur]crop=iw*' + w.toFixed(4) + ':ih*' + h.toFixed(4) + ':iw*' + x.toFixed(4) + ':ih*' + y.toFixed(4) + ',gblur=sigma=25[blurred];[original][blurred]overlay=W*' + x.toFixed(4) + ':H*' + y.toFixed(4) + '[v]';
      runFFmpeg(['-y', '-i', videoPath, '-filter_complex', blurFilter, '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-threads', '2', blurredPath]);
      videoForMerge = blurredPath;
      console.log('Blur done!');
    }
    if (cues.length > 0) {
      console.log('Extracting frames...');
      fs.mkdirSync(framesDir, { recursive: true });
      runFFmpeg(['-y', '-i', videoForMerge, '-vf', 'fps=' + fps, '-q:v', '2', path.join(framesDir, 'frame%06d.jpg')], 300000);
      console.log('Burning captions...');
      await burnCaptionsOnFrames(framesDir, cues, vidW, vidH, fps, captionStyle);
      console.log('Reassembling...');
      runFFmpeg(['-y', '-framerate', String(fps), '-i', path.join(framesDir, 'frame%06d.jpg'), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-threads', '1', captionedPath], 300000);
      try { fs.readdirSync(framesDir).forEach(function(f) { fs.unlinkSync(path.join(framesDir, f)); }); fs.rmdirSync(framesDir); } catch(e) {}
      videoForMerge = captionedPath;
      console.log('Captions burned!');
    }
    console.log('Final merge...');
    runFFmpeg(['-y', '-i', videoForMerge, '-i', audioPath, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', outputPath]);
    console.log('Done!');
    allFiles.forEach(function(f) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });
    setTimeout(function() { try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch(e) {} }, 600000);
    res.json({ success: true, videoUrl: '/outputs/final_' + timestamp + '.mp4' });
  } catch(err) {
    console.error('Error:', err.message);
    if (err.response) console.error('API error:', JSON.stringify(err.response.data));
    allFiles.concat([outputPath]).forEach(function(f) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });
    try { if (fs.existsSync(framesDir)) { fs.readdirSync(framesDir).forEach(function(f) { fs.unlinkSync(path.join(framesDir, f)); }); fs.rmdirSync(framesDir); } } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});
app.listen(PORT, function() { console.log('DubShorts running at http://localhost:' + PORT); });
