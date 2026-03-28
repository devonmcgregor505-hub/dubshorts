#!/usr/bin/env python3
"""
Hybrid Text Detection + LaMa Inpainting
User draws box, OCR detects text ONLY within that box (much faster!)
"""

import sys, json, subprocess, os, shutil
try:
    import keras_ocr
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "keras-ocr", "-q"])
    import keras_ocr

import cv2
import numpy as np

def extract_frames(video_path, output_dir, max_frames=3):
    """Extract fewer frames for speed"""
    os.makedirs(output_dir, exist_ok=True)
    cmd = ['ffmpeg', '-i', video_path, '-vf', 'fps=1/10', '-q:v', '2', 
           os.path.join(output_dir, 'frame_%04d.jpg')]
    subprocess.run(cmd, capture_output=True, check=True)
    frames = sorted([f for f in os.listdir(output_dir) if f.endswith('.jpg')])[:max_frames]
    return [os.path.join(output_dir, f) for f in frames]

def crop_to_box(image, box):
    """Crop image to the user-drawn box"""
    h, w = image.shape[:2]
    x = int(box['x'] * w)
    y = int(box['y'] * h)
    bw = int(box['w'] * w)
    bh = int(box['h'] * h)
    
    # Add padding for safety
    padding = 10
    x = max(0, x - padding)
    y = max(0, y - padding)
    bw = min(w - x, bw + padding * 2)
    bh = min(h - y, bh + padding * 2)
    
    cropped = image[y:y+bh, x:x+bw]
    return cropped, (x, y, bw, bh)

def detect_text_in_box(frame_paths, user_box):
    """Detect text ONLY within user-drawn box (super fast!)"""
    print("Loading Keras-OCR...")
    pipeline = keras_ocr.pipeline.Pipeline()
    
    results = []
    for i, frame_path in enumerate(frame_paths):
        print(f"Detecting text in frame {i+1}/{len(frame_paths)}...")
        try:
            image = keras_ocr.tools.read(frame_path)
            
            # Crop to user's box
            cropped, (crop_x, crop_y, crop_w, crop_h) = crop_to_box(image, user_box)
            
            # Detect only in cropped area
            predictions = pipeline.recognize([cropped])
            
            boxes = []
            for word_pred, box_pred in predictions[0]:
                if len(box_pred) == 4:
                    points = box_pred
                    x_min = min(p[0] for p in points)
                    y_min = min(p[1] for p in points)
                    x_max = max(p[0] for p in points)
                    y_max = max(p[1] for p in points)
                    
                    # Convert back to full image coordinates
                    h_crop, w_crop = cropped.shape[:2]
                    h_full, w_full = image.shape[:2]
                    
                    box = {
                        'x': (crop_x + x_min) / w_full,
                        'y': (crop_y + y_min) / h_full,
                        'w': (x_max - x_min) / w_full,
                        'h': (y_max - y_min) / h_full,
                        'text': word_pred
                    }
                    
                    # Keep within bounds
                    box['x'] = max(0, min(1, box['x']))
                    box['y'] = max(0, min(1, box['y']))
                    box['w'] = min(1 - box['x'], box['w'])
                    box['h'] = min(1 - box['y'], box['h'])
                    
                    boxes.append(box)
            
            results.append((frame_path, boxes))
            print(f"  ✓ Found {len(boxes)} text regions")
            del image
            del cropped
            
        except Exception as e:
            print(f"  ⚠ Skipping: {str(e)[:50]}")
            results.append((frame_path, []))
    
    return results

def merge_boxes(detected_boxes, user_box, padding=0.03):
    """Merge detected boxes with user box as fallback"""
    if not detected_boxes:
        # If no text detected, use user's box as fallback
        return user_box
    
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

def inpaint_video_with_lama(video_in, video_out, inpaint_box):
    """Inpaint video with the detected/merged box"""
    python_path = os.path.join(os.path.dirname(__file__), 'venv/bin/python')
    script_path = os.path.join(os.path.dirname(__file__), 'inpaint_captions.py')
    
    print(f"Inpainting region: x={inpaint_box['x']:.3f}, y={inpaint_box['y']:.3f}, w={inpaint_box['w']:.3f}, h={inpaint_box['h']:.3f}")
    print("Starting inpainting (1-2 minutes)...")
    
    result = subprocess.run(
        [python_path, script_path, video_in, video_out, json.dumps(inpaint_box)],
        timeout=600,
        capture_output=True
    )
    
    if result.returncode != 0:
        raise Exception(f"Inpainting failed: {result.stderr.decode()[-300:]}")
    
    print("✓ Inpainting complete!")

def main():
    if len(sys.argv) < 4:
        print("Usage: python detect_and_inpaint_hybrid.py <video_in> <video_out> <user_box_json>")
        sys.exit(1)
    
    video_in = sys.argv[1]
    video_out = sys.argv[2]
    user_box = json.loads(sys.argv[3])
    
    work_dir = '/tmp/text_detection_' + str(os.getpid())
    
    try:
        print(f"Input: {video_in}")
        print(f"User box: x={user_box['x']:.3f}, y={user_box['y']:.3f}, w={user_box['w']:.3f}, h={user_box['h']:.3f}\n")
        
        # Step 1: Extract key frames
        print("[Step 1/3] Extracting frames...")
        frame_paths = extract_frames(video_in, work_dir, max_frames=3)
        
        if not frame_paths:
            print("No frames extracted. Copying video...")
            subprocess.run(['cp', video_in, video_out], check=True)
            return
        
        print(f"Extracted {len(frame_paths)} frames\n")
        
        # Step 2: Detect text WITHIN user's box
        print("[Step 2/3] Detecting text within your box...")
        detection_results = detect_text_in_box(frame_paths, user_box)
        
        all_boxes = []
        for frame_path, boxes in detection_results:
            all_boxes.extend(boxes)
        
        if all_boxes:
            print(f"\nFound {len(all_boxes)} text regions within your box\n")
        else:
            print("No text detected in that area. Using your box as-is.\n")
        
        # Step 3: Merge boxes and inpaint
        print("[Step 3/3] Inpainting video...")
        inpaint_box = merge_boxes(all_boxes, user_box, padding=0.03)
        inpaint_video_with_lama(video_in, video_out, inpaint_box)
        
        print("\n✓ All done!")
        
    except subprocess.TimeoutExpired:
        print("\n✗ Inpainting timed out")
        sys.exit(1)
        
    except Exception as e:
        print(f"\n✗ Error: {str(e)}")
        sys.exit(1)
        
    finally:
        if os.path.exists(work_dir):
            shutil.rmtree(work_dir, ignore_errors=True)

if __name__ == '__main__':
    main()
