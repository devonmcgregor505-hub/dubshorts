content = open('/Users/kanemcgregor/dubshorts/caption-remover/server.js').read()

new_route = """
app.post('/remove-captions-fast', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const ts = Date.now();
  const outputPath = path.resolve(`outputs/fast_${ts}.mp4`);
  const box = req.body.captionBox ? JSON.parse(req.body.captionBox) : null;
  if (!box) return res.status(400).json({ success: false, error: 'No box provided' });
  try {
    const probe = require('child_process').spawnSync('ffmpeg', ['-i', videoPath], { encoding: 'utf8' });
    const dim = (probe.stderr || '').match(/(\\d{3,5})x(\\d{3,5})/);
    const W = dim ? parseInt(dim[1]) : 1080;
    const H = dim ? parseInt(dim[2]) : 1920;
    const bx = Math.round(box.x * W);
    const by = Math.round(box.y * H);
    const bw = Math.round(box.w * W);
    const bh = Math.round(box.h * H);
    const r = require('child_process').spawnSync('/opt/homebrew/bin/ffmpeg', [
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

"""

content = content.replace("app.listen(", new_route + "app.listen(")
open('/Users/kanemcgregor/dubshorts/caption-remover/server.js', 'w').write(content)
print('server.js updated!')
