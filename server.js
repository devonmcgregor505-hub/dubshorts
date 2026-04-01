require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const cors = require('cors');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

// ── FFmpeg ──
let FFMPEG_PATH = ffmpegStatic;
try {
  const r = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  if (r.stdout && r.stdout.trim()) {
    FFMPEG_PATH = r.stdout.trim();
    console.log('Using system ffmpeg:', FFMPEG_PATH);
  }
} catch(e) {}

function runFFmpeg(args, timeout = 180000) {
  const result = spawnSync(FFMPEG_PATH, args, { timeout, maxBuffer: 100 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('FFmpeg failed: ' + (result.stderr || '').toString().slice(0, 200));
}

// ── App ──
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => { req.setTimeout(0); res.setTimeout(0); next(); });
app.use(cors());
app.use(express.static(__dirname));
app.use(express.json());
app.use('/outputs', express.static('outputs'));

const upload = multer({ dest: 'uploads/', limits: { fileSize: 500 * 1024 * 1024 } });

['uploads', 'outputs', 'cache'].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d); });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Job queue ──
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
  try { resolve(await job()); }
  catch(e) { reject(e); }
  finally { activeJobs--; processQueue(); }
}

app.get('/queue', (req, res) => {
  res.json({ active: activeJobs, waiting: queue.length, max: MAX_CONCURRENT });
});

// ══════════════════════════════════════════════════════════════════════════════
// AI VIDEO GEN  —  POST /generate-video
// Models: grok, sora2, veo3-fast, kling26, seedance
// Body params: model, prompt: prompt || "a beautiful cinematic scene", duration, aspectRatio, audio (1|0), mode
// ══════════════════════════════════════════════════════════════════════════════

const AUDIO_MODELS = new Set(['sora2', 'veo3-fast']);

