#!/bin/bash

# Color codes for terminal output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Banner
echo -e "${BLUE}"
echo "╔═══════════════════════════════════════════╗"
echo "║   Auto Text Detection Setup for DubShorts ║"
echo "║   Running on: $(uname -s)                      ║"
echo "╚═══════════════════════════════════════════╝"
echo -e "${NC}"

# Step 1: Find project directory
echo -e "${YELLOW}Step 1: Where is your DubShorts project?${NC}"
echo "Enter the full path to your project (or press Enter for current directory):"
read -p "> " PROJECT_PATH

if [ -z "$PROJECT_PATH" ]; then
  PROJECT_PATH="."
fi

# Expand ~ to home directory
PROJECT_PATH="${PROJECT_PATH/#\~/$HOME}"

# Check if project exists
if [ ! -f "$PROJECT_PATH/server.js" ]; then
  echo -e "${RED}✗ Error: server.js not found in $PROJECT_PATH${NC}"
  echo "Make sure you're pointing to the correct DubShorts directory"
  exit 1
fi

echo -e "${GREEN}✓ Found project at: $PROJECT_PATH${NC}"

# Step 2: Check if venv exists
echo -e "\n${YELLOW}Step 2: Checking virtual environment...${NC}"
if [ -d "$PROJECT_PATH/venv" ]; then
  echo -e "${GREEN}✓ Virtual environment found${NC}"
  PYTHON_PATH="$PROJECT_PATH/venv/bin/python"
else
  echo -e "${RED}✗ Virtual environment not found${NC}"
  echo "Creating venv..."
  cd "$PROJECT_PATH"
  python3 -m venv venv
  echo -e "${GREEN}✓ venv created${NC}"
  PYTHON_PATH="$PROJECT_PATH/venv/bin/python"
fi

# Step 3: Install dependencies
echo -e "\n${YELLOW}Step 3: Installing Keras-OCR and dependencies...${NC}"
echo "This may take a few minutes on first run..."
source "$PROJECT_PATH/venv/bin/activate"
pip install -q keras-ocr tensorflow opencv-python numpy 2>/dev/null

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ Dependencies installed successfully${NC}"
else
  echo -e "${YELLOW}⚠ Dependencies install had some warnings (this is usually fine)${NC}"
fi

# Step 4: Create detect_and_inpaint.py
echo -e "\n${YELLOW}Step 4: Creating detect_and_inpaint.py...${NC}"

cat > "$PROJECT_PATH/detect_and_inpaint.py" << 'EOF'
#!/usr/bin/env python3
"""
Automatic Text Detection + LaMa Inpainting
Detects text in video frames using Keras-OCR, then removes it with LaMa inpainting.
More accurate than manual box selection.
"""

import sys
import json
import cv2
import numpy as np
import subprocess
import os
from pathlib import Path

# Try to import keras_ocr, install if missing
try:
    import keras_ocr
