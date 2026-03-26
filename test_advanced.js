const axios = require('axios');
require('dotenv').config();

const apiKey = process.env.MODELSLAB_API_KEY;

async function testAdvanced() {
  const payload = {
    key: apiKey,
    video_url: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    source_lang: 'en',
    target_lang: 'es',
    speakers: 2,  // Different parameter name
    voice_preservation: true,
    mode: 'multi_speaker'
  };
  
  // Try different endpoint
  const endpoints = [
    'https://modelslab.com/api/v6/voice/multi_speaker_dubbing',
    'https://modelslab.com/api/v6/voice/advanced_dubbing',
    'https://modelslab.com/api/v6/voice/dubbing_v2'
  ];
  
  for (const endpoint of endpoints) {
    console.log(`\n📡 Testing: ${endpoint}`);
    try {
      const res = await axios.post(endpoint, payload, { timeout: 30000 });
      console.log(`   ✅ Response:`, res.data.status);
    } catch(err) {
      console.log(`   ❌ Error: ${err.response?.status || err.message}`);
    }
  }
}

testAdvanced();
