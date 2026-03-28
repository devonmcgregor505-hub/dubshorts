content = open('/Users/kanemcgregor/dubshorts/caption-remover/remove_captions.py').read()

# Replace everything after ProPainter runs with simpler output handling
old = '''        if result.returncode != 0:
            raise Exception('ProPainter failed - check terminal output above')

        # Find saved frames
        saved_frames = []
        for root, dirs, files in os.walk(output_dir):
            for f in sorted(files):
                if f.endswith('.png') or f.endswith('.jpg'):
                    saved_frames.append(os.path.join(root, f))

        if not saved_frames:
            raise Exception('ProPainter produced no output frames')

        print(f'Got {len(saved_frames)} output frames')

        # Rename frames sequentially for ffmpeg
        frames_out_dir = os.path.join(tmp, 'final_frames')
        os.makedirs(frames_out_dir)
        for idx, fpath in enumerate(sorted(saved_frames)):
            dst = os.path.join(frames_out_dir, f'{idx+1:05d}.png')
            shutil.copy(fpath, dst)

        # Assemble video from frames
        temp_video = os.path.join(tmp, 'no_audio.mp4')
        print('Assembling video...')
        subprocess.run([
            FFMPEG, '-y',
            '-framerate', str(int(cap_fps)),
            '-i', f'{frames_out_dir}/%05d.png',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
            '-pix_fmt', 'yuv420p',
            temp_video
        ], check=True, capture_output=True)

        # Upscale to 1080p and merge audio
        print('Upscaling to 1080p and merging audio...')
        subprocess.run([
            FFMPEG, '-y',
            '-i', temp_video,
            '-i', video_in,
            '-map', '0:v:0', '-map', '1:a:0',
            '-vf', f'scale={W}:{H}',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
            '-c:a', 'aac', '-shortest',
            video_out
        ], check=True, capture_output=True)'''

new = '''        if result.returncode != 0:
            raise Exception('ProPainter failed - check terminal output above')

        # Find inpaint_out.mp4
        out_video = None
        for root, dirs, files in os.walk(output_dir):
            for f in files:
                if f == 'inpaint_out.mp4':
                    out_video = os.path.join(root, f)

        if not out_video:
            raise Exception('ProPainter produced no output video - inpaint_out.mp4 not found')

        print(f'ProPainter output: {out_video}')

        # Upscale to 1080p and merge audio
        print('Upscaling to 1080p and merging audio...')
        subprocess.run([
            FFMPEG, '-y',
            '-i', out_video,
            '-i', video_in,
            '-map', '0:v:0', '-map', '1:a:0',
            '-vf', f'scale={W}:{H}',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
            '-c:a', 'aac', '-shortest',
            video_out
        ], check=True, capture_output=True)'''

open('/Users/kanemcgregor/dubshorts/caption-remover/remove_captions.py', 'w').write(content.replace(old, new))
print('Done!')
