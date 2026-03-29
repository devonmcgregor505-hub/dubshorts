import runpod, os, sys, cv2, numpy as np, tempfile, subprocess, shutil, json, base64, requests
sys.path.insert(0, "/app/ProPainter")

def handler(job):
    inp = job["input"]
    box = inp.get("box")
    if not box: return {"error": "No box"}
    tmp = tempfile.mkdtemp()
    try:
        video_in = os.path.join(tmp, "input.mp4")
        if inp.get("video_url"):
            r = requests.get(inp["video_url"], timeout=300)
            open(video_in, "wb").write(r.content)
        elif inp.get("video_base64"):
            open(video_in, "wb").write(base64.b64decode(inp["video_base64"]))
        else: return {"error": "No video"}

        probe = subprocess.run(["ffprobe","-v","quiet","-print_format","json","-show_streams",video_in], capture_output=True, text=True)
        info = json.loads(probe.stdout)
        fps, W, H = 30.0, 1080, 1920
        for s in info["streams"]:
            if s["codec_type"] == "video":
                n,d = s.get("r_frame_rate","30/1").split("/"); fps=float(n)/float(d); W=int(s["width"]); H=int(s["height"]); break
        cap_fps = min(fps, 30)
        x1,y1,x2,y2 = max(0,int(box["x"]*W)),max(0,int(box["y"]*H)),min(W,int((box["x"]+box["w"])*W)),min(H,int((box["y"]+box["h"])*H))
        p=20; rx1,ry1,rx2,ry2=max(0,x1-p),max(0,y1-p),min(W,x2+p),min(H,y2+p); rW,rH=rx2-rx1,ry2-ry1
        ff,cf,md,od,fd,ind = [os.path.join(tmp,x) for x in ["ff","cf","md","od","fd","ind"]]
        for d in [ff,cf,md,od,fd,ind]: os.makedirs(d)
        subprocess.run(["ffmpeg","-y","-i",video_in,"-vf",f"fps={cap_fps}",f"{ff}/%05d.png"], check=True, capture_output=True)
        frames = sorted([f for f in os.listdir(ff) if f.endswith(".png")])
        scale=0.5; cW,cH=int(rW*scale),int(rH*scale)
        cW=cW+(8-cW%8) if cW%8 else cW; cH=cH+(8-cH%8) if cH%8 else cH
        mx1,my1,mx2,my2=max(0,int((x1-rx1)*scale)),max(0,int((y1-ry1)*scale)),min(cW,int((x2-rx1)*scale)),min(cH,int((y2-ry1)*scale))
        mask=np.zeros((cH,cW),dtype=np.uint8); mask[my1:my2,mx1:mx2]=255
        mask=cv2.dilate(mask,np.ones((8,8),np.uint8),iterations=1)
        for fname in frames:
            frame=cv2.imread(os.path.join(ff,fname)); crop=frame[ry1:ry2,rx1:rx2]
            cv2.imwrite(os.path.join(cf,fname),cv2.resize(crop,(cW,cH),interpolation=cv2.INTER_AREA))
            cv2.imwrite(os.path.join(md,fname),mask)
        subprocess.run([sys.executable,"/app/ProPainter/inference_propainter.py","-i",cf,"-m",md,"-o",od,"--save_fps",str(int(cap_fps)),"--subvideo_length","80","--neighbor_length","10","--ref_stride","10","--fp16"], check=True, cwd="/app/ProPainter")
        out_video=next((os.path.join(r,f) for r,ds,fs in os.walk(od) for f in fs if f=="inpaint_out.mp4"),None)
        if not out_video: return {"error": "No output"}
        subprocess.run(["ffmpeg","-y","-i",out_video,f"{ind}/%05d.png"], check=True, capture_output=True)
        inpainted=sorted([f for f in os.listdir(ind) if f.endswith(".png")])
        for i,fname in enumerate(frames):
            frame=cv2.imread(os.path.join(ff,fname))
            if i<len(inpainted):
                inp2=cv2.imread(os.path.join(ind,inpainted[i])); frame[ry1:ry2,rx1:rx2]=cv2.resize(inp2,(rW,rH),interpolation=cv2.INTER_LANCZOS4)
            cv2.imwrite(os.path.join(fd,fname),frame)
        tv=os.path.join(tmp,"tmp.mp4"); vo=os.path.join(tmp,"out.mp4")
        subprocess.run(["ffmpeg","-y","-framerate",str(int(cap_fps)),"-i",f"{fd}/%05d.png","-c:v","libx264","-preset","fast","-crf","18","-pix_fmt","yuv420p",tv], check=True, capture_output=True)
        subprocess.run(["ffmpeg","-y","-i",tv,"-i",video_in,"-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac","-shortest",vo], check=True, capture_output=True)
        return {"video_base64": base64.b64encode(open(vo,"rb").read()).decode()}
    except Exception as e: return {"error": str(e)}
    finally: shutil.rmtree(tmp, ignore_errors=True)

runpod.serverless.start({"handler": handler})
