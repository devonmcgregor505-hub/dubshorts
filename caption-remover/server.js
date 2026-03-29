require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { spawnSync } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

let FFMPEG_PATH = ffmpegStatic;
try {
  const r = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  if (r.stdout && r.stdout.trim()) FFMPEG_PATH = r.stdout.trim();
} catch(e) {}

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use('/outputs', express.static('outputs'));

const upload = multer({ dest: 'uploads/', limits: { fileSize: 500 * 1024 * 1024 } });
['uploads','outputs'].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d); });

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID;

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/remove-captions', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const ts = Date.now();
  const outputPath = path.resolve(`outputs/clean_${ts}.mp4`);
  const captionBox = req.body.captionBox ? JSON.parse(req.body.captionBox) : null;

  if (!captionBox) {
    try { fs.unlinkSync(videoPath); } catch(e) {}
    return res.status(400).json({ success: false, error: 'No box provided — please draw a box over the captions first' });
  }

  try {
    // Get video dimensions
    const probe = spawnSync(FFMPEG_PATH, ['-i', videoPath], { encoding: 'utf8' });
    const dimMatch = (probe.stderr || '').match(/(\d{3,5})x(\d{3,5})/);
    const W = dimMatch ? parseInt(dimMatch[1]) : 1080;
    const H = dimMatch ? parseInt(dimMatch[2]) : 1920;

    // Get video frame count and fps
    const fpsMatch = (probe.stderr || '').match(/(\d+(?:\.\d+)?) fps/);
    const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 30;

    // Generate mask video — black with white box where captions are
    const maskPath = path.resolve(`uploads/mask_${ts}.mp4`);
    const bx = Math.max(0, Math.round(captionBox.x * W));
    const by = Math.max(0, Math.round(captionBox.y * H));
    const bw = Math.max(1, Math.min(Math.round(captionBox.w * W), W - bx));
    const bh = Math.max(1, Math.min(Math.round(captionBox.h * H), H - by));

    const maskResult = spawnSync(FFMPEG_PATH, [
      '-y', '-i', videoPath,
      '-vf', `drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=white@1.0:t=fill,hue=s=0,curves=all='0/0 1/0':red='0/0 1/0':green='0/0 1/0':blue='0/0 1/0'`,
      '-map', '0:v',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-an', maskPath
    ], { timeout: 120000, maxBuffer: 100*1024*1024 });

    if (maskResult.status !== 0) {
      // fallback simpler approach
      const maskResult2 = spawnSync(FFMPEG_PATH, [
        '-y', '-i', videoPath,
        '-vf', `drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=white:t=fill,format=gray,negate,negate`,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-an', maskPath
      ], { timeout: 120000, maxBuffer: 100*1024*1024 });
    }

    console.log('Sending to RunPod... box:', JSON.stringify({x:bx,y:by,w:bw,h:bh}), 'dims:', W, H);
    const videoBuffer = fs.readFileSync(videoPath);
    const videoBase64 = videoBuffer.toString('base64');
    const maskBuffer = fs.readFileSync(maskPath);
    const maskBase64 = maskBuffer.toString('base64');

    const submitRes = await axios.post(
      `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/run`,
      {
        input: {
          video_base64: videoBase64,
          mask_base64: maskBase64,
          fps: fps,
          box: { x: bx, y: by, w: bw, h: bh }
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${RUNPOD_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      }
    );

    const jobId = submitRes.data.id;
    console.log('RunPod job submitted:', jobId);
    try { fs.unlinkSync(maskPath); } catch(e) {}

    let result = null;
    for (let i = 0; i < 360; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await axios.get(
        `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/status/${jobId}`,
        { headers: { 'Authorization': `Bearer ${RUNPOD_API_KEY}` }, timeout: 15000 }
      );
      const { status, output, error } = statusRes.data;
      console.log(`Poll ${i+1}: ${status}`);
      if (status === 'COMPLETED') { result = output; break; }
      if (status === 'FAILED') throw new Error('RunPod job failed: ' + (error || 'unknown error'));
    }

    if (!result) throw new Error('RunPod job timed out');
    if (result.error) throw new Error('RunPod error: ' + result.error);

    const resultBuffer = Buffer.from(result.video_base64, 'base64');
    fs.writeFileSync(outputPath, resultBuffer);
    try { fs.unlinkSync(videoPath); } catch(e) {}
    setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e) {} }, 3600000);
    console.log('Done! Output size:', fs.statSync(outputPath).size, 'bytes');
    res.json({ success: true, videoUrl: `/outputs/clean_${ts}.mp4` });

  } catch(err) {
    console.error('Error:', err.message);
    try { fs.unlinkSync(videoPath); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fast mode
app.post('/remove-captions-fast', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const ts = Date.now();
  const outputPath = path.resolve(`outputs/fast_${ts}.mp4`);
  const box = req.body.captionBox ? JSON.parse(req.body.captionBox) : null;
  if (!box) return res.status(400).json({ success: false, error: 'No box provided' });
  try {
    const probe = spawnSync(FFMPEG_PATH, ['-i', videoPath], { encoding: 'utf8' });
    const dim = (probe.stderr || '').match(/(\d{3,5})x(\d{3,5})/);
    const W = dim ? parseInt(dim[1]) : 1080;
    const H = dim ? parseInt(dim[2]) : 1920;
    const bx = Math.round(box.x * W);
    const by = Math.round(box.y * H);
    const bw = Math.round(box.w * W);
    const bh = Math.round(box.h * H);
    const r = spawnSync(FFMPEG_PATH, [
      '-y', '-i', videoPath,
      '-vf', `delogo=x=${bx}:y=${by}:w=${bw}:h=${bh}:show=0`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
      '-c:a', 'aac', outputPath
    ], { timeout: 300000, maxBuffer: 100*1024*1024 });
    if (r.status !== 0) throw new Error((r.stderr||Buffer.from('')).toString().slice(-400));
    try { fs.unlinkSync(videoPath); } catch(e) {}
    setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e) {} }, 3600000);
    res.json({ success: true, videoUrl: `/outputs/fast_${ts}.mp4` });
  } catch(err) {
    try { fs.unlinkSync(videoPath); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Caption Remover running at http://localhost:${PORT}`));
