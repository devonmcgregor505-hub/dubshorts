const axios = require('axios');
const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

class MultiSpeakerDubber {
  constructor(assemblyKey, modelsLabKey) {
    this.assemblyKey = assemblyKey;
    this.modelsLabKey = modelsLabKey;
  }

  async process(videoPath, targetLang) {
    console.log('========== MULTI-SPEAKER DUBBING STARTED ==========');
    
    const timestamp = Date.now();
    const workDir = path.join(__dirname, 'uploads', 'multispeaker_' + timestamp);
    fs.mkdirSync(workDir, { recursive: true });
    
    // Step 1: Extract audio
    const audioPath = path.join(workDir, 'original.mp3');
    this._runFFmpeg(['-i', videoPath, '-vn', '-acodec', 'mp3', audioPath]);
    console.log('✓ Audio extracted');
    
    // Step 2: Get speaker timestamps
    const utterances = await this._getSpeakerTimestamps(audioPath);
    if (!utterances || utterances.length === 0) {
      console.log('No speakers detected, falling back');
      return null;
    }
    
    // Step 3: Group by speaker
    const speakers = this._groupBySpeaker(utterances);
    console.log('✓ Found speakers:', Object.keys(speakers).length);
    
    // Step 4: Dub each segment
    const dubbedSegments = [];
    let segmentCount = 0;
    
    for (const [speakerId, segments] of Object.entries(speakers)) {
      console.log(`  Speaker ${speakerId}: ${segments.length} segments`);
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        segmentCount++;
        console.log(`    Segment ${segmentCount}: "${seg.text.substring(0, 40)}..."`);
        
        const segmentFile = path.join(workDir, `seg_${speakerId}_${i}.mp4`);
        const dubbedFile = path.join(workDir, `dub_${speakerId}_${i}.mp4`);
        
        // Extract segment
        this._runFFmpeg([
          '-i', videoPath,
          '-ss', seg.start.toString(),
          '-t', (seg.end - seg.start).toString(),
          '-c', 'copy',
          segmentFile
        ]);
        
        // Dub segment
        const dubbedData = await this._dubSegment(segmentFile, targetLang);
        fs.writeFileSync(dubbedFile, dubbedData);
        
        dubbedSegments.push({ start: seg.start, end: seg.end, file: dubbedFile });
        try { fs.unlinkSync(segmentFile); } catch(e) {}
      }
    }
    
    // Step 5: Stitch together
    dubbedSegments.sort((a, b) => a.start - b.start);
    const finalVideo = await this._stitchSegments(videoPath, dubbedSegments, workDir);
    
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e) {}
    
    console.log('========== MULTI-SPEAKER DUBBING COMPLETE ==========');
    return finalVideo;
  }

  async _getSpeakerTimestamps(audioPath) {
    const audioBuffer = fs.readFileSync(audioPath);
    const uploadRes = await axios.post('https://api.assemblyai.com/v2/upload', audioBuffer, {
      headers: { 'authorization': this.assemblyKey, 'content-type': 'application/octet-stream' }
    });
    
    const transcriptRes = await axios.post('https://api.assemblyai.com/v2/transcript', {
      audio_url: uploadRes.data.upload_url,
      speaker_labels: true,
      language_code: 'en'
    }, { headers: { 'authorization': this.assemblyKey } });
    
    const transcriptId = transcriptRes.data.id;
    console.log('  AssemblyAI job ID:', transcriptId);
    
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const poll = await axios.get('https://api.assemblyai.com/v2/transcript/' + transcriptId, {
        headers: { 'authorization': this.assemblyKey }
      });
      process.stdout.write(`\r  Polling: ${poll.data.status}...`);
      if (poll.data.status === 'completed') {
        console.log('\n  ✓ AssemblyAI completed');
        return poll.data.utterances || [];
      }
    }
    return [];
  }

  _groupBySpeaker(utterances) {
    const speakers = {};
    utterances.forEach(u => {
      const speaker = u.speaker;
      if (!speakers[speaker]) speakers[speaker] = [];
      speakers[speaker].push({ start: u.start / 1000, end: u.end / 1000, text: u.text });
    });
    return speakers;
  }

  async _dubSegment(segmentPath, targetLang) {
    const { uploadToR2 } = require('./server.js');
    const r2Key = 'seg_' + Date.now() + '_' + Math.random().toString(36) + '.mp4';
    const videoUrl = await uploadToR2(segmentPath, r2Key);
    
    const payload = {
      key: this.modelsLabKey,
      init_video: videoUrl,
      source_lang: 'en',
      output_lang: targetLang,
      speed: 1.0,
      num_speakers: 1,
      file_prefix: 'dub_' + Date.now(),
      base64: false
    };
    
    const dubRes = await axios.post('https://modelslab.com/api/v6/voice/create_dubbing', payload, { timeout: 120000 });
    
    if (dubRes.data.status === 'success' && dubRes.data.output && dubRes.data.output[0]) {
      const dlRes = await axios.get(dubRes.data.output[0], { responseType: 'arraybuffer' });
      return dlRes.data;
    }
    
    if (dubRes.data.status === 'processing' && dubRes.data.fetch_result) {
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const poll = await axios.post(dubRes.data.fetch_result, { key: this.modelsLabKey });
        if (poll.data.status === 'success' && poll.data.output && poll.data.output[0]) {
          const dlRes = await axios.get(poll.data.output[0], { responseType: 'arraybuffer' });
          return dlRes.data;
        }
      }
    }
    throw new Error('Dubbing failed for segment');
  }

  async _stitchSegments(originalVideo, segments, workDir) {
    const outputPath = path.join(workDir, 'final_dubbed.mp4');
    const concatFile = path.join(workDir, 'concat.txt');
    let concatContent = '';
    let lastEnd = 0;
    
    for (const seg of segments) {
      if (seg.start > lastEnd) {
        const betweenFile = path.join(workDir, 'between_' + lastEnd + '_' + seg.start + '.mp4');
        this._runFFmpeg([
          '-i', originalVideo,
          '-ss', lastEnd.toString(),
          '-t', (seg.start - lastEnd).toString(),
          '-c', 'copy',
          betweenFile
        ]);
        concatContent += 'file ' + betweenFile + '\n';
      }
      concatContent += 'file ' + seg.file + '\n';
      lastEnd = seg.end;
    }
    
    const duration = this._getVideoDuration(originalVideo);
    if (lastEnd < duration) {
      const remainingFile = path.join(workDir, 'remaining_' + lastEnd + '_' + duration + '.mp4');
      this._runFFmpeg([
        '-i', originalVideo,
        '-ss', lastEnd.toString(),
        '-t', (duration - lastEnd).toString(),
        '-c', 'copy',
        remainingFile
      ]);
      concatContent += 'file ' + remainingFile + '\n';
    }
    
    fs.writeFileSync(concatFile, concatContent);
    this._runFFmpeg(['-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', outputPath]);
    return outputPath;
  }

  _runFFmpeg(args) {
    const ffmpegPath = require('ffmpeg-static');
    const result = spawnSync(ffmpegPath, args);
    if (result.status !== 0) throw new Error('FFmpeg error: ' + (result.stderr || '').toString());
  }

  _getVideoDuration(videoPath) {
    const result = spawnSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath
    ]);
    return parseFloat(result.stdout.toString());
  }
}

module.exports = { MultiSpeakerDubber };
