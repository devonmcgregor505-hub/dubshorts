#!/bin/bash

# Color codes
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════${NC}"
echo -e "${BLUE}  AUTO DETECTION - COMPLETE SETUP${NC}"
echo -e "${BLUE}═══════════════════════════════════════════${NC}\n"

# Check we're in the right directory
if [ ! -f "server.js" ]; then
  echo -e "${RED}✗ Error: server.js not found in current directory${NC}"
  echo "Make sure you're in your dubshorts folder"
  exit 1
fi

echo -e "${GREEN}✓ Found server.js${NC}"
echo -e "${GREEN}✓ Found index.html${NC}\n"

# Step 1: Check if detect_and_inpaint.py exists
if [ ! -f "detect_and_inpaint.py" ]; then
  echo -e "${YELLOW}Step 1: Creating detect_and_inpaint.py...${NC}"
  
  cat > detect_and_inpaint.py << 'PYEOF'
#!/usr/bin/env python3
import sys, json, subprocess, os
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
PYEOF
  
  chmod +x detect_and_inpaint.py
  echo -e "${GREEN}✓ Created detect_and_inpaint.py${NC}\n"
else
  echo -e "${GREEN}✓ detect_and_inpaint.py already exists${NC}\n"
fi

# Step 2: Backup and update server.js
echo -e "${YELLOW}Step 2: Updating server.js...${NC}"

if grep -q "remove-captions-auto" server.js; then
  echo -e "${GREEN}✓ Endpoint already in server.js${NC}\n"
else
  cp server.js server.js.backup
  echo -e "${GREEN}✓ Created backup: server.js.backup${NC}"
  
  # Find the line with app.listen and insert before it
  LINE=$(grep -n "app.listen(PORT" server.js | head -1 | cut -d: -f1)
  
  if [ -z "$LINE" ]; then
    echo -e "${RED}✗ Could not find app.listen in server.js${NC}"
    exit 1
  fi
  
  # Create temp file with the new endpoint
  head -n $((LINE-1)) server.js > server.js.tmp
  
  cat >> server.js.tmp << 'JSEOF'

// ── AUTO TEXT DETECTION ENDPOINT ─────────────────────────────────────────────
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
        runFFmpeg(['-y', '-i', tempOutput, '-i', videoPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-c:a', 'aac', '-ac', '2', '-shortest', tempWithAudio], 180000);
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

JSEOF
  
  tail -n +$LINE server.js >> server.js.tmp
  mv server.js.tmp server.js
  
  echo -e "${GREEN}✓ Added /remove-captions-auto endpoint to server.js${NC}\n"
fi

# Step 3: Update index.html
echo -e "${YELLOW}Step 3: Updating index.html...${NC}"

if grep -q "autoDetectBtn" index.html; then
  echo -e "${GREEN}✓ Button already in index.html${NC}\n"
else
  cp index.html index.html.backup
  echo -e "${GREEN}✓ Created backup: index.html.backup${NC}"
  
  # Find the line with translateBtn button and insert after it
  LINE=$(grep -n '<button class="submit" id="translateBtn"' index.html | head -1 | cut -d: -f1)
  
  if [ -z "$LINE" ]; then
    echo -e "${RED}✗ Could not find translateBtn in index.html${NC}"
    echo "Trying alternative search..."
    LINE=$(grep -n 'class="submit"' index.html | head -1 | cut -d: -f1)
  fi
  
  if [ -z "$LINE" ]; then
    echo -e "${RED}✗ Could not find submit button in index.html${NC}"
    exit 1
  fi
  
  # Find the closing </button> after the line
  CLOSE_LINE=$(tail -n +$LINE index.html | grep -n "</button>" | head -1 | cut -d: -f1)
  CLOSE_LINE=$((LINE + CLOSE_LINE - 1))
  
  # Create temp file
  head -n $CLOSE_LINE index.html > index.html.tmp
  
  cat >> index.html.tmp << 'HTMLEOF'

<button class="submit" id="autoDetectBtn" onclick="startAutoDetection()" style="background: linear-gradient(135deg, #f5e132, #ffe600); margin-top: 8px;">
  🤖 Auto-Detect & Remove Captions
</button>
HTMLEOF
  
  tail -n +$((CLOSE_LINE+1)) index.html >> index.html.tmp
  mv index.html.tmp index.html
  
  echo -e "${GREEN}✓ Added button to index.html${NC}"
fi

# Step 4: Add JavaScript function to index.html
if grep -q "function startAutoDetection" index.html; then
  echo -e "${GREEN}✓ JavaScript function already in index.html${NC}\n"
else
  # Find closing </script> tag
  SCRIPT_LINE=$(grep -n "</script>" index.html | tail -1 | cut -d: -f1)
  
  if [ -z "$SCRIPT_LINE" ]; then
    echo -e "${RED}✗ Could not find </script> tag${NC}"
    exit 1
  fi
  
  # Create temp file
  head -n $((SCRIPT_LINE-1)) index.html > index.html.tmp
  
  cat >> index.html.tmp << 'JSEOF'
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
      document.getElementById('errMsg').textContent = data.error || 'Error occurred';
    }
  } catch(err) {
    finishProg();
    show('errBox');
    document.getElementById('errMsg').textContent = 'Server error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}
</script>
JSEOF
  
  mv index.html.tmp index.html
  
  echo -e "${GREEN}✓ Added JavaScript function to index.html${NC}\n"
fi

# Summary
echo -e "${BLUE}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✓ SETUP COMPLETE!${NC}"
echo -e "${BLUE}═══════════════════════════════════════════${NC}\n"

echo -e "${GREEN}Files Updated:${NC}"
echo "  ✓ detect_and_inpaint.py (Python script)"
echo "  ✓ server.js (added /remove-captions-auto endpoint)"
echo "  ✓ index.html (added button & function)"
echo ""
echo -e "${YELLOW}Backups Created:${NC}"
echo "  • server.js.backup"
echo "  • index.html.backup"
echo ""
echo -e "${YELLOW}Next Step:${NC}"
echo "  Restart your server:"
echo "    ${BLUE}npm start${NC}"
echo ""
echo -e "${YELLOW}Then visit:${NC}"
echo "  ${BLUE}http://localhost:3000${NC}"
echo ""
echo -e "${GREEN}You should see a new button: 🤖 Auto-Detect & Remove Captions${NC}\n"