app.post('/generate-video', upload.single('image'), async (req, res) => {
  const imagePath = req.file ? path.resolve(req.file.path) : null;
  const timestamp = Date.now();
  const { model = 'grok', prompt = '', duration = '6', aspectRatio = '9:16', audio = '1', mode = 'normal', quality = '720p' } = req.body;

  const KIE_API_KEY = process.env.KIE_API_KEY;
  if (!KIE_API_KEY) {
    if (imagePath) try { fs.unlinkSync(imagePath); } catch(e) {}
    return res.json({ success: false, error: 'KIE_API_KEY not configured in .env' });
  }

  const audioEnabled = AUDIO_MODELS.has(model) && audio === '1';

  try {
    const result = await enqueue(async () => {
      console.log(`[generate-video] model=${model} duration=${duration}s aspect=${aspectRatio} mode=${mode} audio=${audioEnabled} hasImage=${!!imagePath}`);

      let submitRes;

      if (model === 'grok') {
        // Grok uses /api/v1/jobs/createTask with nested input object
        const kieModel = imagePath ? 'grok-imagine/image-to-video' : 'grok-imagine/text-to-video';
        const body = {
          model: kieModel,
          input: {
            prompt: prompt || 'Cinematic motion',
            aspect_ratio: aspectRatio,
            mode: mode || 'normal',
            duration: String(duration),
            resolution: quality || '720p',
          },
        };
        if (imagePath && fs.existsSync(imagePath)) {
          body.input.image = fs.readFileSync(imagePath).toString('base64');
        }
        submitRes = await axios.post('https://api.kie.ai/api/v1/jobs/createTask', body, {
          headers: { 'Authorization': `Bearer ${KIE_API_KEY}`, 'Content-Type': 'application/json' },
          timeout: 60000,
        });

      } else {
        // All other models use /v1/video/generate with flat body
        const modelMap = { 'sora2': 'sora2', 'veo3-fast': 'veo3-fast', 'kling26': 'kling/v2.6', 'seedance': 'seedance' };
        const body = {
          model: modelMap[model] || model,
          prompt: prompt || 'Cinematic motion',
          duration: parseInt(duration),
          resolution: '720p',
          aspect_ratio: aspectRatio,
        };
        if (AUDIO_MODELS.has(model)) body.audio = audioEnabled;
        if (imagePath && fs.existsSync(imagePath)) {
          body.image = fs.readFileSync(imagePath).toString('base64');
          body.image_mime_type = req.file.mimetype || 'image/jpeg';
        }
        submitRes = await axios.post('https://api.kie.ai/v1/video/generate', body, {
          headers: { 'Authorization': `Bearer ${KIE_API_KEY}`, 'Content-Type': 'application/json' },
          timeout: 60000,
        });
      }

      // Task ID (differs by endpoint)
      const taskId = submitRes.data?.data?.taskId || submitRes.data?.data?.task_id || submitRes.data?.task_id;
      if (!taskId) throw new Error('No task_id in response: ' + JSON.stringify(submitRes.data));
      console.log(`[generate-video] taskId=${taskId}`);

      // Poll using the unified task detail endpoint
      let videoUrl = null;
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const pollRes = await axios.get(`https://api.kie.ai/api/v1/jobs/recordInfo`, {
          params: { taskId },
          headers: { 'Authorization': `Bearer ${KIE_API_KEY}` },
          timeout: 15000,
        });
        console.log(`[generate-video] poll ${i + 1} raw:`, JSON.stringify(pollRes.data).slice(0, 300));
        const taskData = pollRes.data?.data || pollRes.data;
        const state = taskData?.state;

        if (state === 'success') {
          // resultJson is a JSON string, parse it to get the URL
          try {
            const resultJson = JSON.parse(taskData.resultJson);
            videoUrl = resultJson?.resultUrls?.[0] || resultJson?.result_urls?.[0];
          } catch(e) {
            videoUrl = taskData?.video_url || taskData?.output?.video_url;
          }
          break;
        }
        if (state === 'failed' || state === 'error' || state === 'fail') throw new Error('Generation failed on Kie.ai');
      }

      if (!videoUrl) throw new Error('Generation timed out after 10 minutes');

      const outputPath = path.resolve(`outputs/gen_${timestamp}.mp4`);
      const dlRes = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 120000 });
      fs.writeFileSync(outputPath, Buffer.from(dlRes.data));

      if (imagePath) try { fs.unlinkSync(imagePath); } catch(e) {}
      setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e) {} }, 600000);

      return { success: true, videoUrl: `/outputs/gen_${timestamp}.mp4` };
    });

    res.json(result);
  } catch(err) {
    console.error('[generate-video] error:', err.message);
    if (imagePath) try { fs.unlinkSync(imagePath); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AI IMAGE GEN  —  POST /generate-image
// Models: nano-banana-pro, nano-banana-2, seedream-4.5
// ══════════════════════════════════════════════════════════════════════════════
app.post('/generate-image', upload.single('refImage'), async (req, res) => {
  const refImagePath = req.file ? path.resolve(req.file.path) : null;
  const timestamp = Date.now();
  const { model = 'nano-banana-pro', prompt = '', aspectRatio = '9:16', resolution = '1K', format = 'JPG' } = req.body;

  const KIE_API_KEY = process.env.KIE_API_KEY;
  if (!KIE_API_KEY) {
    if (refImagePath) try { fs.unlinkSync(refImagePath); } catch(e) {}
    return res.json({ success: false, error: 'KIE_API_KEY not configured in .env' });
  }

  const KIE_MODEL_MAP = {
    'nano-banana-pro': 'nano-banana-pro',
    'nano-banana-2':   'nano-banana-2',
  };
  const kieModel = KIE_MODEL_MAP[model] || 'nano-banana-pro';
  const RESOLUTION_MAP = { 'Basic': '1K', 'Standard': '2K', 'High': '4K', '1K': '1K', '2K': '2K', '4K': '4K' };
  const kieResolution = RESOLUTION_MAP[resolution] || '1K';
  const kieFormat = format.toLowerCase() === "jpg" ? "png" : format.toLowerCase();

  try {
    const result = await enqueue(async () => {
      console.log(`[generate-image] model=${kieModel} aspect=${aspectRatio} res=${resolution} hasRef=${!!refImagePath}`);

      const body = {
        model: kieModel,
        input: {
          prompt: prompt || "a beautiful cinematic scene",
          aspect_ratio: aspectRatio,
          resolution: kieResolution,
          output_format: kieFormat,
          image_input: [],
        },
      };

      if (refImagePath && fs.existsSync(refImagePath)) {
        body.input.image_input = [fs.readFileSync(refImagePath).toString('base64')];
      }

      console.log(`[generate-image] payload:`, JSON.stringify(body, null, 2));
      const submitRes = await axios.post('https://api.kie.ai/api/v1/jobs/createTask', body, {
        headers: { 'Authorization': `Bearer ${KIE_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 60000,
      });

      const taskId = submitRes.data?.data?.taskId || submitRes.data?.data?.task_id;
      if (!taskId) throw new Error('No taskId in response: ' + JSON.stringify(submitRes.data));
      console.log(`[generate-image] taskId=${taskId}`);

      let imageUrl = null;
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const pollRes = await axios.get(`https://api.kie.ai/api/v1/jobs/recordInfo`, {
          params: { taskId },
          headers: { 'Authorization': `Bearer ${KIE_API_KEY}` },
          timeout: 15000,
        });
        const taskData = pollRes.data?.data || pollRes.data;
        const state = taskData?.state;
        console.log(`[generate-image] poll ${i + 1} state=${state} raw:`, JSON.stringify(taskData).slice(0, 200));

        if (state === 'success') {
          try {
            const resultJson = JSON.parse(taskData.resultJson);
            imageUrl = resultJson?.resultUrls?.[0] || resultJson?.result_urls?.[0];
          } catch(e) {
            imageUrl = taskData?.image_url || taskData?.output?.image_url;
          }
          break;
        }
        if (state === 'failed' || state === 'error' || state === 'fail') throw new Error('Image generation failed on Kie.ai');
      }

      if (!imageUrl) throw new Error('Image generation timed out');

      const ext = format === 'PNG' ? 'png' : 'jpg';
      const outputPath = path.resolve(`outputs/img_${timestamp}.${ext}`);
      const dlRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 60000 });
      fs.writeFileSync(outputPath, Buffer.from(dlRes.data));

      if (refImagePath) try { fs.unlinkSync(refImagePath); } catch(e) {}
      setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e) {} }, 600000);

      return { success: true, imageUrl: `/outputs/img_${timestamp}.${ext}` };
    });

    res.json(result);
  } catch(err) {
    console.error('[generate-image] error:', err.message);
    if (refImagePath) try { fs.unlinkSync(refImagePath); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// VOICE GEN  —  POST /generate-voice  (handled by Puter.js on the frontend)
// ══════════════════════════════════════════════════════════════════════════════
app.post('/generate-voice', async (req, res) => {
  const { script, voiceId } = req.body;
  console.log(`[generate-voice] voiceId=${voiceId} scriptLen=${script?.length || 0}`);
  res.json({ success: true, note: 'Voice generation is handled by Puter.js on the frontend' });
});

// ══════════════════════════════════════════════════════════════════════════════
// VIDEO UPSCALER  —  POST /upscale-video
// ══════════════════════════════════════════════════════════════════════════════
app.post('/upscale-video', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  const { quality } = req.body;
  console.log(`[upscale-video] quality=${quality}`);

  try {
    await enqueue(async () => {
      const outputPath = path.resolve(`outputs/upscaled_${timestamp}.mp4`);
      const resMap = { '1080': '1920:-1', '2k': '2560:-1', '4k': '3840:-1' };
      const scale = resMap[quality] || '1920:-1';

      runFFmpeg([
        '-y', '-i', videoPath,
        '-vf', `scale=${scale}`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
        '-c:a', 'aac',
        outputPath,
      ], 300000);

      try { fs.unlinkSync(videoPath); } catch(e) {}
      setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e) {} }, 600000);
    });

    res.json({ success: true, videoUrl: `/outputs/upscaled_${timestamp}.mp4` });
  } catch(err) {
    console.error('[upscale-video] error:', err.message);
    try { fs.unlinkSync(videoPath); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// DEAD SPACE REMOVER  —  POST /remove-deadspace
// ══════════════════════════════════════════════════════════════════════════════
app.post('/remove-deadspace', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  const { dbThreshold = '-40' } = req.body;
  console.log(`[remove-deadspace] threshold=${dbThreshold}dB`);

  try {
    await enqueue(async () => {
      const outputPath = path.resolve(`outputs/trimmed_${timestamp}.mp4`);
      runFFmpeg([
        '-y', '-i', videoPath,
        '-af', `silenceremove=1:0:0.1:${dbThreshold}dB:1:0.1:${dbThreshold}dB`,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
        '-c:a', 'aac',
        outputPath,
      ], 300000);

      try { fs.unlinkSync(videoPath); } catch(e) {}
      setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e) {} }, 600000);
    });

    res.json({ success: true, videoUrl: `/outputs/trimmed_${timestamp}.mp4` });
  } catch(err) {
    console.error('[remove-deadspace] error:', err.message);
    try { fs.unlinkSync(videoPath); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// YT SCRAPER  —  POST /scrape-channel
// ══════════════════════════════════════════════════════════════════════════════
app.post('/scrape-channel', async (req, res) => {
  const { channelUrl, videoCount, contentType } = req.body;
  console.log(`[scrape-channel] url=${channelUrl} count=${videoCount} type=${contentType}`);

  const YT_API_KEY = process.env.YOUTUBE_API_KEY;
  if (!YT_API_KEY) {
    return res.json({ success: false, error: 'YOUTUBE_API_KEY not configured', data: [] });
  }

  try {
    const channelMatch = channelUrl.match(/@([a-zA-Z0-9_-]+)/) || channelUrl.match(/channel\/([a-zA-Z0-9_-]+)/);
    if (!channelMatch) return res.json({ success: false, error: 'Invalid channel URL', data: [] });

    // TODO: full YouTube Data API v3 integration
    res.json({
      success: true,
      videos: [
        { title: 'Video 1', views: 1000, date: '2024-01-01', engagement: '5.2%' },
        { title: 'Video 2', views: 2500, date: '2024-01-05', engagement: '7.8%' },
      ]
    });
  } catch(err) {
    console.error('[scrape-channel] error:', err.message);
    res.status(500).json({ success: false, error: err.message, data: [] });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// REPURPOSE  —  POST /enable-repurpose
// ══════════════════════════════════════════════════════════════════════════════
app.post('/enable-repurpose', async (req, res) => {
  const { ytChannel, platforms } = req.body;
  console.log(`[enable-repurpose] yt=${ytChannel} platforms=${platforms.join(',')}`);
  res.json({ success: true, status: 'active', monitoring: ytChannel, platforms });
});

// ══════════════════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log('\n✅ DubShorts v3 running at http://localhost:' + PORT);
  console.log('   KIE_API_KEY    :', process.env.KIE_API_KEY    ? '✓ set' : '✗ not set');
  console.log('   YOUTUBE_API_KEY:', process.env.YOUTUBE_API_KEY ? '✓ set' : '✗ not set');
  console.log('');
});

process.on('uncaughtException', err => {
  if (err.code === 'EPIPE') return;
  console.error('Uncaught exception:', err.message);
});
