// Add this function to server.js to detect number of speakers
async function detectSpeakers(videoUrl) {
  try {
    const response = await axios.post('https://api.assemblyai.com/v2/transcript', {
      audio_url: videoUrl,
      speaker_labels: true,
      speech_models: ['universal-2']
    }, {
      headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }
    });
    
    const transcriptId = response.data.id;
    
    // Poll for completion
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const poll = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }
      });
      
      if (poll.data.status === 'completed') {
        const speakers = new Set();
        poll.data.utterances?.forEach(u => speakers.add(u.speaker));
        const speakerCount = speakers.size;
        console.log(`Detected ${speakerCount} speakers:`, Array.from(speakers));
        return speakerCount;
      }
    }
    return 0;
  } catch (err) {
    console.log('Speaker detection failed:', err.message);
    return 0;
  }
}
