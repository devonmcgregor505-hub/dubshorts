const fs = require('fs');
let html = fs.readFileSync('/Users/kanemcgregor/dubshorts/index.html', 'utf8');

// Find the script tag content
const scriptStart = html.indexOf('<script>');
const scriptEnd = html.lastIndexOf('</script>');
let js = html.slice(scriptStart + 8, scriptEnd);

// Remove the duplicate FONTS declaration - keep only the last one
const fontsDeclarations = [];
let idx = 0;
while ((idx = js.indexOf('const FONTS = ', idx)) !== -1) {
  const end = js.indexOf(';', js.indexOf(']', idx)) + 1;
  fontsDeclarations.push({ start: idx, end });
  idx++;
}

console.log('Found FONTS declarations:', fontsDeclarations.length);

// Remove all but the last one
if (fontsDeclarations.length > 1) {
  for (let i = fontsDeclarations.length - 2; i >= 0; i--) {
    const { start, end } = fontsDeclarations[i];
    js = js.slice(0, start) + js.slice(end);
  }
  console.log('Removed', fontsDeclarations.length - 1, 'duplicate(s)');
}

// Also deduplicate any other const re-declarations
const consts = ['let fontSearchOpen'];
consts.forEach(name => {
  const count = (js.match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  if (count > 1) {
    let found = 0;
    js = js.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^;]+;', 'g'), match => {
      found++;
      return found === 1 ? match : '';
    });
    console.log('Deduped:', name);
  }
});

html = html.slice(0, scriptStart + 8) + js + html.slice(scriptEnd);
fs.writeFileSync('/Users/kanemcgregor/dubshorts/index.html', html);
console.log('Done');
