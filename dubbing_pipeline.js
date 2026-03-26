const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const AssemblyAI = require('assemblyai');

// Initialize AssemblyAI API client
const assembly = new AssemblyAI(process.env.ASSEMBLYAI_API_KEY);

/**
 * Extracts audio from a video file.
 */
function extractAudio(videoFilePath, outputAudioPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoFilePath)
            .output(outputAudioPath)
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .run();
    });
}

/**
 * Detect speakers in the audio using AssemblyAI.
 */
async function detectSpeakers(audioFilePath) {
    const audioData = fs.readFileSync(audioFilePath);
    const response = await assembly.transcript.create({ audio_data: audioData });
    return response;
}

/**
 * Splits audio by speaker timestamps.
 */
async function splitAudioByTimestamps(audioFilePath, timestamps) {
    // Logic to split the audio using ffmpeg
    const promises = timestamps.map((timestamp, index) => {
        // Assume we save each segment in `segment-${index}.wav`
        return new Promise((resolve, reject) => {
            ffmpeg(audioFilePath)
                .setStartTime(timestamp.start)
                .setDuration(timestamp.end - timestamp.start)
                .output(`segment-${index}.wav`)
                .on('end', () => resolve(`segment-${index}.wav`))
                .on('error', (err) => reject(err))
                .run();
        });
    });
    return Promise.all(promises);
}

/**
 * Dub audio using ModelsLab per-speaker models.
 */
async function dubAudioWithModel(segmentFilePath, speakerModel) {
    // Implement dubbing logic using ModelsLab API
    // Return path to dubbed audio
    return `dubbed-${segmentFilePath}`; // Placeholder for actual dubbing logic
}

/**
 * Reassemble dubbed audio using ffmpeg concat.
 */
async function reassembleAudio(segmentPaths, outputPath) {
    const concatFilePath = 'concat.txt';
    const concatData = segmentPaths.map(path => `file '${path}'`).join('\n');
    fs.writeFileSync(concatFilePath, concatData);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(concatFilePath)
            .outputOptions('-f concat')
            .output(outputPath)
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .run();
    });
}

/**
 * Mute the original video audio while merging dubbed audio.
 */
function muteOriginalVideo(videoFilePath, outputVideoPath, audioFilePath) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoFilePath)
            .audioCodec('aac')
            .audioFilters('volume=0') // Mute original audio
            .input(audioFilePath)
            .output(outputVideoPath)
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .run();
    });
}

module.exports = {
    extractAudio,
    detectSpeakers,
    splitAudioByTimestamps,
    dubAudioWithModel,
    reassembleAudio,
    muteOriginalVideo
};