except ImportError:
    print("Installing keras-ocr...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "keras-ocr", "-q"])
    import keras_ocr

def extract_frames(video_path, output_dir, max_frames=10):
    """Extract frames from video for text detection."""
    os.makedirs(output_dir, exist_ok=True)
    
    cmd = [
        'ffmpeg', '-i', video_path,
        '-vf', f'fps=1/5',  # 1 frame per 5 seconds
        '-q:v', '2',
        os.path.join(output_dir, 'frame_%04d.jpg')
    ]
    
    subprocess.run(cmd, capture_output=True, check=True)
    frames = sorted([f for f in os.listdir(output_dir) if f.endswith('.jpg')])[:max_frames]
    return [os.path.join(output_dir, f) for f in frames]

def detect_text_boxes(frame_paths):
    """
    Detect text in frames using Keras-OCR.
    Returns: list of (frame_path, [bounding_boxes]) tuples
    """
    print("Loading Keras-OCR pipeline...")
    pipeline = keras_ocr.pipeline.Pipeline()
    
    results = []
    for i, frame_path in enumerate(frame_paths):
        print(f"Detecting text in frame {i+1}/{len(frame_paths)}...")
        try:
            image = keras_ocr.tools.read(frame_path)
            predictions = pipeline.recognize([image])
            
            # Extract bounding boxes from predictions
            boxes = []
            for word_pred, box_pred in predictions[0]:
                if len(box_pred) == 4:
                    # Convert to [x, y, w, h] format (normalized 0-1)
                    points = box_pred
                    x_min = min(p[0] for p in points)
                    y_min = min(p[1] for p in points)
                    x_max = max(p[0] for p in points)
                    y_max = max(p[1] for p in points)
                    
                    # Normalize to 0-1
                    h, w = image.shape[:2]
                    box = {
                        'x': x_min / w,
                        'y': y_min / h,
                        'w': (x_max - x_min) / w,
                        'h': (y_max - y_min) / h,
                        'text': word_pred
                    }
                    boxes.append(box)
            
            results.append((frame_path, boxes))
            print(f"  Found {len(boxes)} text regions")
        except Exception as e:
            print(f"  Error detecting text: {e}")
            results.append((frame_path, []))
    
    return results

def merge_boxes(detected_boxes, padding=0.02):
    """
    Merge overlapping text boxes to create larger removal regions.
    Padding extends the box slightly to ensure full text removal.
    """
    if not detected_boxes:
        return None
    
    # Get bounds of all detected text
    x_mins = [b['x'] - padding for b in detected_boxes]
    y_mins = [b['y'] - padding for b in detected_boxes]
    x_maxs = [b['x'] + b['w'] + padding for b in detected_boxes]
    y_maxs = [b['y'] + b['h'] + padding for b in detected_boxes]
    
    merged_box = {
        'x': max(0, min(x_mins)),
        'y': max(0, min(y_mins)),
        'w': min(1, max(x_maxs)) - max(0, min(x_mins)),
        'h': min(1, max(y_maxs)) - max(0, min(y_mins))
    }
    
    return merged_box

def inpaint_video_with_lama(video_in, video_out, detected_boxes, model_path=None):
    """
    Call the existing LaMa inpainting script with auto-detected boxes.
    """
    if not detected_boxes:
        print("No text detected. Copying video as-is.")
        subprocess.run(['cp', video_in, video_out], check=True)
        return
    
    # Merge all detected boxes into one removal region
    merged_box = merge_boxes(detected_boxes, padding=0.03)
    
    print(f"Inpainting region: x={merged_box['x']:.3f}, y={merged_box['y']:.3f}, w={merged_box['w']:.3f}, h={merged_box['h']:.3f}")
    
    # Call your existing inpaint_captions.py script
    python_path = os.path.join(os.path.dirname(__file__), 'venv/bin/python')
    script_path = os.path.join(os.path.dirname(__file__), 'inpaint_captions.py')
    
    result = subprocess.run(
        [python_path, script_path, video_in, video_out, json.dumps(merged_box)],
        timeout=600,
        capture_output=True
    )
    
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
        print(f"Input: {video_in}")
        print(f"Output: {video_out}")
        print(f"Work dir: {work_dir}")
        
        # Step 1: Extract key frames
        print("\n[Step 1] Extracting frames...")
        frame_paths = extract_frames(video_in, work_dir)
        
        if not frame_paths:
            print("No frames extracted. Video may be too short or invalid.")
            subprocess.run(['cp', video_in, video_out], check=True)
            return
        
        # Step 2: Detect text
        print("\n[Step 2] Detecting text...")
        detection_results = detect_text_boxes(frame_paths)
        
        # Step 3: Aggregate all detected boxes
        all_boxes = []
        for frame_path, boxes in detection_results:
            all_boxes.extend(boxes)
        
        if all_boxes:
            print(f"\nTotal text regions found: {len(all_boxes)}")
        else:
            print("No text detected in video. Skipping inpainting.")
            subprocess.run(['cp', video_in, video_out], check=True)
            return
        
        # Step 4: Inpaint video
        print("\n[Step 3] Inpainting video...")
        inpaint_video_with_lama(video_in, video_out, all_boxes)
        
        print("\n✓ Done!")
        
    finally:
        # Cleanup
        import shutil
        if os.path.exists(work_dir):
            shutil.rmtree(work_dir)

if __name__ == '__main__':
    main()
EOF

chmod +x "$PROJECT_PATH/detect_and_inpaint.py"
echo -e "${GREEN}✓ Created detect_and_inpaint.py${NC}"

# Step 5: Backup and update server.js
echo -e "\n${YELLOW}Step 5: Updating server.js with new endpoint...${NC}"

# Create backup
cp "$PROJECT_PATH/server.js" "$PROJECT_PATH/server.js.backup"
echo -e "${GREEN}✓ Created backup: server.js.backup${NC}"

# Find where to insert the new endpoint (after /remove-captions-fast)
LINE_NUM=$(grep -n "app.listen(PORT" "$PROJECT_PATH/server.js" | head -1 | cut -d: -f1)

if [ -z "$LINE_NUM" ]; then
  echo -e "${RED}✗ Could not find insertion point in server.js${NC}"
  echo "Please manually add the endpoint from new_endpoint.js"
  exit 1
fi

# Create the new endpoint code
NEW_ENDPOINT='
// ── AUTO TEXT DETECTION ENDPOINT ─────────────────────────────────────────────
app.post('"'"'/remove-captions-auto'"'"', upload.single('"'"'video'"'"'), async (req, res) => {
  const videoPath = path.resolve(req.file.path);
  const timestamp = Date.now();
  const outputPath = path.resolve('"'"'outputs/clean_auto_'"'"' + timestamp + '"'"'.mp4'"'"');

  const workDir = path.resolve('"'"'outputs/inpaint_auto_'"'"' + timestamp);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    await enqueue(async () => {
      console.log('"'"'Step 1: Auto-detecting text in video...'"'"');
      
      const python = path.join(__dirname, '"'"'venv/bin/python'"'"');
      const script = path.join(__dirname, '"'"'detect_and_inpaint.py'"'"');
      
      const tempOutput = path.resolve(workDir, '"'"'inpainted_temp.mp4'"'"');
      
      const result = spawnSync(python, [script, videoPath, tempOutput], {
        timeout: 900000,
        maxBuffer: 100 * 1024 * 1024,
        stdio: ['"'"'ignore'"'"', '"'"'pipe'"'"', '"'"'pipe'"'"'],
      });
      
      const out = (result.stdout || '"'"''"'"').toString();
      const err = (result.stderr || '"'"''"'"').toString();
      
      if (out) console.log('"'"'[auto-detect]'"'"', out.trim());
      if (result.status !== 0) {
        throw new Error('"'"'Auto-detection failed: '"'"' + err.slice(-400));
      }

      console.log('"'"'Step 2: Finalizing video...'"'"');
      
      if (!fs.existsSync(tempOutput)) {
        throw new Error('"'"'Inpainting produced no output file'"'"');
      }

      const probeInpainted = spawnSync(FFMPEG_PATH, ['"'"'-i'"'"', tempOutput], { encoding: '"'"'utf8'"'"' });
      const hasAudio = (probeInpainted.stderr || '"'"''"'"').includes('"'"'Audio:'"'"');

      if (!hasAudio) {
        console.log('"'"'Inpainted video missing audio, adding original...'"'"');
        const tempWithAudio = path.resolve(workDir, '"'"'with_audio.mp4'"'"');
        runFFmpeg([
          '"'"'-y'"'"',
          '"'"'-i'"'"', tempOutput,
          '"'"'-i'"'"', videoPath,
          '"'"'-map'"'"', '"'"'0:v:0'"'"',
          '"'"'-map'"'"', '"'"'1:a:0'"'"',
          '"'"'-c:v'"'"', '"'"'libx264'"'"', '"'"'-preset'"'"', '"'"'fast'"'"', '"'"'-crf'"'"', '"'"'22'"'"',
          '"'"'-c:a'"'"', '"'"'aac'"'"', '"'"'-ac'"'"', '"'"'2'"'"',
          '"'"'-shortest'"'"',
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
      
      return { success: true, videoUrl: '"'"'/outputs/clean_auto_'"'"' + timestamp + '"'"'.mp4'"'"', method: '"'"'auto-detect'"'"' };
    });

    res.json({ success: true, videoUrl: '"'"'/outputs/clean_auto_'"'"' + timestamp + '"'"'.mp4'"'"' });
  } catch(err) {
    console.error('"'"'remove-captions-auto error:'"'"', err.message);
    try { fs.unlinkSync(videoPath); } catch(e) {}
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});
'

# Insert the endpoint before app.listen
sed -i.bak "$((LINE_NUM-1))a\\
$NEW_ENDPOINT
" "$PROJECT_PATH/server.js"

echo -e "${GREEN}✓ Added /remove-captions-auto endpoint to server.js${NC}"

# Step 6: Create HTML snippet file
echo -e "\n${YELLOW}Step 6: Creating HTML button snippet...${NC}"

cat > "$PROJECT_PATH/AUTO_DETECT_BUTTON.html" << 'HTMLEOF'
<!-- ADD THIS TO YOUR index.html FILE -->
<!-- Find the section with the caption removal UI and add this button -->

<button class="submit" id="autoDetectBtn" onclick="startAutoDetection()" 
  style="background: linear-gradient(135deg, #f5e132, #ffe600); margin-top: 8px;">
  🤖 Auto-Detect & Remove Captions
</button>

<!-- ADD THIS JAVASCRIPT TO YOUR <script> SECTION -->
<script>
async function startAutoDetection() {
  const f = fileInput.files[0];
  if (!f) { 
    alert('Please select a video first');
    return; 
  }

  const btn = document.getElementById('autoDetectBtn');
  btn.disabled = true;
  
  hide('doneBox');
  hide('errBox');
  startProg();

  const fd = new FormData();
  fd.append('video', f);

  try {
    console.log('Sending video for auto text detection...');
    const res = await fetch('/remove-captions-auto', { method: 'POST', body: fd });
    const data = await res.json();
    
    finishProg();
    
    if (data.success) {
      show('doneBox');
      document.getElementById('resultVideo').src = data.videoUrl;
      document.getElementById('dlBtn').href = data.videoUrl;
      document.querySelector('.done-title').textContent = '// AUTO-DETECTED & REMOVED ✓';
      document.getElementById('dlBtn').textContent = '⬇ Download Clean Video';
      document.getElementById('hintTxt').textContent = 'Text automatically detected and removed!';
    } else {
      show('errBox');
      document.getElementById('errMsg').textContent = data.error || 'Auto-detection failed';
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
HTMLEOF

echo -e "${GREEN}✓ Created AUTO_DETECT_BUTTON.html (instructions for manual HTML update)${NC}"

# Step 7: Summary
echo -e "\n${BLUE}╔════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          SETUP COMPLETE! ✓                     ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════╝${NC}"

echo -e "\n${GREEN}Files Created:${NC}"
echo "  ✓ detect_and_inpaint.py"
echo "  ✓ server.js (updated with /remove-captions-auto)"
echo "  ✓ server.js.backup (safety backup)"
echo "  ✓ AUTO_DETECT_BUTTON.html (button instructions)"

echo -e "\n${YELLOW}NEXT STEPS:${NC}"
echo "1. Open your index.html file"
echo "2. Find the section with caption removal UI (around line 400-450)"
echo "3. Copy the button HTML from: $PROJECT_PATH/AUTO_DETECT_BUTTON.html"
echo "4. Paste it in your <div class=\"tog-row\"> section"
echo "5. Copy the JavaScript function from AUTO_DETECT_BUTTON.html"
echo "6. Paste it in your main <script> section"
echo ""
echo "7. Restart your server:"
echo "   ${BLUE}cd $PROJECT_PATH && npm start${NC}"
echo ""
echo "8. Test at: http://localhost:3000"
echo "   Upload a video and click '🤖 Auto-Detect & Remove Captions'"

echo -e "\n${YELLOW}BACKUP LOCATION:${NC}"
echo "  Old server.js: $PROJECT_PATH/server.js.backup"

echo -e "\n${GREEN}Happy caption removing! 🚀${NC}\n"
