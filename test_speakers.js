const axios = require('axios');
const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

async function testSpeakerDetection() {
  console.log('Testing AssemblyAI speaker detection...\n');
  
  // Find a test video in uploads folder
  const uploadsDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    console.log('No uploads folder found');
    return;
  }
  
  const files = fs.readdirSync(uploadsDir).filter(f => f.endsWith('.mp4'));
  
  if (files.length === 0) {
    console.log('No video found in uploads/ folder');
    console.log('Please upload a video first via the UI');
    return;
  }
  
  const testVideo = path.join(uploadsDir, files[0]);
  console.log('Test video:', files[0]);
  
  // Extract audio
  console.log('Extracting audio...');
  const audioPath = testVideo.replace('.mp4', '_test_audio.mp3');
  spawnSync('ffmpeg', ['-i', testVideo, '-vn', '-acodec', 'mp3', audioPath]);
  
  // Upload to AssemblyAI
  console.log('Uploading to AssemblyAI...');
  const audioBuffer = fs.readFileSync(audioPath);
  const uploadRes = await axios.post('https://api.assemblyai.com/v2/upload', audioBuffer, {
    headers: { 
      'authorization': process.env.ASSEMBLYAI_API_KEY, 
      'content-type': 'application/octet-stream' 
    }
  });
  
  // Create transcript with speaker labels
  console.log('Creating transcript...');
  const transcriptRes = await axios.post('https://api.assemblyai.com/v2/transcript', {
    audio_url: uploadRes.data.upload_url,
    speaker_labels: true,
    language_code: 'en'
  }, {
    headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }
  });
  
  const transcriptId = transcriptRes.data.id;
  console.log('Transcript ID:', transcriptId);
  
  // Poll for completion
  console.log('Waiting for AssemblyAI...');
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const poll = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
      headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }
    });
    
    console.log(`Poll ${i+1}: ${poll.data.status}`);
    
    if (poll.data.status === 'completed') {
      const utterances = poll.data.utterances || [];
      console.log('\n✅ SUCCESS! Found', utterances.length, 'utterances');
      
      // Group by speaker
      const speakers = {};
      for (let u of utterances) {
        const speaker = u.speaker;
        if (!speakers[speaker]) speakers[speaker] = [];
        speakers[speaker].push({
          start: (u.start / 1000).toFixed(2),
          end: (u.end / 1000).toFixed(2),
          text: u.text
        });
      }
      
      console.log('\nSpeakers detected:', Object.keys(speakers).length);
      console.log('----------------------------------------');
      
      for (const speaker in speakers) {
        console.log(`\nSpeaker ${speaker}:`);
        for (let seg of speakers[speaker]) {
          console.log(`  ${seg.start}s - ${seg.end}s: "${seg.text}"`);
        }
      }
      
      try { fs.unlinkSync(audioPath); } catch(e) {}
      return;
    }
  }
  
  console.log('Timeout - AssemblyAI took too long');
  try { fs.unlinkSync(audioPath); } catch(e) {}
}

testSpeakerDetection().catch(err => {
  console.error('Error:', err.message);
  if (err.response) {
    console.error('API Error:', JSON.stringify(err.response.data, null, 2));
  }
});
