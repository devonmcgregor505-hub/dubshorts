require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const cors = require('cors');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

// Try system ffmpeg first (has libass), fall back to ffmpeg-static
let FFMPEG_PATH = ffmpegStatic;
try {
  const syspath = execSync('which ffmpeg 2>/dev/null || echo ""').toString().trim();
  if (syspath) {
    FFMPEG_PATH = syspath;
    console.log('Using system ffmpeg:', FFMPEG_PATH);
  } else {
    console.log('Using ffmpeg-static:', FFMPEG_PATH);
  }
} catch(e) {
  console.log('Using ffmpeg-static:', FFMPEG_PATH);
}

// Check if libass is available
let HAS_LIBASS = false;
try {
  const result = spawnSync(FFMPEG_PATH, ['-filters'], { encoding: 'utf8' });
  HAS_LIBASS = result.stdout.includes('ass') || result.stderr.includes('ass');
  console.log('libass available:', HAS_LIBASS);
} catch(e) {
  console.log('Could not check libass');
}

const express2 = require('express');
const app = express2();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express2.json());
const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

function srtTimeToSeconds(t) {
  const [h,m,rest] = t.split(':');
  const [s,ms] = rest.split(',');
  return parseInt(h)*3600 + parseInt(m)*60 + parseInt(s) + parseInt(ms)/1000;
}
function toAssTime(seconds) {
  const h = Math.floor(seconds/3600);
  const m = Math.floor((seconds%3600)/60);
  const s = Math.floor(seconds%60);
  const cs = Math.floor((seconds%1)*100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}
function srtToWordAss(srtContent) {
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 0\nPlayResY: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,55,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,3,0,2,10,10,80,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const blocks = srtContent.trim().split(/\n\n+/);
  let events = '';
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;
    const timeLine = lines[1];
    const textLine = lines.slice(2).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!timeLine.includes('-->') || !textLine) continue;
    const [startStr, endStr] = timeLine.split('-->').map(t => t.trim());
    const startSec = srtTimeToSeconds(startStr);
    const endSec = srtTimeToSeconds(endStr);
    const words = textLine.split(/\s+/).filter(w => w.length > 0);
    if (!words.length) continue;
    const dur = (endSec - startSec) / words.length;
    for (let i = 0; i < words.length; i++) {
      events += `Dialogue: 0,${toAssTime(startSec + i*dur)},${toAssTime(startSec + (i+1)*dur)},Default,,0,0,0,,${words[i]}\n`;
    }
  }
  return header + events;
}

function runFFmpeg(args, timeout = 180000) {
  const result = spawnSync(FFMPEG_PATH, args, { timeout, maxBuffer: 100 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error('FFmpeg failed: ' + (result.stderr || '').toString().slice(-500));
  }
  return result;
}

app.post('/translate', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  const audioPath = path.resolve('uploads/spanish_' + timestamp + '.mp3');
  const blurredPath = path.resolve('uploads/blurred_' + timestamp + '.mp4');
  const subtitledPath = path.resolve('uploads/subtitled_' + timestamp + '.mp4');
  const outputPath = path.resolve('uploads/final_' + timestamp + '.mp4');
  const assPath = '/tmp/subs_' + timestamp + '.ass';
  const allFiles = [videoPath, audioPath, blurredPath, subtitledPath, assPath];
  console.log('File received:', req.file.originalname);
  let captionBox = null;
  if (req.body.captionBox) { try { captionBox = JSON.parse(req.body.captionBox); } catch(e) {} }
  try {
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
    let hasAss = false;
    try {
      const srtRes = await axios.get('https://api.elevenlabs.io/v1/dubbing/' + dubbingId + '/transcript/es?format_type=srt', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
      if (srtRes.data && srtRes.data.length > 10) {
        fs.writeFileSync(assPath, srtToWordAss(srtRes.data));
        hasAss = HAS_LIBASS;
        console.log('ASS written, will burn:', hasAss); console.log('ASS SAMPLE:', fs.readFileSync(assPath, 'utf8').slice(0, 400));
      }
    } catch(e) { console.log('SRT failed:', e.message); }
    await axios.delete('https://api.elevenlabs.io/v1/dubbing/' + dubbingId, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }).catch(() => {});

    let videoForMerge = videoPath;

    if (captionBox) {
      console.log('Blurring...');
      const { x, y, w, h } = captionBox;
      const blurFilter = `[0:v]split[original][forblur];[forblur]crop=iw*${w.toFixed(4)}:ih*${h.toFixed(4)}:iw*${x.toFixed(4)}:ih*${y.toFixed(4)},gblur=sigma=25[blurred];[original][blurred]overlay=W*${x.toFixed(4)}:H*${y.toFixed(4)}[v]`;
      runFFmpeg(['-y', '-i', videoPath, '-filter_complex', blurFilter, '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-threads', '2', blurredPath]);
      videoForMerge = blurredPath;
      console.log('Blur done!');
    }

    if (hasAss) {
      console.log('Burning subtitles...');
      runFFmpeg(['-y', '-i', videoForMerge, '-vf', `ass=${assPath}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-threads', '2', subtitledPath]);
      videoForMerge = subtitledPath;
      console.log('Subtitles burned!');
    }

    console.log('Step 2: Final merge...');
    runFFmpeg(['-y', '-i', videoForMerge, '-i', audioPath, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', outputPath]);

    console.log('Done!');
    allFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });
    const token = Date.now().toString();
    app.get('/download/' + token, (req, res) => { res.download(outputPath, 'spanish_dubbed.mp4', () => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); }); });
    res.json({ success: true, downloadUrl: '/download/' + token });
  } catch (err) {
    console.error('Error:', err.message);
    if (err.response) console.error('API error:', JSON.stringify(err.response.data));
    allFiles.concat([outputPath]).forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });
    res.status(500).json({ success: false, error: err.message });
  }
});
app.listen(PORT, () => { console.log('DubShorts running at http://localhost:' + PORT); });
