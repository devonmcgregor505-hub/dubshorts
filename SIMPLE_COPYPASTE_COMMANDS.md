# COPY-PASTE TERMINAL COMMANDS FOR MAC

## EASIEST METHOD: One Command

First, verify you have the files. Then in your VS Code terminal:

```bash
bash setup_auto_detect.sh
```

That's it! The script handles everything.

---

## IF THAT DOESN'T WORK: Manual Commands

Run these one at a time in your VS Code terminal:

### 1. Navigate to your project
```bash
cd /path/to/your/dubshorts
```
(Replace with your actual path, or just `cd` to where server.js is)

### 2. Activate virtual environment
```bash
source venv/bin/activate
```

### 3. Install required packages
```bash
pip install -q keras-ocr tensorflow opencv-python numpy
```
(This takes 2-3 minutes, be patient)

### 4. Create the Python script
```bash
cat > detect_and_inpaint.py << 'ENDOFFILE'
#!/usr/bin/env python3
import sys
import json
import subprocess
import os

try:
    import keras_ocr
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "keras-ocr", "-q"])
    import keras_ocr

def extract_frames(video_path, output_dir, max_frames=10):
    os.makedirs(output_dir, exist_ok=True)
    cmd = ['ffmpeg', '-i', video_path, '-vf', f'fps=1/5', '-q:v', '2', os.path.join(output_dir, 'frame_%04d.jpg')]
    subprocess.run(cmd, capture_output=True, check=True)
    frames = sorted([f for f in os.listdir(output_dir) if f.endswith('.jpg')])[:max_frames]
    return [os.path.join(output_dir, f) for f in frames]

def detect_text_boxes(frame_paths):
    print("Loading Keras-OCR pipeline...")
    pipeline = keras_ocr.pipeline.Pipeline()
    results = []
    for i, frame_path in enumerate(frame_paths):
        print(f"Detecting text in frame {i+1}/{len(frame_paths)}...")
        try:
            image = keras_ocr.tools.read(frame_path)
            predictions = pipeline.recognize([image])
            boxes = []
            for word_pred, box_pred in predictions[0]:
                if len(box_pred) == 4:
                    points = box_pred
                    x_min = min(p[0] for p in points)
                    y_min = min(p[1] for p in points)
                    x_max = max(p[0] for p in points)
                    y_max = max(p[1] for p in points)
                    h, w = image.shape[:2]
                    box = {'x': x_min / w, 'y': y_min / h, 'w': (x_max - x_min) / w, 'h': (y_max - y_min) / h, 'text': word_pred}
                    boxes.append(box)
            results.append((frame_path, boxes))
            print(f"  Found {len(boxes)} text regions")
        except Exception as e:
            print(f"  Error detecting text: {e}")
            results.append((frame_path, []))
    return results

def merge_boxes(detected_boxes, padding=0.02):
    if not detected_boxes:
        return None
    x_mins = [b['x'] - padding for b in detected_boxes]
    y_mins = [b['y'] - padding for b in detected_boxes]
    x_maxs = [b['x'] + b['w'] + padding for b in detected_boxes]
    y_maxs = [b['y'] + b['h'] + padding for b in detected_boxes]
    merged_box = {'x': max(0, min(x_mins)), 'y': max(0, min(y_mins)), 'w': min(1, max(x_maxs)) - max(0, min(x_mins)), 'h': min(1, max(y_maxs)) - max(0, min(y_mins))}
    return merged_box

def inpaint_video_with_lama(video_in, video_out, detected_boxes):
    if not detected_boxes:
        print("No text detected. Copying video as-is.")
        subprocess.run(['cp', video_in, video_out], check=True)
        return
    merged_box = merge_boxes(detected_boxes, padding=0.03)
    print(f"Inpainting region: x={merged_box['x']:.3f}, y={merged_box['y']:.3f}, w={merged_box['w']:.3f}, h={merged_box['h']:.3f}")
    python_path = os.path.join(os.path.dirname(__file__), 'venv/bin/python')
    script_path = os.path.join(os.path.dirname(__file__), 'inpaint_captions.py')
    result = subprocess.run([python_path, script_path, video_in, video_out, json.dumps(merged_box)], timeout=600, capture_output=True)
    if result.returncode != 0:
        raise Exception(f"Inpainting failed: {result.stderr.decode()[-500:]}")
    print("Inpainting complete!")

def main():
    if len(sys.argv) < 3:
        print("Usage: python detect_and_inpaint.py <video_in> <video_out>")
        sys.exit(1)
    video_in = sys.argv[1]
    video_out = sys.argv[2]
    work_dir = '/tmp/text_detection_' + str(os.getpid())
    try:
        print(f"Input: {video_in}\nOutput: {video_out}\nWork dir: {work_dir}")
        print("\n[Step 1] Extracting frames...")
        frame_paths = extract_frames(video_in, work_dir)
        if not frame_paths:
            print("No frames extracted. Video may be too short or invalid.")
            subprocess.run(['cp', video_in, video_out], check=True)
            return
        print("\n[Step 2] Detecting text...")
        detection_results = detect_text_boxes(frame_paths)
        all_boxes = []
        for frame_path, boxes in detection_results:
            all_boxes.extend(boxes)
        if all_boxes:
            print(f"\nTotal text regions found: {len(all_boxes)}")
        else:
            print("No text detected in video. Skipping inpainting.")
            subprocess.run(['cp', video_in, video_out], check=True)
            return
        print("\n[Step 3] Inpainting video...")
        inpaint_video_with_lama(video_in, video_out, all_boxes)
        print("\n✓ Done!")
    finally:
        import shutil
        if os.path.exists(work_dir):
            shutil.rmtree(work_dir)

if __name__ == '__main__':
    main()
ENDOFFILE
chmod +x detect_and_inpaint.py
```

