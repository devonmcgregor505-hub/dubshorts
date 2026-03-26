const axios = require('axios');
require('dotenv').config();

const apiKey = process.env.MODELSLAB_API_KEY;
const testVideo = 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4';

// Test different configurations
const configs = [
  { name: "Config 1: num_speakers=2", payload: { num_speakers: 2 } },
  { name: "Config 2: num_speakers=0 (auto)", payload: { num_speakers: 0 } },
  { name: "Config 3: with speaker_detection", payload: { num_speakers: 0, speaker_detection: "auto" } },
  { name: "Config 4: with diarization", payload: { num_speakers: 0, diarization: true } },
  { name: "Config 5: multi_speaker flag", payload: { num_speakers: 2, multi_speaker: true } },
  { name: "Config 6: preserve voices", payload: { num_speakers: 0, preserve_voices: true } },
  { name: "Config 7: speaker_count", payload: { speaker_count: 2 } },
  { name: "Config 8: separate_voices", payload: { separate_voices: true, num_speakers: 2 } }
];

async function testConfig(config) {
  console.log(`\n📝 Testing: ${config.name}`);
  
  const payload = {
    key: apiKey,
    init_video: testVideo,
    source_lang: 'en',
    output_lang: 'es',
    speed: 1.0,
    ...config.payload
  };
  
  try {
    const res = await axios.post('https://modelslab.com/api/v6/voice/create_dubbing', payload, {
      timeout: 30000
    });
    
    console.log(`   Status: ${res.data.status}`);
    if (res.data.message) console.log(`   Message: ${res.data.message}`);
    if (res.data.fetch_result) console.log(`   ✅ Async processing - will poll`);
    
  } catch(err) {
    console.log(`   ❌ Error: ${err.response?.data?.message || err.message}`);
  }
  
  await new Promise(r => setTimeout(r, 1000));
}

async function runTests() {
  console.log('🎯 Testing ModelsLab Multi-Speaker Configurations\n');
  for (const config of configs) {
    await testConfig(config);
  }
}

runTests();
