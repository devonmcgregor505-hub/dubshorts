require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use('/outputs', express.static('outputs'));

const upload = multer({ dest: 'uploads/', limits: { fileSize: 500 * 1024 * 1024 } });
['uploads','outputs'].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d); });

const MODAL_URL = 'https://devonmcgregor505--dubshorts-caption-remover-remove-captions.modal.run';

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/remove-captions', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const ts = Date.now();
  const outputPath = path.resolve(`outputs/clean_${ts}.mp4`);
  const captionBox = req.body.captionBox ? JSON.parse(req.body.captionBox) : null;

  if (!captionBox) {
    try { fs.unlinkSync(videoPath); } catch(e) {}
    return res.status(400).json({ success: false, error: 'No box provided' });
  }

  try {
    console.log('Sending to Modal... box:', JSON.stringify(captionBox));
    const videoBuffer = fs.readFileSync(videoPath);
    const videoBase64 = videoBuffer.toString('base64');

    const response = await axios.post(MODAL_URL, {
      video_base64: videoBase64,
      box: captionBox
    }, {
      timeout: 600000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    const result = response.data;
    if (result.error) throw new Error(result.error);
    if (!result.video_base64) throw new Error('No video returned from Modal');

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

app.listen(PORT, () => console.log(`Caption Remover running at http://localhost:${PORT}`));
