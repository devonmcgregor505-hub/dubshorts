#!/bin/bash
echo "🔧 Fixing DubShorts caption burning..."

# Fix 1: Update burn_captions.py to match preview exactly
cat > ~/dubshorts/burn_captions.py << 'PYEOF'
#!/usr/bin/env python3
"""
Burn captions with EXACT preview matching
Uses the same rendering logic as the frontend canvas preview
"""
import cv2
import json
import sys
import numpy as np
import math

def hex_to_bgr(hex_color):
    """Convert hex color to BGR for OpenCV"""
    hex_color = hex_color.lstrip('#')
    if len(hex_color) == 6:
        return tuple(int(hex_color[i:i+2], 16) for i in (4, 2, 0))
    return (255, 255, 255)

def draw_text_with_outline(img, text, x, y, font_scale, thickness, color, outline_color, outline_thickness, shadow_size=0):
    """Draw text with outline matching frontend preview"""
    # Apply shadow if enabled
    if shadow_size > 0:
        shadow_offset = int(shadow_size * font_scale * 0.3)
        cv2.putText(img, text, (x + shadow_offset, y + shadow_offset), 
                   cv2.FONT_HERSHEY_DUPLEX, font_scale, (0, 0, 0), 
                   thickness + 1, cv2.LINE_AA)
    
    # Draw outline
    if outline_thickness > 0:
        cv2.putText(img, text, (x, y), cv2.FONT_HERSHEY_DUPLEX, font_scale, 
                   outline_color, outline_thickness, cv2.LINE_AA)
    
    # Draw main text
    cv2.putText(img, text, (x, y), cv2.FONT_HERSHEY_DUPLEX, font_scale, 
               color, thickness, cv2.LINE_AA)

def burn_captions(input_video, output_video, cues, style):
    """Burn captions matching frontend preview exactly"""
    
    cap = cv2.VideoCapture(input_video)
    if not cap.isOpened():
        print(f"Error: Cannot open video {input_video}")
        return False
    
    # Get video properties
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    print(f"Video: {width}x{height}, {fps}fps, {total_frames} frames")
    
    # Parse style with defaults matching frontend
    y_pct = style.get('yPct', 70) / 100
    font_size_pct = style.get('fontSize', 4) / 100  # 4% default
    font_scale = max(0.5, (height * font_size_pct) / 30)
    
    text_color = hex_to_bgr(style.get('textColor', '#ffffff'))
    outline_color = hex_to_bgr(style.get('outlineColor', '#000000'))
    highlight_color = hex_to_bgr(style.get('highlightColor', '#f5e132'))
    
    outline_width_pct = style.get('outlineWidth', 15) / 100
    outline_thickness = max(1, int(font_scale * outline_width_pct * 3))
    text_thickness = max(1, outline_thickness - 1)
    
    text_style = style.get('textStyle', 'bold')
    text_case = style.get('textCase', 'upper')
    caption_mode = style.get('captionMode', 'single')
    shadow_size = style.get('shadowSize', 0)  # 0-1 range
    
    print(f"Style: mode={caption_mode}, y={int(y_pct*100)}%, font_size={font_size_pct*100}%, shadow={shadow_size}")
    
    # Calculate position
    y_pos = int(height * y_pct)
    
    # Setup video writer
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(output_video, fourcc, fps, (width, height))
    
    frame_count = 0
    print(f"Processing {total_frames} frames...")
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        current_time = frame_count / fps
        
        # Find current caption
        current_cue = None
        for cue in cues:
            if cue['start'] <= current_time < cue['end']:
                current_cue = cue
                break
        
        if current_cue:
            text = current_cue['text']
            
            # Apply text case (matching frontend)
            if text_case == 'upper':
                text = text.upper()
            elif text_case == 'lower':
                text = text.lower()
            
            if caption_mode == 'single':
                # Single word/line mode - exactly like preview
                (text_width, text_height), baseline = cv2.getTextSize(text, cv2.FONT_HERSHEY_DUPLEX, 
                                                                      font_scale, text_thickness)
                text_x = (width - text_width) // 2
                text_y = y_pos
                
                draw_text_with_outline(frame, text, text_x, text_y, font_scale, text_thickness,
                                      text_color, outline_color, outline_thickness, shadow_size)
                
            else:
                # Multi-word mode - split into words and position individually
                words = text.split()
                if not words:
                    continue
                
                # Calculate total width to center the entire phrase
                total_width = 0
                word_widths = []
                for word in words:
                    (w_w, _), _ = cv2.getTextSize(word + ' ', cv2.FONT_HERSHEY_DUPLEX, font_scale, text_thickness)
                    word_widths.append(w_w)
                    total_width += w_w
                
                # Start position for centered text
                current_x = (width - total_width) // 2
                
                for i, word in enumerate(words):
                    # Determine color for this word (highlight mode)
                    if caption_mode == 'highlight' and len(words) > 1:
                        # Highlight middle word (like frontend preview)
                        mid_index = len(words) // 2
                        word_color = highlight_color if i == mid_index else text_color
                    else:
                        word_color = text_color
                    
                    # Position this word
                    word_x = current_x
                    word_y = y_pos
                    
                    # Draw word with its own outline
                    draw_text_with_outline(frame, word, word_x, word_y, font_scale, text_thickness,
                                          word_color, outline_color, outline_thickness, shadow_size)
                    
                    # Move to next word position
                    current_x += word_widths[i]
        
        out.write(frame)
        frame_count += 1
        
        if frame_count % 50 == 0:
            print(f"Processed {frame_count}/{total_frames} frames")
    
    cap.release()
    out.release()
    print(f"✅ Completed! Saved to {output_video}")
    return True

