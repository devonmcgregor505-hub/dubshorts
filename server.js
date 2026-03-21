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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/translate', upload.single('video'), async (req, res) => {
  const videoPath = req.file.path;
  const timestamp = Date.now();
  const audioPath = `uploads/spanish_${timestamp}.mp3`;
  const srtPath = `uploads/subs_${timestamp}.srt`;
  const outputPath = `uploads/final_${timestamp}.mp4`;

  console.log('File received:', req.file.originalname);

  try {

    // ── STEP 1: Remove captions with GhostCut ─────────────
    console.log('Step 1: Removing captions with GhostCut...');

    // First upload the video to get a URL GhostCut can access
    const uploadForm = new FormData();
    uploadForm.append('video', fs.createReadStream(videoPath), {
      filename: req.file.originalname,
      contentType: req.file.mimetype
    });

    // Submit subtitle removal job
    const ghostcutRes = await axios.post(
      'https://auto-video-watermark-or-subtitles-remove.p.rapidapi.com/removeSubs',
      uploadForm,
      {
        headers: {
          'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
          'X-RapidAPI-Host': 'auto-video-watermark-or-subtitles-remove.p.rapidapi.com',
          ...uploadForm.getHeaders()
        },
        timeout: 120000
      }
    );

    const taskId = ghostcutRes.data.task_id || ghostcutRes.data.id || ghostcutRes.data.taskId;
    console.log('GhostCut task started, ID:', taskId);

    // Poll for GhostCut result
    let cleanVideoUrl = null;
    let gcAttempts = 0;
    while (!cleanVideoUrl && gcAttempts < 24) {
      await new Promise(r => setTimeout(r, 10000));
      gcAttempts++;

      const resultRes = await axios.get(
        `https://auto-video-watermark-or-subtitles-remove.p.rapidapi.com/getResult`,
        {
          params: { task_id: taskId },
          headers: {
            'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
            'X-RapidAPI-Host': 'auto-video-watermark-or-subtitles-remove.p.rapidapi.com'
          }
        }
      );

      console.log('GhostCut check', gcAttempts, ':', resultRes.data.status || resultRes.data);
      if (resultRes.data.status === 'completed' || resultRes.data.url || resultRes.data.video_url) {
        cleanVideoUrl = resultRes.data.url || resultRes.data.video_url || resultRes.data.result;
      } else if (resultRes.data.status === 'failed') {
        throw new Error('GhostCut caption removal failed');
      }
    }

    if (!cleanVideoUrl) throw new Error('GhostCut timed out');
    console.log('Captions removed! Clean video URL:', cleanVideoUrl);

    // ── STEP 2: Send clean video to ElevenLabs ────────────
    console.log('Step 2: Sending to ElevenLabs...');

    const form = new FormData();
    form.append('url', cleanVideoUrl);
    form.append('source_lang', 'en');
    form.append('target_lang', 'es');
    form.append('num_speakers', '0');
    form.append('watermark', 'false');

    const startRes = await axios.post(
      'https://api.elevenlabs.io/v1/dubbing',
      form,
      {
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          ...form.getHeaders()
        },
        timeout: 600000
      }
    );

    const dubbingId = startRes.data.dubbing_id;
    console.log('Dubbing started, ID:', dubbingId);

    // Poll ElevenLabs
    let status = 'dubbing';
    let attempts = 0;
    while (status === 'dubbing' && attempts < 30) {
      await new Promise(r => setTimeout(r, 10000));
      attempts++;
      const checkRes = await axios.get(
        `https://api.elevenlabs.io/v1/dubbing/${dubbingId}`,
        { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
      );
      status = checkRes.data.status;
      console.log('ElevenLabs check', attempts, ':', status);
    }

    if (status !== 'dubbed') throw new Error('ElevenLabs dubbing failed: ' + status);
    console.log('Dubbing complete!');

    // ── STEP 3: Download Spanish audio ───────────────────
    console.log('Step 3: Downloading Spanish audio...');
    const audioRes = await axios.get(
      `https://api.elevenlabs.io/v1/dubbing/${dubbingId}/audio/es`,
      {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
        responseType: 'arraybuffer'
      }
    );
    fs.writeFileSync(audioPath, audioRes.data);

    // ── STEP 4: Get Spanish subtitles from ElevenLabs ────
    console.log('Step 4: Getting Spanish subtitles...');
    try {
      const srtRes = await axios.get(
        `https://api.elevenlabs.io/v1/dubbing/${dubbingId}/transcript/es?format_type=srt`,
        { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
      );
      fs.writeFileSync(srtPath, srtRes.data);
      console.log('Subtitles saved!');
    } catch (e) {
      console.log('No subtitles available, continuing without them');
    }

    // Clean up ElevenLabs job
    await axios.delete(
      `https://api.elevenlabs.io/v1/dubbing/${dubbingId}`,
      { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
    ).catch(() => {});

    // ── STEP 5: Merge clean video + Spanish audio + subs ─
    console.log('Step 5: Merging with FFmpeg...');

    const hasSubs = fs.existsSync(srtPath) && fs.statSync(srtPath).size > 0;

    await new Promise((resolve, reject) => {
      const cmd = ffmpeg()
        .input(cleanVideoUrl)
        .input(audioPath);

      if (hasSubs) {
        cmd.outputOptions([
          '-map 0:v',
          '-map 1:a',
          '-c:v libx264',
          '-c:a aac',
          '-shortest',
          `-vf subtitles=${srtPath}:force_style='FontName=Arial,FontSize=14,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Bold=1,Alignment=2'`
        ]);
      } else {
        cmd.outputOptions([
          '-map 0:v',
          '-map 1:a',
          '-c:v copy',
          '-c:a aac',
          '-shortest'
        ]);
      }

      cmd.output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    console.log('Merge complete!');

    // ── STEP 6: Serve download ────────────────────────────
    const token = Date.now().toString();
    app.get('/download/' + token, (req, res) => {
      res.download(outputPath, 'spanish_dubbed.mp4', () => {
        [videoPath, audioPath, srtPath, outputPath].forEach(f => {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        });
        console.log('Files cleaned up');
      });
    });

    res.json({ success: true, downloadUrl: '/download/' + token });

  } catch (err) {
    console.error('Error:', err.message);
    if (err.response) console.error('API response:', JSON.stringify(err.response.data));
    [videoPath, audioPath, srtPath, outputPath].forEach(f => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('DubShorts running at http://localhost:' + PORT);
});
```
