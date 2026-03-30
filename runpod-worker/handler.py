import runpod, os, sys, cv2, numpy as np, tempfile, subprocess, shutil, json, base64, requests
import torch
import torch.cuda

def handler(job):
    inp = job["input"]
    box = inp.get("box")  # optional hint box {x,y,w,h} as fractions
    tmp = tempfile.mkdtemp()
    try:
        video_in = os.path.join(tmp, "input.mp4")
        if inp.get("video_base64"):
            open(video_in, "wb").write(base64.b64decode(inp["video_base64"]))
        else:
            return {"error": "No video"}

        # Get video info
        probe = subprocess.run(["ffprobe","-v","quiet","-print_format","json","-show_streams",video_in], capture_output=True, text=True)
        info = json.loads(probe.stdout)
        fps, W, H = 30.0, 1080, 1920
        for s in info["streams"]:
            if s["codec_type"] == "video":
                n,d = s.get("r_frame_rate","30/1").split("/")
                fps=float(n)/float(d); W=int(s["width"]); H=int(s["height"]); break
        cap_fps = min(fps, 30)

        # Extract frames at 540p
        ff = os.path.join(tmp, "frames")
        os.makedirs(ff)
        sW, sH = 960, 540
        subprocess.run(["ffmpeg","-y","-i",video_in,"-vf",f"fps={cap_fps},scale={sW}:{sH}",f"{ff}/%05d.png"], check=True, capture_output=True)
        frames = sorted([f for f in os.listdir(ff) if f.endswith(".png")])
        print(f"Extracted {len(frames)} frames at {sW}x{sH}")

        # Compute hint box in 540p pixel space
        hint = None
        if box:
            hx1 = max(0, int(box["x"] * sW))
            hy1 = max(0, int(box["y"] * sH))
            hx2 = min(sW, int((box["x"] + box["w"]) * sW))
            hy2 = min(sH, int((box["y"] + box["h"]) * sH))
            hint = (hx1, hy1, hx2, hy2)
            print(f"Hint box: {hint}")

        # Run EasyOCR on sample frames to find caption regions
        print("Running EasyOCR detection...")
        import easyocr
        reader = easyocr.Reader(['en'], gpu=torch.cuda.is_available())

        # Sample every 10th frame for detection
        sample_frames = frames[::10][:20]
        all_boxes = []
        for fname in sample_frames:
            img = cv2.imread(os.path.join(ff, fname))
            if hint:
                # Only scan within hint region (faster + more accurate)
                roi = img[hy1:hy2, hx1:hx2]
                if roi.size == 0:
                    results = reader.readtext(img)
                else:
                    results = reader.readtext(roi)
                for (coords, text, conf) in results:
                    if conf > 0.3:
                        xs = [int(c[0]) + hx1 for c in coords]
                        ys = [int(c[1]) + hy1 for c in coords]
                        all_boxes.append((min(xs), min(ys), max(xs), max(ys)))
            else:
                results = reader.readtext(img)
                for (coords, text, conf) in results:
                    if conf > 0.3:
                        xs = [int(c[0]) for c in coords]
                        ys = [int(c[1]) for c in coords]
                        all_boxes.append((min(xs), min(ys), max(xs), max(ys)))

        if not all_boxes:
            # Fall back to hint box if no text detected
            if hint:
                all_boxes = [hint]
            else:
                return {"error": "No captions detected"}

        # Merge all detected boxes into one region + padding
        pad = 8
        rx1 = max(0, min(b[0] for b in all_boxes) - pad)
        ry1 = max(0, min(b[1] for b in all_boxes) - pad)
        rx2 = min(sW, max(b[2] for b in all_boxes) + pad)
        ry2 = min(sH, max(b[3] for b in all_boxes) + pad)
        print(f"Caption region: ({rx1},{ry1},{rx2},{ry2})")

        # Build mask for every frame
        mask_img = np.zeros((sH, sW), dtype=np.uint8)
        mask_img[ry1:ry2, rx1:rx2] = 255
        mask_img = cv2.dilate(mask_img, np.ones((6,6), np.uint8), iterations=2)

        # Run LaMa inpainting frame by frame
        print("Running LaMa inpainting...")
        sys.path.insert(0, "/app/lama")
        from saicinpainting.evaluation.utils import move_to_device
        from saicinpainting.evaluation.refinement import refine_predict
        from omegaconf import OmegaConf
        from torch.utils.data._utils.collate import default_collate

        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        print(f"Using device: {device}")

        train_config_path = "/app/lama/configs/prediction/default.yaml"
        config = OmegaConf.load(train_config_path)
        config.model.path = "/app/lama_weights/big-lama"
        config.dataset.pad_out_to_modulo = 8

        from saicinpainting.training.trainers import load_checkpoint
        model = load_checkpoint(config, "/app/lama_weights/big-lama/models/best.ckpt", strict=False, map_location=device)
        model.freeze()
        model.to(device)

        out_dir = os.path.join(tmp, "inpainted")
        os.makedirs(out_dir)

        mask_3ch = cv2.cvtColor(mask_img, cv2.COLOR_GRAY2RGB)

        for fname in frames:
            img = cv2.imread(os.path.join(ff, fname))
            img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
            mask_f = mask_img.astype(np.float32) / 255.0

            batch = {
                "image": torch.from_numpy(img_rgb).permute(2,0,1).unsqueeze(0).to(device),
                "mask": torch.from_numpy(mask_f).unsqueeze(0).unsqueeze(0).to(device),
            }
            with torch.no_grad():
                result = model(batch)
            out = result["inpainted"][0].permute(1,2,0).cpu().numpy()
            out = (out * 255).clip(0,255).astype(np.uint8)
            out_bgr = cv2.cvtColor(out, cv2.COLOR_RGB2BGR)
            cv2.imwrite(os.path.join(out_dir, fname), out_bgr)

        print("Assembling output video...")
        tv = os.path.join(tmp, "tmp.mp4")
        vo = os.path.join(tmp, "out.mp4")
        subprocess.run(["ffmpeg","-y","-framerate",str(int(cap_fps)),"-i",f"{out_dir}/%05d.png","-vf","scale=1080:1920","-c:v","libx264","-preset","fast","-crf","18","-pix_fmt","yuv420p",tv], check=True, capture_output=True)
        subprocess.run(["ffmpeg","-y","-i",tv,"-i",video_in,"-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac","-shortest",vo], check=True, capture_output=True)

        return {"video_base64": base64.b64encode(open(vo,"rb").read()).decode()}

    except Exception as e:
        import traceback
        return {"error": str(e) + "\n" + traceback.format_exc()}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

runpod.serverless.start({"handler": handler})