if __name__ == "__main__":
    if len(sys.argv) != 5:
        print("Usage: python burn_captions.py <input_video> <output_video> <cues_json> <style_json>")
        sys.exit(1)
    
    input_video = sys.argv[1]
    output_video = sys.argv[2]
    cues = json.loads(sys.argv[3])
    style = json.loads(sys.argv[4])
    
    success = burn_captions(input_video, output_video, cues, style)
    sys.exit(0 if success else 1)
PYEOF

# Fix 2: Update the caption burning section in server.js
cat > ~/dubshorts/fix_server_captions.js << 'JSEOF'
// === REPLACE THE CAPTION BURNING SECTION IN server.js ===
// Look for the section that calls burn_captions.py and replace with this:

/*
FIND in server.js the part that does:
const pyResult = spawnSync('python3', [
  path.join(__dirname, 'burn_captions.py'),
  burnSource, captionedPath,
  JSON.stringify(cues), JSON.stringify(scaledStyle)
]);

REPLACE that entire block with this:
*/

// Burn captions with EXACT preview matching
if (cues.length > 0 && req.body.addCaption === 'true') {
  console.log('Burning captions with exact preview matching...');
  console.log('Style received:', JSON.stringify(captionStyle));
  
  // Prepare style with all frontend values
  const burnStyle = {
    yPct: captionStyle?.yPct ?? 70,
    fontSize: captionStyle?.fontSize ?? 4,
    textColor: captionStyle?.textColor ?? '#ffffff',
    outlineColor: captionStyle?.outlineColor ?? '#000000',
    outlineWidth: captionStyle?.outlineWidth ?? 15,
    textStyle: captionStyle?.textStyle ?? 'bold',
    textCase: captionStyle?.textCase ?? 'upper',
    captionMode: captionStyle?.captionMode ?? 'single',
    highlightColor: captionStyle?.highlightColor ?? '#f5e132',
    shadowSize: captionStyle?.shadowSize ?? 0
  };
  
  console.log('Burn style:', JSON.stringify(burnStyle));
  
  const pyResult = spawnSync('python3', [
    path.join(__dirname, 'burn_captions.py'),
    videoSource,  // Use the dubbed video directly
    captionedPath,
    JSON.stringify(cues),
    JSON.stringify(burnStyle)
  ], { encoding: 'utf8', timeout: 300000, maxBuffer: 100 * 1024 * 1024 });
  
  console.log('Python stdout:', pyResult.stdout?.slice(-500) || '');
  if (pyResult.stderr) console.log('Python stderr:', pyResult.stderr?.slice(-300) || '');
  
  if (pyResult.status === 0 && fs.existsSync(captionedPath) && fs.statSync(captionedPath).size > 10000) {
    console.log('✅ Captions burned successfully!');
    videoForMerge = captionedPath;
  } else {
    console.log('⚠️ Caption burning failed, using video without captions');
    if (fs.existsSync(captionedPath)) fs.unlinkSync(captionedPath);
  }
}

JSEOF

echo "✅ Fix files created!"
echo ""
echo "📋 NEXT STEPS:"
echo "1. Open server.js and find the caption burning section"
echo "2. Replace it with the code in fix_server_captions.js"
echo "3. Or run this command to auto-apply:"
echo ""
echo "cd ~/dubshorts && cp burn_captions.py burn_captions.py.backup && python3 -c \"\$(cat fix_captions.sh | grep -A 1000 'PYEOF' | tail -n +2 | head -n -1)\" > burn_captions.py"
echo ""
echo "4. Then restart the server:"
echo "lsof -ti:3000 | xargs kill -9 2>/dev/null; cd ~/dubshorts && node server.js"

