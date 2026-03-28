import re

server_js = '''require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/remove-captions', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const ts = Date.now();
  const outputPath = path.resolve(`outputs/clean_${ts}.mp4`);
  const captionBox = req.body.captionBox || null;

  try {
    const python = process.env.PYTHON || 'python3';
    const script = path.join(__dirname, 'remove_captions.py');
    const args = [script, videoPath, outputPath];
    if (captionBox) args.push(captionBox);

    console.log('Running caption removal...' + (captionBox ? ' (box-guided)' : ' (full OCR)'));
    const result = spawnSync(python, args, {
      timeout: 900000,
      maxBuffer: 200 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const out = (result.stdout || '').toString();
    const err = (result.stderr || '').toString();
    if (out) console.log('[py]', out.trim());
    if (result.status !== 0) throw new Error(err.slice(-800));

    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 10000) {
      throw new Error('Output file missing or too small');
    }

    try { fs.unlinkSync(videoPath); } catch(e) {}
    setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e) {} }, 3600000);

    res.json({ success: true, videoUrl: `/outputs/clean_${ts}.mp4` });
  } catch(err) {
    console.error('Error:', err.message);
    try { fs.unlinkSync(videoPath); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Caption Remover running at http://localhost:${PORT}`));
'''

with open('/Users/kanemcgregor/dubshorts/caption-remover/server.js', 'w') as f:
    f.write(server_js)
print('server.js written!')
