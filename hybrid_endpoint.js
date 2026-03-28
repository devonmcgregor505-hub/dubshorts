// REPLACE THE /remove-captions-auto ENDPOINT WITH THIS ONE

app.post('/remove-captions-auto', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  const outputPath = path.resolve('outputs/clean_auto_' + timestamp + '.mp4');
  const workDir = path.resolve('outputs/inpaint_auto_' + timestamp);
  
  // Get user's box from request
  const captionBox = req.body.captionBox ? JSON.parse(req.body.captionBox) : null;
  
  // If no box provided, fail gracefully
  if (!captionBox) {
    return res.status(400).json({ success: false, error: 'Please draw a box around the captions first' });
  }

  fs.mkdirSync(workDir, { recursive: true });

  try {
    await enqueue(async () => {
      console.log('Step 1: Detecting text within your box...');
      
      const python = path.join(__dirname, 'venv/bin/python');
      const script = path.join(__dirname, 'detect_and_inpaint_hybrid.py');
      const tempOutput = path.resolve(workDir, 'inpainted_temp.mp4');
      
      // Pass user's box to the script
      const result = spawnSync(python, [script, videoPath, tempOutput, JSON.stringify(captionBox)], {
        timeout: 600000,
        maxBuffer: 100 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      
      const out = (result.stdout || '').toString();
      const err = (result.stderr || '').toString();
      
      if (out) console.log('[hybrid]', out.trim());
      if (result.status !== 0) {
        throw new Error('Auto-detection failed: ' + err.slice(-400));
      }

      console.log('Step 2: Finalizing video...');
      
      if (!fs.existsSync(tempOutput)) {
        throw new Error('Inpainting produced no output file');
      }

      // Check if inpainted video has audio
      const probeInpainted = spawnSync(FFMPEG_PATH, ['-i', tempOutput], { encoding: 'utf8' });
      const hasAudio = (probeInpainted.stderr || '').includes('Audio:');

      if (!hasAudio) {
        console.log('Adding original audio...');
        const tempWithAudio = path.resolve(workDir, 'with_audio.mp4');
        runFFmpeg([
          '-y',
          '-i', tempOutput,
          '-i', videoPath,
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
          '-c:a', 'aac', '-ac', '2',
          '-shortest',
          tempWithAudio,
        ], 180000);
        fs.copyFileSync(tempWithAudio, outputPath);
        try { fs.unlinkSync(tempWithAudio); } catch(e) {}
      } else {
        fs.copyFileSync(tempOutput, outputPath);
      }

      try { fs.unlinkSync(videoPath); } catch(e) {}
      try { fs.unlinkSync(tempOutput); } catch(e) {}
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e) {}
      
      setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e) {} }, 600000);
      
      return { success: true, videoUrl: '/outputs/clean_auto_' + timestamp + '.mp4' };
    });

    res.json({ success: true, videoUrl: '/outputs/clean_auto_' + timestamp + '.mp4' });
  } catch(err) {
    console.error('remove-captions-auto error:', err.message);
    try { fs.unlinkSync(videoPath); } catch(e) {}
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});
