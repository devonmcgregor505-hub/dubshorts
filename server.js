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

const fontPath = path.join(__dirname, 'DejaVuSans-Bold.ttf');
if (fs.existsSync(fontPath)) {
  registerFont(fontPath, { family: 'CaptionFont', weight: 'bold' });
  console.log('Font registered:', fontPath);
} else {
  console.log('WARNING: Font not found at', fontPath);
}

let FFMPEG_PATH = ffmpegStatic;
try {
  const r = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  if (r.stdout && r.stdout.trim()) { FFMPEG_PATH = r.stdout.trim(); console.log('Using system ffmpeg:', FFMPEG_PATH); }
  else { console.log('Using ffmpeg-static:', FFMPEG_PATH); }
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
const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('outputs')) fs.mkdirSync('outputs');
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

function srtTimeToSeconds(t) {
  const [h,m,rest] = t.split(':');
  const [s,ms] = rest.split(',');
  return parseInt(h)*3600+parseInt(m)*60+parseInt(s)+parseInt(ms)/1000;
}

function parseSrtToCues(srtContent) {
  const cues = [];
  for (const block of srtContent.trim().split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;
    const timeLine = lines[1];
    if (!timeLine.includes('-->')) continue;
    const [startStr, endStr] = timeLine.split('-->').map(t => t.trim());
    const startSec = srtTimeToSeconds(startStr);
    const endSec = srtTimeToSeconds(endStr);
    const text = lines.slice(2).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!text) continue;
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const dur = (endSec - startSec) / words.length;
    for (let i = 0; i < words.length; i++) {
      cues.push({ start: startSec + i*dur, end: startSec + (i+1)*dur, text: words[i] });
    }
  }
  return cues;
}

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
  const bgStyle = style.bgStyle || 'none';

  const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
  console.log(`Burning captions: ${frames.length} frames, ${fontSize}px, y=${Math.round(yPct*100)}%`);

  for (let i = 0; i < frames.length; i++) {
    const t = i / fps;
    const cue = cues.find(c => t >= c.start && t < c.end);
    if (!cue) continue;
    const framePath = path.join(framesDir, frames[i]);
    const img = await loadImage(framePath);
    const canvas = createCanvas(vidW, vidH);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, vidW, vidH);

    let txt = cue.text;
    if (textCase === 'upper') txt = txt.toUpperCase();
    else if (textCase === 'lower') txt = txt.toLowerCase();

    const x = vidW / 2;
    const y = yPct * vidH;

    ctx.font = `${textStyle} ${fontSize}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (bgStyle !== 'none') {
      const m = ctx.measureText(txt); const p = fontSize * 0.25;
      ctx.fillStyle = bgStyle==='dark'?'rgba(0,0,0,0.65)':bgStyle==='light'?'rgba(255,255,255,0.25)':'rgba(245,225,50,0.8)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x-m.width/2-p, y-fontSize/2-p/2, m.width+p*2, fontSize+p, 4);
      else ctx.rect(x-m.width/2-p, y-fontSize/2-p/2, m.width+p*2, fontSize+p);
      ctx.fill();
    }
    if (outlineWidthPct > 0) {
      ctx.lineWidth = fontSize * outlineWidthPct;
      ctx.strokeStyle = outlineColor;
      ctx.lineJoin = 'round';
      ctx.strokeText(txt, x, y);
    }
    ctx.fillStyle = textColor;
    ctx.fillText(txt, x, y);
    fs.writeFileSync(framePath, canvas.toBuffer('image/jpeg', { quality: 0.92 }));
    if (i % 30 === 0) console.log(`Captioned ${i}/${frames.length}`);
  }
  console.log('All frames captioned!');
}

app.post('/translate', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  const audioPath = path.resolve('uploads/spanish_'+timestamp+'.mp3');
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

  try {
    let vidW=1080, vidH=1920, fps=30;
    try {
      const probe = spawnSync(FFMPEG_PATH, ['-i', videoPath], { encoding: 'utf8' });
      const dim = (probe.stderr||'').match(/(\d{3,4})x(\d{3,4})/);
      const fpsM = (probe.stderr||'').match(/(\d+(?:\.\d+)?) fps/);
      if (dim) { vidW=parseInt(dim[1]); vidH=parseInt(dim[2]); }
      if (fpsM) fps=Math.min(parseFloat(fpsM[1]), 24);
      console.log('Video:', vidW, 'x', vidH, '@', fps, 'fps');
    } catch(e) {}

    console.log('Step 1: Sending to ElevenLabs...');
    const form = new FormData();
    form.append('file', fs.createReadStream(videoPath), { filename: req.file.originalname, contentType: 'video/mp4' });
    form.append('source_lang','en'); form.append('target_lang','es');
    form.append('num_speakers','0'); form.append('watermark','false');
    const startRes = await axios.post('https://api.elevenlabs.io/v1/dubbing', form, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, ...form.getHeaders() }, timeout: 600000 });
    const dubbingId = startRes.data.dubbing_id;
    console.log('Dubbing started:', dubbingId);
    let status='dubbing', attempts=0;
    while (status==='dubbing' && attempts<30) {
      await new Promise(r=>setTimeout(r,10000)); attempts++;
      const checkRes = await axios.get('https://api.elevenlabs.io/v1/dubbing/'+dubbingId, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
      status=checkRes.data.status;
      console.log('ElevenLabs check '+attempts+': '+status);
    }
    if (status!=='dubbed') throw new Error('Dubbing failed: '+status);
    console.log('Dubbing complete!');

    const audioRes = await axios.get('https://api.elevenlabs.io/v1/dubbing/'+dubbingId+'/audio/es', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, responseType: 'arraybuffer' });
    fs.writeFileSync(audioPath, audioRes.data);

    let cues = [];
    if (captionStyle && captionStyle.enabled) {
      try {
        const srtRes = await axios.get('https://api.elevenlabs.io/v1/dubbing/'+dubbingId+'/transcript/es?format_type=srt', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
        if (srtRes.data && srtRes.data.length>10) {
          cues = parseSrtToCues(srtRes.data);
          console.log('Got', cues.length, 'word cues');
        }
      } catch(e) { console.log('SRT failed:', e.message); }
    }

    await axios.delete('https://api.elevenlabs.io/v1/dubbing/'+dubbingId, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }).catch(()=>{});

    let videoForMerge = videoPath;

    if (captionBox) {
      console.log('Blurring...');
      const {x,y,w,h} = captionBox;
      const blurFilter = `[0:v]split[original][forblur];[forblur]crop=iw*${w.toFixed(4)}:ih*${h.toFixed(4)}:iw*${x.toFixed(4)}:ih*${y.toFixed(4)},gblur=sigma=25[blurred];[original][blurred]overlay=W*${x.toFixed(4)}:H*${y.toFixed(4)}[v]`;
      runFFmpeg(['-y','-i',videoPath,'-filter_complex',blurFilter,'-map','[v]','-map','0:a?','-c:v','libx264','-preset','ultrafast','-crf','28','-threads','2',blurredPath]);
      videoForMerge = blurredPath;
      console.log('Blur done!');
    }

    if (cues.length > 0) {
      console.log('Extracting frames...');
      fs.mkdirSync(framesDir, { recursive: true });
      runFFmpeg(['-y','-i',videoForMerge,'-vf',`fps=${fps}`,'-q:v','2',path.join(framesDir,'frame%06d.jpg')], 300000);
      console.log('Burning captions...');
      await burnCaptionsOnFrames(framesDir, cues, vidW, vidH, fps, captionStyle);
      console.log('Reassembling...');
      runFFmpeg(['-y','-framerate',String(fps),'-i',path.join(framesDir,'frame%06d.jpg'),'-c:v','libx264','-preset','ultrafast','-crf','28','-pix_fmt','yuv420p','-threads','1',captionedPath], 300000);
      try { fs.readdirSync(framesDir).forEach(f=>fs.unlinkSync(path.join(framesDir,f))); fs.rmdirSync(framesDir); } catch(e){}
      videoForMerge = captionedPath;
      console.log('Captions burned!');
    }

    console.log('Final merge...');
    runFFmpeg(['-y','-i',videoForMerge,'-i',audioPath,'-map','0:v','-map','1:a','-c:v','copy','-c:a','aac','-shortest',outputPath]);
    console.log('Done!');
    allFiles.forEach(f=>{try{if(fs.existsSync(f))fs.unlinkSync(f);}catch(e){}});
    setTimeout(()=>{try{if(fs.existsSync(outputPath))fs.unlinkSync(outputPath);}catch(e){}}, 600000);
    res.json({ success: true, videoUrl: '/outputs/final_'+timestamp+'.mp4' });
  } catch(err) {
    console.error('Error:', err.message);
    if (err.response) console.error('API error:', JSON.stringify(err.response.data));
    allFiles.concat([outputPath]).forEach(f=>{try{if(fs.existsSync(f))fs.unlinkSync(f);}catch(e){}});
    try { if(fs.existsSync(framesDir)){fs.readdirSync(framesDir).forEach(f=>fs.unlinkSync(path.join(framesDir,f)));fs.rmdirSync(framesDir);} } catch(e){}
    res.status(500).json({ success: false, error: err.message });
  }
});
app.listen(PORT, ()=>{ console.log('DubShorts running at http://localhost:'+PORT); });
