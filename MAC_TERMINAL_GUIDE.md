# HOW TO RUN THE AUTO-DETECTION SETUP ON MAC

## Quick Start (Copy & Paste)

### Step 1: Download the setup script
In your VS Code terminal, run:

```bash
cd ~/Downloads
curl -o setup_auto_detect.sh https://raw.githubusercontent.com/user/repo/setup_auto_detect.sh
chmod +x setup_auto_detect.sh
```

**OR** if you got the file directly, just navigate to it:

```bash
cd /path/to/where/you/downloaded/setup_auto_detect.sh
chmod +x setup_auto_detect.sh
```

### Step 2: Run the script
```bash
./setup_auto_detect.sh
```

### Step 3: Answer the prompts
The script will ask:
- **"Where is your DubShorts project?"** → Type the path or just hit Enter if you're already in the project
- Then it will automatically:
  - Check for virtual environment
  - Install Keras-OCR
  - Create detect_and_inpaint.py
  - Update server.js with the new endpoint
  - Create the HTML button snippet

### Step 4: Update index.html manually
The script creates `AUTO_DETECT_BUTTON.html` with the code to add.

**To find where to paste:**

1. In VS Code, open `index.html`
2. Press `Cmd + F` (Find)
3. Search for: `toggles` or `<div class="tog-row">`
4. You'll see something like:
   ```html
   <div class="tog-row">
     <div class="tc" id="removeCard">
       ...
     </div>
   </div>
   ```
5. After the closing `</div class="tog-row">`, add the button from `AUTO_DETECT_BUTTON.html`

**To add the JavaScript:**
1. Press `Cmd + F` again
2. Search for: `function savePreset()` (near the end of the file)
3. Find the final `</script>` tag
4. Just before it, paste the `startAutoDetection()` function from `AUTO_DETECT_BUTTON.html`

### Step 5: Restart your server
In VS Code terminal:
```bash
# Kill current server
Ctrl + C

# Restart
npm start
```

You should see:
```
DubShorts running at http://localhost:3000
```

---

## If You Get Stuck

### "Command not found: ./setup_auto_detect.sh"
Make sure you're in the right directory:
```bash
# List files to confirm
ls -la

# If you see setup_auto_detect.sh, run with full path
/path/to/setup_auto_detect.sh
```

### "Permission denied"
```bash
chmod +x setup_auto_detect.sh
./setup_auto_detect.sh
```

### "venv not found"
The script will create it automatically. If it fails:
```bash
cd /path/to/dubshorts
python3 -m venv venv
source venv/bin/activate
pip install keras-ocr tensorflow opencv-python numpy
```

### "ffmpeg not found"
Install FFmpeg on Mac:
```bash
brew install ffmpeg
```

---

## Manual Setup (If script doesn't work)

### 1. Install dependencies
```bash
cd /path/to/dubshorts
source venv/bin/activate
pip install keras-ocr tensorflow opencv-python numpy
```

### 2. Copy the Python script
Download `detect_and_inpaint.py` and put it in your project root:
```bash
# If you have the file
cp ~/Downloads/detect_and_inpaint.py /path/to/dubshorts/
chmod +x /path/to/dubshorts/detect_and_inpaint.py
```

### 3. Update server.js
- Open `server.js` in VS Code
- Find the line with `app.listen(PORT`
- Just before it, paste the endpoint code from `new_endpoint.js`

### 4. Update index.html
- Open `index.html`
- Find the button section (search for `toggles`)
- Add the button from `AUTO_DETECT_BUTTON.html`
- Add the JavaScript function before `</script>`

### 5. Restart
```bash
npm start
```

---

## Testing It Works

1. Go to http://localhost:3000
2. Upload a video with captions
3. Click **"🤖 Auto-Detect & Remove Captions"**
4. Wait for processing
5. Download the clean video!

---

## File Locations After Setup

```
dubshorts/
├── server.js (UPDATED - has new endpoint)
├── server.js.backup (BACKUP of original)
├── index.html (NEEDS MANUAL UPDATE - add button & function)
├── detect_and_inpaint.py (NEW - runs text detection)
├── inpaint_captions.py (already exists - used for inpainting)
├── venv/
├── AUTO_DETECT_BUTTON.html (reference for manual HTML edits)
└── outputs/
```

---

## Troubleshooting Commands

```bash
# Check if Keras-OCR installed
python -c "import keras_ocr; print('OK')"

# Check if ffmpeg works
ffmpeg -version

# See if detect_and_inpaint.py exists
ls -la detect_and_inpaint.py

# Check server.js was updated (should see remove-captions-auto)
grep "remove-captions-auto" server.js
```

---

## Still Stuck?

In VS Code terminal, run:
```bash
echo "System Info:" && uname -a && echo "" && echo "Python:" && python3 --version && echo "" && echo "Node:" && node -v
```

Share this output if you need help debugging!

🚀 Good luck!
