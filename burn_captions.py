#!/usr/bin/env python3
"""
Burn captions that EXACTLY match the frontend preview
Uses the same rendering logic as the canvas preview in index.html
"""
import cv2
import json
import sys
import numpy as np

def hex_to_bgr(hex_color):
    """Convert hex color to BGR for OpenCV"""
    hex_color = hex_color.lstrip('#')
    if len(hex_color) == 6:
        return tuple(int(hex_color[i:i+2], 16) for i in (4, 2, 0))
    return (255, 255, 255)

def draw_text_with_outline(img, text, x, y, font_scale, thickness, color, outline_color, outline_thickness, shadow_size=0):
    """Draw text with outline - matching frontend canvas preview exactly"""
    font = cv2.FONT_HERSHEY_DUPLEX
    
    # Draw shadow if enabled (like frontend)
    if shadow_size > 0:
        shadow_offset = int(shadow_size * font_scale * 0.3)
        cv2.putText(img, text, (x + shadow_offset, y + shadow_offset), font, font_scale, 
                   (0, 0, 0), thickness + 1, cv2.LINE_AA)
    
    # Draw outline
    if outline_thickness > 0:
        cv2.putText(img, text, (x, y), font, font_scale, outline_color, outline_thickness, cv2.LINE_AA)
    
    # Draw main text
    cv2.putText(img, text, (x, y), font, font_scale, color, thickness, cv2.LINE_AA)

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
    
    # Parse style - MATCHING FRONTEND DEFAULTS
    y_pct = style.get('yPct', 70) / 100
    font_size_pct = style.get('fontSize', 4) / 100  # 4% like frontend
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
    print(f"Colors: text={style.get('textColor')}, outline={style.get('outlineColor')}, highlight={style.get('highlightColor')}")
    
    # Calculate Y position
    y_pos = int(height * y_pct)
    
    # Setup video writer
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(output_video, fourcc, fps, (width, height))
    
    frame_count = 0
    print(f"Processing frames...")
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        current_time = frame_count / fps
        
        # Find current cue
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
                # SINGLE WORD MODE - exactly like frontend preview
                # Get text size for centering
                (text_width, text_height), baseline = cv2.getTextSize(text, cv2.FONT_HERSHEY_DUPLEX, 
                                                                      font_scale, text_thickness)
                text_x = (width - text_width) // 2
                text_y = y_pos
                
                draw_text_with_outline(frame, text, text_x, text_y, font_scale, text_thickness,
                                      text_color, outline_color, outline_thickness, shadow_size)
                
            else:
                # MULTI-WORD MODE - split into words like frontend preview
                words = text.split()
                if not words:
                    continue
                
                # Calculate word widths
                word_widths = []
                for word in words:
                    (w_w, _), _ = cv2.getTextSize(word + ' ', cv2.FONT_HERSHEY_DUPLEX, font_scale, text_thickness)
                    word_widths.append(w_w)
                
                # Calculate total width to center the entire phrase
                total_width = sum(word_widths)
                current_x = (width - total_width) // 2
                
                # Determine which word to highlight (middle word, like frontend)
                mid_index = len(words) // 2 if caption_mode == 'highlight' else -1
                
                for i, word in enumerate(words):
                    # Choose color based on highlight mode
                    if caption_mode == 'highlight' and i == mid_index:
                        word_color = highlight_color
                    else:
                        word_color = text_color
                    
                    draw_text_with_outline(frame, word, current_x, y_pos, font_scale, text_thickness,
                                          word_color, outline_color, outline_thickness, shadow_size)
                    
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
