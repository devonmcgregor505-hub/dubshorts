const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

// Wire Caption Remover nav item
html = html.replace(
  '<a class="ni" href="#" onclick="soon(event)"><span class="ic">✂️</span>Caption Remover<span class="badge soon">SOON</span></a>',
  '<a class="ni" href="#" onclick="showRemover()"><span class="ic">✂️</span>Caption Remover<span class="badge live">LIVE</span></a>'
);

// Remove the soon() block from the remover and add showRemover function before closing script tag
html = html.replace(
  'selCanvas.style.pointerEvents = \'none\';\nloadPreset();\nupdateHint();\nupdateTranslateBtn();',
  `selCanvas.style.pointerEvents = 'none';
loadPreset();
updateHint();
updateTranslateBtn();

function showRemover() {
  document.getElementById('removeToggle').checked = true;
  onRemove();
  document.getElementById('addToggle').checked = false;
  onAdd();
  document.getElementById('translateBtn').textContent = '→ Remove Captions';
  translateBtn._mode = 'remove';
}

const _origTranslate = startTranslation;
startTranslation = async function() {
  const btn = document.getElementById('translateBtn');
  if (btn._mode === 'remove') {
    const f = fileInput.files[0]; if (!f) { alert('Please select a video'); return; }
    if (!captionBox) { alert('Draw a box over the captions first'); return; }
    btn.disabled = true;
    hide('doneBox'); hide('errBox');
    startProg();
    const fd = new FormData();
    fd.append('video', f);
    fd.append('captionBox', JSON.stringify(captionBox));
    try {
      const res = await fetch('/remove-captions-fast', { method: 'POST', body: fd });
      const data = await res.json();
      finishProg();
      if (data.success) {
        show('doneBox');
        document.getElementById('resultVideo').src = data.videoUrl;
        document.getElementById('dlBtn').href = data.videoUrl;
        document.querySelector('.done-title').textContent = '// DONE ✓';
      } else {
        show('errBox');
        document.getElementById('errMsg').textContent = data.error;
      }
    } catch(err) {
      finishProg();
      show('errBox');
      document.getElementById('errMsg').textContent = 'Could not reach the server.';
    }
    btn.disabled = false;
    return;
  }
  return _origTranslate();
};`
);

fs.writeFileSync('index.html', html);
console.log('Done!');
