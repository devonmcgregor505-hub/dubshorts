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
const upload = multer({ dest: 'uploads/', limits: { fileSize: 200 * 1024 * 1024 } });
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

  const removeCaption = req.body.removeCaption === 'true';
  let captionStyle = null;
  if (req.body.captionStyle) { try { captionStyle = JSON.parse(req.body.captionStyle); } catch(e) {} }

  try {
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
        if (durSecs > 120) return res.status(400).json({ success: false, error: 'Video must be under 2 minutes' });
      }
      console.log('Video:', vidW, 'x', vidH, '@', fps, 'fps');
    } catch(e) {}

    // Run WaveSpeed caption removal on original video FIRST
    let cleanVideoPath = videoPath;
    if (removeCaption) {
      console.log('WaveSpeed AI caption removal on original video...');
      // Upload original video to WaveSpeed
      const wsUploadForm = new FormData();
      wsUploadForm.append('file', fs.createReadStream(videoPath), { filename: req.file.originalname, contentType: 'video/mp4' });
      const wsUploadRes = await axios.post('https://api.wavespeed.ai/api/v3/media/upload/binary', wsUploadForm, {
        headers: { ...wsUploadForm.getHeaders(), 'Authorization': `Bearer ${process.env.WAVESPEED_API_KEY}` },
        timeout: 120000
      });
      const wsVideoUrl = wsUploadRes.data.data.download_url;
      console.log('WaveSpeed video URL:', wsVideoUrl);

      const wsJobRes = await axios.post('https://api.wavespeed.ai/api/v3/wavespeed-ai/video-watermark-remover', {
        video: wsVideoUrl
      }, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.WAVESPEED_API_KEY}` },
        timeout: 30000
      });
      const wsJobId = wsJobRes.data.data?.id || wsJobRes.data.id;
      console.log('WaveSpeed job ID:', wsJobId);

      let wsResult = null;
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise(r => setTimeout(r, 5000));
        const wsCheck = await axios.get(`https://api.wavespeed.ai/api/v3/predictions/${wsJobId}/result`, {
          headers: { 'Authorization': `Bearer ${process.env.WAVESPEED_API_KEY}` },
          timeout: 15000
        });
        const wsStatus = wsCheck.data.data?.status || wsCheck.data.status;
        const wsOutputs = wsCheck.data.data?.outputs || wsCheck.data.outputs;
        console.log(`WaveSpeed poll ${attempt + 1}: ${wsStatus}`);
        if ((wsStatus === 'completed' || wsStatus === 'succeeded') && wsOutputs && wsOutputs[0]) {
          wsResult = wsOutputs[0];
          break;
        } else if (wsStatus === 'failed') {
          throw new Error('WaveSpeed failed: ' + JSON.stringify(wsCheck.data));
        }
      }
      if (!wsResult) throw new Error('WaveSpeed timed out');
      console.log('WaveSpeed done! Downloading clean video...');
      const wsVideoRes = await axios.get(wsResult, { responseType: 'arraybuffer', timeout: 120000 });
      cleanVideoPath = path.resolve('uploads/clean_'+timestamp+'.mp4');
      fs.writeFileSync(cleanVideoPath, wsVideoRes.data);
      console.log('Clean video ready for dubbing');
    }

    console.log('Step 1: Uploading to temp storage...');
    const uploadForm = new FormData();
    uploadForm.append('file', fs.createReadStream(cleanVideoPath), { filename: req.file.originalname, contentType: req.file.mimetype });
    const tmpRes = await axios.post('https://tmpfiles.org/api/v1/upload', uploadForm, { headers: uploadForm.getHeaders() });
    const videoUrl = tmpRes.data.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
    console.log('Video URL:', videoUrl);

    console.log('Step 2: Sending to ModelsLab dubbing...');
    const dubRes = await axios.post('https://modelslab.com/api/v6/voice/create_dubbing', {
      key: process.env.MODELSLAB_API_KEY,
      init_video: videoUrl,
      source_lang: 'en',
      output_lang: 'es',
      speed: 1.0,
      file_prefix: 'dub_es_'+Date.now()+'_'+Math.random().toString(36).slice(2),
      base64: false,
      webhook: null,
      track_id: null
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });

    console.log('ModelsLab FULL response:', JSON.stringify(dubRes.data).slice(0, 500));

    let dubbedVideoUrl = null;
    if (dubRes.data.status === 'success' && dubRes.data.output && dubRes.data.output[0]) {
      dubbedVideoUrl = dubRes.data.output[0];
      console.log('Dubbing complete immediately!');
    } else if (dubRes.data.status === 'processing' && dubRes.data.fetch_result) {
      console.log('Processing, polling for result...');
      let attempts = 0;
      while (attempts < 60) {
        await new Promise(r => setTimeout(r, 5000));
        attempts++;
        const pollRes = await axios.post(dubRes.data.fetch_result, { key: process.env.MODELSLAB_API_KEY }, { headers: { 'Content-Type': 'application/json' } });
        console.log('Poll '+attempts+': '+pollRes.data.status);
        if (pollRes.data.status === 'success' && pollRes.data.output && pollRes.data.output[0]) {
          dubbedVideoUrl = pollRes.data.output[0];
          console.log('Dubbing complete!');
          break;
        }
      }
    }

    if (!dubbedVideoUrl) throw new Error('ModelsLab dubbing failed or timed out');

    console.log('Downloading dubbed video...');
    const dubbedRes = await axios.get(dubbedVideoUrl, { responseType: 'arraybuffer', timeout: 120000 });
    fs.writeFileSync(audioPath, dubbedRes.data); // reuse audioPath as temp dubbed video

    let cues = [];
    if (captionStyle && captionStyle.enabled) {
      try {
        console.log('Transcribing dubbed video for captions...');
        // Extract audio from dubbed video to mp3 for STT
        const dubbedAudioPath = path.resolve('uploads/dubbed_audio_'+timestamp+'.mp3');
        runFFmpeg(['-y','-i',audioPath,'-vn','-ar','44100','-ac','2','-b:a','128k',dubbedAudioPath], 60000);
        // Upload audio to tmpfiles for STT
        const sttForm = new FormData();
        sttForm.append('file', fs.createReadStream(dubbedAudioPath), { filename: 'dubbed.mp3', contentType: 'audio/mp3' });
        const sttTmpRes = await axios.post('https://tmpfiles.org/api/v1/upload', sttForm, { headers: sttForm.getHeaders() });
        const sttAudioUrl = sttTmpRes.data.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
        console.log('STT audio URL:', sttAudioUrl);
        try { fs.unlinkSync(dubbedAudioPath); } catch(e) {}
        const sttRes = await axios.post('https://modelslab.com/api/v6/voice/speech_to_text', {
          key: process.env.MODELSLAB_API_KEY,
          init_audio: sttAudioUrl,
          language: 'es'
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 60000 });

        console.log('STT response:', JSON.stringify(sttRes.data).slice(0, 300));

        let transcript = null;
        if (sttRes.data.status === 'success' && sttRes.data.text) {
          transcript = sttRes.data.text;
        } else if (sttRes.data.status === 'processing' && sttRes.data.fetch_result) {
          let sttAttempts = 0;
          while (sttAttempts < 20) {
            await new Promise(r => setTimeout(r, 3000));
            sttAttempts++;
            const sttPoll = await axios.post(sttRes.data.fetch_result, { key: process.env.MODELSLAB_API_KEY }, { headers: { 'Content-Type': 'application/json' } });
            console.log('STT poll '+sttAttempts+':', JSON.stringify(sttPoll.data).slice(0,200));
            if (sttPoll.data.status === 'success' && (sttPoll.data.text || sttPoll.data.output)) {
              transcript = sttPoll.data.text || sttPoll.data.output;
              break;
            }
          }
        }

        if (transcript) {
          console.log('Got transcript:', transcript.slice(0, 100));
          // Build simple timed cues from transcript words
          // Get video duration from ffprobe
          const probeResult = spawnSync(FFMPEG_PATH, ['-i', audioPath, '-f', 'null', '-'], { encoding: 'utf8' });
          const durMatch = (probeResult.stderr || '').match(/Duration: (\d+):(\d+):(\d+\.?\d*)/);
          const totalDur = durMatch ? parseInt(durMatch[1])*3600 + parseInt(durMatch[2])*60 + parseFloat(durMatch[3]) : 30;
          const words = transcript.trim().split(/\s+/).filter(w => w.length > 0);
          const wordDur = totalDur / words.length;
          words.forEach((word, i) => {
            cues.push({ start: i * wordDur, end: (i + 1) * wordDur, text: word });
          });
          console.log('Built', cues.length, 'cues from transcript');
        }
      } catch(e) { console.log('Transcription failed:', e.message); }
    }

    let videoForMerge = audioPath; // audioPath now holds the complete dubbed video from ModelsLab



    if (cues.length > 0) {
      console.log('Extracting frames...');
      fs.mkdirSync(framesDir, { recursive: true });
      const captionFps = Math.min(fps, 15);
      const scaleFilter = `fps=${captionFps},scale=-2:1080`;
      runFFmpeg(['-y','-i',videoForMerge,'-vf',scaleFilter,'-q:v','3','-threads','2',path.join(framesDir,'frame%06d.jpg')], 300000);
      const burnW = Math.round(vidW * 1080/vidH);
      const burnH = 1080;
      console.log('Burning captions...');
      await burnCaptionsOnFrames(framesDir, cues, vidW, vidH, fps, captionStyle);
      console.log('Reassembling...');
      runFFmpeg(['-y','-framerate',String(captionFps),'-i',path.join(framesDir,'frame%06d.jpg'),'-c:v','libx264','-preset','ultrafast','-crf','28','-pix_fmt','yuv420p','-threads','1',captionedPath], 300000);
      try { fs.readdirSync(framesDir).forEach(f=>fs.unlinkSync(path.join(framesDir,f))); fs.rmdirSync(framesDir); } catch(e){}
      videoForMerge = captionedPath;
      console.log('Captions burned!');
    }

    console.log('Final merge...');
    // ModelsLab returns complete dubbed video - just copy it to output
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
