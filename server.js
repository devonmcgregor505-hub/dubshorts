require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const cors = require('cors');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegStatic);
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
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,55,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,3,0,2,10,10,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const blocks = srtContent.trim().split(/\n\n+/);
  let events = '';
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;
    const timeLine = lines[1];
    const textLine = lines.slice(2).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!timeLine.includes('-->')) continue;
    const [startStr, endStr] = timeLine.split('-->').map(t => t.trim());
    const startSec = srtTimeToSeconds(startStr);
    const endSec = srtTimeToSeconds(endStr);
    const words = textLine.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) continue;
    const wordDuration = (endSec - startSec) / words.length;
    for (let i = 0; i < words.length; i++) {
      const wStart = startSec + i * wordDuration;
      const wEnd = startSec + (i + 1) * wordDuration;
      events += `Dialogue: 0,${toAssTime(wStart)},${toAssTime(wEnd)},Default,,0,0,0,,${words[i]}\n`;
    }
  }
  return header + events;
}

app.post('/translate', upload.single('video'), async (req, res) => {
  const videoPath = req.file.path;
  const timestamp = Date.now();
  const audioPath = 'uploads/spanish_' + timestamp + '.mp3';
  const srtPath = 'uploads/spanish_' + timestamp + '.srt';
  const assPath = 'uploads/spanish_' + timestamp + '.ass';
  const blurredPath = 'uploads/blurred_' + timestamp + '.mp4';
  const outputPath = 'uploads/final_' + timestamp + '.mp4';
  const allFiles = [videoPath, audioPath, srtPath, assPath, blurredPath];
  console.log('File received:', req.file.originalname);
  let captionBox = null;
  if (req.body.captionBox) {
    try { captionBox = JSON.parse(req.body.captionBox); } catch(e) {}
  }
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
    let status = 'dubbing';
    let attempts = 0;
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
    console.log('Fetching Spanish SRT...');
    let hasAss = false;
    try {
      const srtRes = await axios.get('https://api.elevenlabs.io/v1/dubbing/' + dubbingId + '/transcript/es?format_type=srt', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
      if (srtRes.data && srtRes.data.length > 10) {
        fs.writeFileSync(srtPath, srtRes.data);
        const assContent = srtToWordAss(srtRes.data);
        fs.writeFileSync(assPath, assContent);
        hasAss = true;
        console.log('ASS subtitle file created!'); console.log('ASS content preview:', assContent.substring(0, 300));
      }
    } catch(e) { console.log('SRT fetch failed:', e.message); }
    await axios.delete('https://api.elevenlabs.io/v1/dubbing/' + dubbingId, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }).catch(() => {});
    if (captionBox) {
      console.log('Blurring caption region...');
      const { x, y, w, h } = captionBox;
      const blurFilter = `[0:v]split[original][forblur];[forblur]crop=iw*${w.toFixed(4)}:ih*${h.toFixed(4)}:iw*${x.toFixed(4)}:ih*${y.toFixed(4)},gblur=sigma=25[blurred];[original][blurred]overlay=W*${x.toFixed(4)}:H*${y.toFixed(4)}[v]`;
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath).outputOptions(['-filter_complex', blurFilter, '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-threads', '2']).output(blurredPath).on('end', resolve).on('error', reject).run();
      });
      console.log('Blur done!');
    }
    const sourceVideo = captionBox ? blurredPath : videoPath;
    console.log('Step 2: Merging + burning subtitles...');
    await new Promise((resolve, reject) => {
      let cmd = ffmpeg(sourceVideo).input(audioPath);
      const outputOpts = [];
      if (hasAss) {
        const tmpAss = "/tmp/subs_" + timestamp + ".ass"; fs.copyFileSync(assPath, tmpAss); const escapedAss = tmpAss;
        outputOpts.push('-vf', `ass=${escapedAss}`);
        outputOpts.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28');
      } else {
        outputOpts.push('-c:v', 'copy');
      }
      outputOpts.push('-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-shortest', '-threads', '2');
      cmd.outputOptions(outputOpts).output(outputPath).on('end', resolve).on('error', (err) => { console.error('FFmpeg error:', err.message); reject(err); }).run();
    });
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
