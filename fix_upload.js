const fs = require('fs');
const path = '/Users/kanemcgregor/dubshorts/index.html';
let html = fs.readFileSync(path, 'utf8');

// Replace the upload zone HTML - clean simple version
const oldZone = `      <div class="upload-zone" id="uploadZone">
        <input type="file" id="fileInput" accept="video/mp4,video/quicktime,.mp4,.mov" style="position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;z-index:10;">
        <span class="up-icon">🎬</span>
        <div class="up-title">Drop video here</div>
        <div class="up-hint">MP4 or MOV · Max 200MB</div>
        <div class="up-name" id="fileName"></div>
      </div>`;

const newZone = `      <div class="upload-zone" id="uploadZone" onclick="document.getElementById('fileInput').click();" style="cursor:pointer;">
        <input type="file" id="fileInput" accept="video/mp4,video/quicktime,.mp4,.mov" style="display:none;">
        <span class="up-icon">🎬</span>
        <div class="up-title">Drop video here</div>
        <div class="up-hint">MP4 or MOV · Max 200MB</div>
        <div class="up-name" id="fileName"></div>
      </div>`;

if (html.includes(oldZone)) {
  html = html.replace(oldZone, newZone);
  console.log('Upload zone HTML replaced');
} else {
  console.log('Old zone not found - trying fuzzy match');
  // Fallback: just fix the input element
  html = html.replace(
    /(<input type="file" id="fileInput"[^>]*>)/,
    '<input type="file" id="fileInput" accept="video/mp4,video/quicktime,.mp4,.mov" style="display:none;">'
  );
  // Fix the upload zone div
  html = html.replace(
    '<div class="upload-zone" id="uploadZone">',
    '<div class="upload-zone" id="uploadZone" onclick="document.getElementById(\'fileInput\').click();" style="cursor:pointer;">'
  );
  console.log('Fuzzy fix applied');
}

// Replace the JS click handlers with a clean simple version
const oldJS = `const fileInput = document.getElementById('fileInput');
document.getElementById('uploadZone').addEventListener('click', (e) => {
  if (e.target !== fileInput) fileInput.click();
});
fileInput.addEventListener('click', (e) => e.stopPropagation());`;

const newJS = `const fileInput = document.getElementById('fileInput');`;

if (html.includes(oldJS)) {
  html = html.replace(oldJS, newJS);
  console.log('JS click handlers cleaned up');
} else {
  console.log('JS handlers not found by exact match - may already be clean');
}

// Also fix drag and drop
const dragJS = `fileInput.addEventListener('change', () => {`;
const dragFix = `
// Drag and drop support
const uploadZone = document.getElementById('uploadZone');
uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.style.borderColor = 'var(--y)'; });
uploadZone.addEventListener('dragleave', () => { uploadZone.style.borderColor = ''; });
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.style.borderColor = '';
  const f = e.dataTransfer.files[0];
  if (f && (f.type.startsWith('video/') || f.name.match(/\\.mp4$|\\.mov$/i))) {
    const dt = new DataTransfer();
    dt.items.add(f);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change'));
  }
});

fileInput.addEventListener('change', () => {`;

html = html.replace(dragJS, dragFix);

fs.writeFileSync(path, html);
console.log('Done! Reload http://localhost:3000');
