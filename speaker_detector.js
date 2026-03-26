const axios = require('axios');
const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

async function detectSpeakers(videoPath, assemblyKey) {
  console.log('🎤 Step 1: Detecting speakers with AssemblyAI...');
  
  // Extract audio from video
  const audioPath = videoPath.replace('.mp4', '_temp_audio.mp3');
  spawnSync('ffmpeg', ['-i', videoPath, '-vn', '-acodec', 'mp3', audioPath]);
  
  // Upload to AssemblyAI
  const audioBuffer = fs.readFileSync(audioPath);
  const uploadRes = await axios.post('https://api.assemblyai.com/v2/upload', audioBuffer, {
    headers: { 'authorization': assemblyKey, 'content-type': 'application/octet-stream' }
  });
  
  // Create transcript with speaker labels
  const transcriptRes = await axios.post('https://api.assemblyai.com/v2/transcript', {
    audio_url: uploadRes.data.upload_url,
    speaker_labels: true,
    language_code: 'en'
  }, {
    headers: { 'authorization': assemblyKey }
  });
  
  const transcriptId = transcriptRes.data.id;
  console.log('📝 Transcript ID:', transcriptId);
  
  // Poll for completion
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const poll = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
      headers: { 'authorization': assemblyKey }
    });
    
    console.log(`Poll ${i+1}/60: ${poll.data.status}`);
    
    if (poll.data.status === 'completed') {
      const utterances = poll.data.utterances || [];
      console.log(`✅ Found ${utterances.length} utterances from ${getUniqueSpeakers(utterances).length} speakers`);
      
      // Clean up temp audio
      try { fs.unlinkSync(audioPath); } catch(e) {}
      
      return utterances;
    }
  }
  
  throw new Error('AssemblyAI transcription timed out');
}

function getUniqueSpeakers(utterances) {
  const speakers = new Set();
  utterances.forEach(u => speakers.add(u.speaker));
  return Array.from(speakers);
}

module.exports = { detectSpeakers };
