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

let FFMPEG_PATH = ffmpegStatic;
console.log('Using ffmpeg:', FFMPEG_PATH);

function runFFmpeg(args, timeout = 180000) {
  const result = spawnSync(FFMPEG_PATH, args, { timeout, maxBuffer: 100 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('FFmpeg failed: ' + (result.stderr || '').toString().slice(-300));
}

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
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
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 0',
    'PlayResY: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,3,0,2,10,10,50,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const blocks = srtContent.trim().split(/\n\n+/);
  for (const block of blocks) {
    const blines = block.trim().split('\n');
    if (blines.length < 3) continue;
    const timeLine = blines[1];
    const textLine = blines.slice(2).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!timeLine.includes('-->') || !textLine) continue;
    const [startStr, endStr] = timeLine.split('-->').map(t => t.trim());
    const startSec = srtTimeToSeconds(startStr);
    const endSec = srtTimeToSeconds(endStr);
    const words = textLine.split(/\s+/).filter(w => w.length > 0);
    if (!words.length) continue;
    const dur = (endSec - startSec) / words.length;
    for (let i = 0; i < words.length; i++) {
      const ws = toAssTime(startSec + i * dur);
      const we = toAssTime(startSec + (i + 1) * dur);
      lines.push(`Dialogue: 0,${ws},${we},Default,,0,0,0,,${words[i]}`);
    }
  }
  return lines.join('\n');
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
        const assContent = srtToWordAss(srtRes.data);
        fs.writeFileSync(assPath, assContent);
        hasAss = true;
        // Log last 3 dialogue lines so we can verify timing
        const dialogueLines = assContent.split('\n').filter(l => l.startsWith('Dialogue')).slice(-3);
        console.log('ASS sample lines:', dialogueLines.join(' | '));
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
    console.log('Final merge...');
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