### 5. Verify it was created
```bash
ls -la detect_and_inpaint.py
```
(Should show: `-rwxr-xr-x ... detect_and_inpaint.py`)

### 6. Test Python script works
```bash
python detect_and_inpaint.py
```
(Should say: "Usage: python detect_and_inpaint.py <video_in> <video_out>")

---

## Now Update server.js

### Option A: Using nano (easiest)
```bash
nano server.js
```
- Press `Ctrl+W` to search
- Type: `app.listen(PORT`
- Press Enter (it will take you to that line)
- Press `Ctrl+O` then Enter (save and exit)
- Add this code BEFORE the `app.listen` line:

```javascript
app.post('/remove-captions-auto', upload.single('video'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  const outputPath = path.resolve('outputs/clean_auto_' + timestamp + '.mp4');
  const workDir = path.resolve('outputs/inpaint_auto_' + timestamp);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    await enqueue(async () => {
      console.log('Step 1: Auto-detecting text in video...');
      const python = path.join(__dirname, 'venv/bin/python');
      const script = path.join(__dirname, 'detect_and_inpaint.py');
      const tempOutput = path.resolve(workDir, 'inpainted_temp.mp4');
      const result = spawnSync(python, [script, videoPath, tempOutput], {
        timeout: 900000,
        maxBuffer: 100 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = (result.stdout || '').toString();
      const err = (result.stderr || '').toString();
      if (out) console.log('[auto-detect]', out.trim());
      if (result.status !== 0) throw new Error('Auto-detection failed: ' + err.slice(-400));
      console.log('Step 2: Finalizing video...');
      if (!fs.existsSync(tempOutput)) throw new Error('Inpainting produced no output file');
      const probeInpainted = spawnSync(FFMPEG_PATH, ['-i', tempOutput], { encoding: 'utf8' });
      const hasAudio = (probeInpainted.stderr || '').includes('Audio:');
      if (!hasAudio) {
        console.log('Inpainted video missing audio, adding original...');
        const tempWithAudio = path.resolve(workDir, 'with_audio.mp4');
        runFFmpeg(['-y', '-i', tempOutput, '-i', videoPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-c:a', 'aac', '-ac', '2', '-shortest', tempWithAudio,], 180000);
        fs.copyFileSync(tempWithAudio, outputPath);
        try { fs.unlinkSync(tempWithAudio); } catch(e) {}
      } else {
        fs.copyFileSync(tempOutput, outputPath);
      }
      try { fs.unlinkSync(videoPath); } catch(e) {}
      try { fs.unlinkSync(tempOutput); } catch(e) {}
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e) {}
      setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e) {} }, 600000);
      return { success: true, videoUrl: '/outputs/clean_auto_' + timestamp + '.mp4', method: 'auto-detect' };
    });
    res.json({ success: true, videoUrl: '/outputs/clean_auto_' + timestamp + '.mp4' });
  } catch(err) {
    console.error('remove-captions-auto error:', err.message);
    try { fs.unlinkSync(videoPath); } catch(e) {}
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});
```

### Option B: Using VS Code
1. Open `server.js` in VS Code
2. Press `Cmd + F` (Find)
3. Search: `app.listen(PORT`
4. Click on that line
5. Press Escape
6. Click at the beginning of that line
7. Create new line above (Cmd + Enter)
8. Paste the code above

---

## Update index.html

1. In VS Code, open `index.html`
2. Press `Cmd + F`, search: `<button class="submit" id="translateBtn"`
3. Go to the end of `</button>` 
4. Press Enter to create new line
5. Paste this:

```html
<button class="submit" id="autoDetectBtn" onclick="startAutoDetection()" 
  style="background: linear-gradient(135deg, #f5e132, #ffe600); margin-top: 8px;">
  🤖 Auto-Detect & Remove Captions
</button>
```

6. Now find the last `</script>` tag at the end of the file
7. Before `</script>`, paste:

```javascript
async function startAutoDetection() {
  const f = fileInput.files[0];
  if (!f) { alert('Please select a video first'); return; }
  const btn = document.getElementById('autoDetectBtn');
  btn.disabled = true;
  hide('doneBox');
  hide('errBox');
  startProg();
  const fd = new FormData();
  fd.append('video', f);
  try {
    const res = await fetch('/remove-captions-auto', { method: 'POST', body: fd });
    const data = await res.json();
    finishProg();
    if (data.success) {
      show('doneBox');
      document.getElementById('resultVideo').src = data.videoUrl;
      document.getElementById('dlBtn').href = data.videoUrl;
      document.querySelector('.done-title').textContent = '// AUTO-DETECTED & REMOVED ✓';
    } else {
      show('errBox');
      document.getElementById('errMsg').textContent = data.error;
    }
  } catch(err) {
    finishProg();
    show('errBox');
    document.getElementById('errMsg').textContent = 'Server error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}
```

---

## Start Your Server

```bash
npm start
```

You should see:
```
DubShorts running at http://localhost:3000
```

---

## Test It!

1. Open http://localhost:3000 in your browser
2. Upload a video with captions
3. Click **"🤖 Auto-Detect & Remove Captions"**
4. Wait for processing
5. Download the clean video!

---

That's it! 🚀
