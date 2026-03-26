// === REPLACE THE CAPTION BURNING SECTION IN server.js ===
// Look for the section that calls burn_captions.py and replace with this:

/*
FIND in server.js the part that does:
const pyResult = spawnSync('python3', [
  path.join(__dirname, 'burn_captions.py'),
  burnSource, captionedPath,
  JSON.stringify(cues), JSON.stringify(scaledStyle)
]);

REPLACE that entire block with this:
*/

// Burn captions with EXACT preview matching
if (cues.length > 0 && req.body.addCaption === 'true') {
  console.log('Burning captions with exact preview matching...');
  console.log('Style received:', JSON.stringify(captionStyle));
  
  // Prepare style with all frontend values
  const burnStyle = {
    yPct: captionStyle?.yPct ?? 70,
    fontSize: captionStyle?.fontSize ?? 4,
    textColor: captionStyle?.textColor ?? '#ffffff',
    outlineColor: captionStyle?.outlineColor ?? '#000000',
    outlineWidth: captionStyle?.outlineWidth ?? 15,
    textStyle: captionStyle?.textStyle ?? 'bold',
    textCase: captionStyle?.textCase ?? 'upper',
    captionMode: captionStyle?.captionMode ?? 'single',
    highlightColor: captionStyle?.highlightColor ?? '#f5e132',
    shadowSize: captionStyle?.shadowSize ?? 0
  };
  
  console.log('Burn style:', JSON.stringify(burnStyle));
  
  const pyResult = spawnSync('python3', [
    path.join(__dirname, 'burn_captions.py'),
    videoSource,  // Use the dubbed video directly
    captionedPath,
    JSON.stringify(cues),
    JSON.stringify(burnStyle)
  ], { encoding: 'utf8', timeout: 300000, maxBuffer: 100 * 1024 * 1024 });
  
  console.log('Python stdout:', pyResult.stdout?.slice(-500) || '');
  if (pyResult.stderr) console.log('Python stderr:', pyResult.stderr?.slice(-300) || '');
  
  if (pyResult.status === 0 && fs.existsSync(captionedPath) && fs.statSync(captionedPath).size > 10000) {
    console.log('✅ Captions burned successfully!');
    videoForMerge = captionedPath;
  } else {
    console.log('⚠️ Caption burning failed, using video without captions');
    if (fs.existsSync(captionedPath)) fs.unlinkSync(captionedPath);
  }
}

