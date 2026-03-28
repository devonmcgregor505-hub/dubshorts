const fs = require('fs');
const s = fs.readFileSync('server.js', 'utf8');
// Wrap all registerFont calls in try/catch
const fixed = s.replace(
  /if \(fs\.existsSync\((\w+)\)\) \{ registerFont\((\w+), \{ family: '([^']+)', weight: 'bold' \}\); (?:console\.log\([^)]+\); )?\}/g,
  "if (fs.existsSync($1)) { try { registerFont($2, { family: '$3', weight: 'bold' }); } catch(e) { console.warn('Font skip: $3'); } }"
);
fs.writeFileSync('server.js', fixed);
console.log('Done');
