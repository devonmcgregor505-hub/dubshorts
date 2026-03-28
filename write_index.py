content = r'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DubShorts</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--y:#f5e132;--yd:#c8b820;--yg:rgba(245,225,50,0.08);--blk:#080808;--s1:#111;--s2:#161616;--s3:#1e1e1e;--s4:#252525;--bd:#2a2a2a;--tx:#efefef;--tdim:#888;--tmut:#444;--grn:#2ecc71;--red:#ff4136;}
*{margin:0;padding:0;box-sizing:border-box;}html,body{height:100%;}
body{font-family:'DM Sans',sans-serif;background:var(--blk);color:var(--tx);display:flex;overflow:hidden;}
.sidebar{width:195px;height:100vh;background:var(--s1);border-right:1px solid var(--bd);display:flex;flex-direction:column;flex-shrink:0;}
.logo{padding:16px 15px 13px;border-bottom:1px solid var(--bd);}
.logo-mark{font-family:'Space Mono',monospace;font-size:14px;font-weight:700;color:var(--y);}
.logo-sub{font-size:8px;color:var(--tmut);margin-top:2px;letter-spacing:2.5px;text-transform:uppercase;}
.nav{padding:8px 7px;flex:1;overflow-y:auto;}
.nav-lbl{font-size:8px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--tmut);padding:0 8px;margin:8px 0 3px;}
.ni{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:7px;font-size:12px;font-weight:500;color:var(--tdim);transition:all .15s;border:1px solid transparent;margin-bottom:1px;cursor:pointer;background:none;width:100%;text-align:left;}
.ni:hover{background:var(--s2);color:var(--tx);}
.ni.active{background:var(--yg);border-color:rgba(245,225,50,0.18);color:var(--y);}
.ni .ic{font-size:13px;width:15px;text-align:center;flex-shrink:0;}
.badge{margin-left:auto;font-size:8px;padding:2px 4px;border-radius:3px;font-weight:700;}
.badge.soon{background:var(--s4);color:var(--tmut);}
.badge.live{background:rgba(46,204,113,.1);color:var(--grn);}
.sf{padding:10px 13px;border-top:1px solid var(--bd);}
.cb-lbl{font-size:9px;color:var(--tmut);display:flex;justify-content:space-between;margin-bottom:4px;}
.cb-lbl b{color:var(--y);font-weight:600;}
.cb-track{background:var(--s3);border-radius:3px;height:2px;overflow:hidden;}
.cb-fill{height:100%;background:var(--y);width:68%;border-radius:3px;}
.main{flex:1;display:flex;flex-direction:column;min-width:0;height:100vh;overflow:hidden;}
.topbar{padding:11px 20px;border-bottom:1px solid var(--bd);display:flex;align-items:center;gap:6px;flex-shrink:0;}
.pg-title{font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:var(--y);}
.pg-sep,.pg-sub{font-size:12px;color:var(--tdim);}
.pill{margin-left:auto;background:rgba(46,204,113,.07);border:1px solid rgba(46,204,113,.18);color:var(--grn);font-size:9px;font-weight:700;padding:3px 8px;border-radius:20px;letter-spacing:.8px;}
.tab-panel{display:none;flex:1;overflow:hidden;}
.tab-panel.active{display:flex;}
.workspace{flex:1;display:flex;overflow:hidden;}
.left{width:420px;flex-shrink:0;border-right:1px solid var(--bd);overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:11px;}
.upload-zone{border:1.5px dashed var(--bd);border-radius:11px;padding:28px 16px;text-align:center;cursor:pointer;transition:all .2s;background:var(--s1);}
.upload-zone:hover,.upload-zone.drag{border-color:var(--yd);background:var(--s2);}
.upload-zone.has-file{border-color:rgba(245,225,50,.35);border-style:solid;}
.up-icon{font-size:26px;display:block;margin-bottom:6px;}
.up-title{font-size:13px;font-weight:600;margin-bottom:2px;}
.up-hint{font-size:11px;color:var(--tmut);}
.up-name{font-size:10px;color:var(--y);font-weight:600;margin-top:4px;word-break:break-all;}
.lang-row{display:flex;flex-direction:column;gap:5px;}
.lang-lbl{font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--tdim);}
.lang-sel{background:var(--s2);border:1px solid var(--bd);color:var(--tx);padding:9px 11px;border-radius:8px;font-size:12px;font-family:'DM Sans',sans-serif;outline:none;cursor:pointer;width:100%;}
.tog-row{display:flex;gap:8px;}
.tc{flex:1;background:var(--s2);border:1px solid var(--bd);border-radius:9px;padding:10px 11px;display:flex;align-items:center;gap:8px;transition:all .15s;cursor:pointer;}
.tc.on{border-color:rgba(245,225,50,.22);background:var(--yg);}
.tc-ic{font-size:13px;flex-shrink:0;}
.tc-info{flex:1;min-width:0;}
.tc-title{font-size:12px;font-weight:600;}
.tc-desc{font-size:10px;color:var(--tmut);}
.tog{position:relative;width:34px;height:19px;flex-shrink:0;}
.tog input{opacity:0;width:0;height:0;}
.tog-track{position:absolute;inset:0;background:var(--s4);border-radius:10px;cursor:pointer;border:1px solid var(--bd);transition:.18s;}
.tog-thumb{position:absolute;height:11px;width:11px;left:3px;top:3px;background:var(--tmut);border-radius:50%;transition:.18s;pointer-events:none;}
.tog input:checked~.tog-track{background:var(--y);border-color:var(--y);}
.tog input:checked~.tog-thumb{transform:translateX(15px);background:var(--blk);}
.style-panel{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:13px;}
.sp-hd{font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--tdim);margin-bottom:11px;}
.ypos-row{margin-bottom:11px;}
.ypos-lbl{font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--tmut);display:flex;justify-content:space-between;margin-bottom:5px;}
.ypos-lbl span:last-child{color:var(--y);font-family:'Space Mono',monospace;}
.ypos-marks{display:flex;justify-content:space-between;font-size:9px;color:var(--tmut);margin-top:2px;}
.sg{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;}
.sg2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;}
.sg3{display:grid;grid-template-columns:1fr;gap:8px;margin-top:8px;}
.sfi{display:flex;flex-direction:column;gap:4px;}
.sfi label{font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--tmut);}
.sfi select{background:var(--s3);border:1px solid var(--bd);color:var(--tx);padding:5px 7px;border-radius:6px;font-size:11px;font-family:'DM Sans',sans-serif;outline:none;cursor:pointer;}
.sfi input[type=color]{width:100%;height:28px;border:1px solid var(--bd);border-radius:6px;background:var(--s3);cursor:pointer;padding:2px 3px;}
.rr{display:flex;align-items:center;gap:5px;}
.rr input[type=range]{flex:1;accent-color:var(--y);}
.rv{font-size:9px;color:var(--y);font-weight:700;font-family:'Space Mono',monospace;min-width:28px;text-align:right;}
.mode-row{display:flex;gap:6px;margin-top:8px;}
.mode-btn{flex:1;padding:6px 4px;border-radius:6px;font-size:10px;font-weight:600;cursor:pointer;border:1px solid var(--bd);background:var(--s3);color:var(--tdim);transition:all .15s;text-align:center;}
.mode-btn.active{background:var(--yg);border-color:rgba(245,225,50,.35);color:var(--y);}
.hc-row{display:flex;align-items:center;gap:8px;margin-top:8px;}
.hc-lbl{font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--tmut);flex:1;}
.submit{width:100%;padding:12px;background:var(--y);color:var(--blk);border:none;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;font-family:'Space Mono',monospace;transition:all .2s;}
.submit:hover{background:#ffe600;box-shadow:0 4px 14px rgba(245,225,50,.14);}
.submit:disabled{background:var(--s4);color:var(--tmut);cursor:not-allowed;box-shadow:none;}
.prog-wrap{display:none;}
.prog-lbl{font-size:10px;color:var(--tdim);font-family:'Space Mono',monospace;margin-bottom:4px;display:flex;justify-content:space-between;}
.prog-track{background:var(--s4);border-radius:4px;height:4px;overflow:hidden;border:1px solid var(--bd);}
.prog-fill{height:100%;background:linear-gradient(90deg,var(--y),#ffe600);border-radius:4px;width:0%;transition:width .35s ease;}
.prog-eta{font-size:9px;color:var(--tmut);margin-top:3px;font-family:'Space Mono',monospace;}
.done-box{background:rgba(46,204,113,.04);border:1px solid rgba(46,204,113,.14);border-radius:9px;padding:11px;display:none;}
.done-title{font-size:10px;font-weight:700;font-family:'Space Mono',monospace;color:var(--grn);margin-bottom:7px;}
.dl-btn{display:block;width:100%;padding:9px;background:var(--grn);color:#000;border:none;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer;font-family:'Space Mono',monospace;margin-top:8px;text-align:center;text-decoration:none;transition:all .2s;}
.dl-btn:hover{background:#27ae60;}
.err-box{background:rgba(255,65,54,.04);border:1px solid rgba(255,65,54,.14);border-radius:9px;padding:11px;display:none;}
.err-title{font-size:10px;font-weight:700;font-family:'Space Mono',monospace;color:var(--red);margin-bottom:4px;}
.errmsg{color:#ff7070;font-size:11px;line-height:1.5;}
.info-box{background:var(--s2);border:1px solid var(--bd);border-radius:9px;padding:11px 13px;font-size:11px;color:var(--tdim);line-height:1.8;}
.info-box b{color:var(--tx);}
.right{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;background:var(--blk);gap:10px;padding:20px;overflow-y:auto;}
.phone-wrap{height:calc(100vh - 120px);max-height:560px;aspect-ratio:9/16;max-width:315px;position:relative;border-radius:14px;overflow:hidden;background:#000;border:1.5px solid var(--bd);box-shadow:0 16px 48px rgba(0,0,0,.7);flex-shrink:0;}
.empty-state{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--tmut);}
.empty-state span{font-size:30px;}
.empty-state p{font-size:11px;}
.phone-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none;}
.sel-canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;}
.hint-bar{width:100%;max-width:315px;background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:7px 10px;display:flex;align-items:center;gap:8px;}
.hint-txt{font-size:10px;color:var(--tdim);flex:1;line-height:1.4;}
.clear-btn{padding:3px 8px;border:1px solid var(--bd);background:transparent;color:var(--tdim);border-radius:5px;font-size:10px;cursor:pointer;transition:all .15s;flex-shrink:0;display:none;}
.clear-btn:hover{border-color:var(--y);color:var(--y);}
.preview-lbl{font-size:9px;color:var(--tmut);font-family:'Space Mono',monospace;letter-spacing:1px;}
</style>
</head>
<body>
<aside class="sidebar">
  <div class="logo">
    <div class="logo-mark">DubShorts</div>
    <div class="logo-sub">AI Video Studio</div>
  </div>
  <nav class="nav">
    <div class="nav-lbl">Tools</div>
    <button class="ni active" id="nav-dub" onclick="switchTab('dub')"><span class="ic">&#127897;</span>Dubbing<span class="badge live">LIVE</span></button>
    <button class="ni" id="nav-remover" onclick="switchTab('remover')"><span class="ic">&#9986;</span>Caption Remover<span class="badge live">LIVE</span></button>
    <button class="ni" onclick="alert('Coming soon!')"><span class="ic">&#128269;</span>Scraper<span class="badge soon">SOON</span></button>
    <button class="ni" onclick="alert('Coming soon!')"><span class="ic">&#128167;</span>Watermark Remover<span class="badge soon">SOON</span></button>
    <button class="ni" onclick="alert('Coming soon!')"><span class="ic">&#9997;</span>Auto Captions<span class="badge soon">SOON</span></button>
  </nav>
  <div class="sf">
    <div class="cb-lbl"><span>Usage</span><b>68%</b></div>
    <div class="cb-track"><div class="cb-fill"></div></div>
    <div class="cb-lbl" style="margin-top:4px;margin-bottom:0"><span>340 / 500 credits</span></div>
  </div>
</aside>
<div class="main">
  <div class="topbar">
    <span class="pg-title" id="topTitle">Dubbing</span>
    <span class="pg-sep"> / </span>
    <span class="pg-sub" id="topSub">Translate video</span>
    <div class="pill">&#9679; Live</div>
  </div>
  <div class="tab-panel active" id="tab-dub">
    <div class="workspace">
      <div class="left">
        <div class="upload-zone" id="dubUploadZone">
          <input type="file" id="dubFileInput" accept="video/mp4,video/quicktime,.mp4,.mov" style="display:none">
          <span class="up-icon">&#127916;</span>
          <div class="up-title">Drop video here</div>
          <div class="up-hint">MP4 or MOV &middot; Max 200MB</div>
          <div class="up-name" id="dubFileName"></div>
        </div>
        <div class="lang-row">
          <div class="lang-lbl">Select Language</div>
          <select class="lang-sel" id="langSelect" onchange="updateTranslateBtn();savePreset();">
            <option value="none">None (No Translation)</option>
            <option value="es">Spanish</option>
            <option value="hi">Hindi</option>
            <option value="pt">Portuguese</option>
            <option value="ja">Japanese</option>
            <option value="fr">French</option>
            <option value="pl">Polish</option>
            <option value="it">Italian</option>
            <option value="zh">Chinese</option>
          </select>
        </div>
        <div class="tog-row">
          <div class="tc" id="removeCard" onclick="document.getElementById('removeToggle').click();">
            <div class="tc-ic">&#128465;</div>
            <div class="tc-info"><div class="tc-title">Remove Captions</div><div class="tc-desc">Draw box over captions</div></div>
            <label class="tog" onclick="event.stopPropagation()">
              <input type="checkbox" id="removeToggle" onchange="onRemove();savePreset();">
              <div class="tog-track"></div><div class="tog-thumb"></div>
            </label>
          </div>
          <div class="tc" id="addCard" onclick="document.getElementById('addToggle').click();">
            <div class="tc-ic">&#128172;</div>
            <div class="tc-info"><div class="tc-title">Add Captions</div><div class="tc-desc">Translated subtitles</div></div>
            <label class="tog" onclick="event.stopPropagation()">
              <input type="checkbox" id="addToggle" onchange="onAdd();savePreset();">
              <div class="tog-track"></div><div class="tog-thumb"></div>
            </label>
          </div>
        </div>
        <div class="style-panel" id="stylePanel" style="display:none">
          <div class="sp-hd" onclick="toggleStylePanel()" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;">Caption Style <span id="styleArrow">&#9660;</span></div>
          <div id="styleInner">
            <div class="ypos-row">
              <div class="ypos-lbl"><span>Vertical Position</span><span id="yposVal">70%</span></div>
              <input type="range" id="yPos" min="5" max="95" value="70" step="1" style="width:100%;accent-color:var(--y);" oninput="onYPos()">
              <div class="ypos-marks"><span>Top</span><span>Center</span><span>Bottom</span></div>
            </div>
            <div class="sfi">
              <label>Caption Mode</label>
              <div class="mode-row">
                <button class="mode-btn active" id="modeSingle" onclick="setMode('single');savePreset();">Single Word</button>
                <button class="mode-btn" id="modeMulti" onclick="setMode('multi');savePreset();">Multi Word</button>
                <button class="mode-btn" id="modeHighlight" onclick="setMode('highlight');savePreset();">Highlight</button>
              </div>
            </div>
            <div class="hc-row" id="hlColorRow" style="display:none">
              <span class="hc-lbl">Highlight Color</span>
              <input type="color" id="highlightColor" value="#f5e132" style="width:50px;height:26px;border:1px solid var(--bd);border-radius:5px;cursor:pointer;" oninput="drawOverlay();savePreset();">
            </div>
            <div class="sg" style="margin-top:10px;">
              <div class="sfi" style="grid-column:1/-1">
                <label>Font</label>
                <div style="position:relative">
                  <input type="text" id="fontSearch" placeholder="Search fonts..." autocomplete="off" style="width:100%;background:var(--s3);border:1px solid var(--bd);color:var(--tx);padding:5px 7px;border-radius:6px 6px 0 0;font-size:11px;outline:none;" oninput="filterFonts(this.value)" onfocus="document.getElementById('fontList').style.display='block'">
                  <div id="fontList" style="background:var(--s3);border:1px solid var(--bd);border-top:none;border-radius:0 0 6px 6px;max-height:160px;overflow-y:auto;display:none;position:absolute;width:100%;z-index:100;"></div>
                </div>
                <div id="fontSelected" style="font-size:10px;color:var(--y);margin-top:3px;font-weight:600;"></div>
                <input type="hidden" id="fontFamily" value="Impact">
              </div>
              <div class="sfi"><label>Style</label><select id="textStyle" onchange="drawOverlay();savePreset();"><option value="bold">Bold</option><option value="normal">Normal</option><option value="italic">Italic</option><option value="bold italic">Bold Italic</option></select></div>
              <div class="sfi"><label>Case</label><select id="textCase" onchange="drawOverlay();savePreset();"><option value="upper">UPPERCASE</option><option value="normal">Normal</option><option value="lower">lowercase</option></select></div>
            </div>
            <div class="sg2">
              <div class="sfi"><label>Size <span class="rv" id="sizeVal">4%</span></label><div class="rr"><input type="range" id="fontSize" min="2" max="12" value="4" step=".5" oninput="document.getElementById('sizeVal').textContent=this.value+'%';drawOverlay();savePreset();"></div></div>
              <div class="sfi"><label>Outline <span class="rv" id="outlineVal">15%</span></label><div class="rr"><input type="range" id="outlineWidth" min="0" max="40" value="15" step="1" oninput="document.getElementById('outlineVal').textContent=this.value+'%';drawOverlay();savePreset();"></div></div>
              <div class="sfi"><label>Text Color</label><input type="color" id="textColor" value="#ffffff" oninput="drawOverlay();savePreset();"></div>
              <div class="sfi"><label>Outline Color</label><input type="color" id="outlineColor" value="#000000" oninput="drawOverlay();savePreset();"></div>
            </div>
            <div class="sg3"><div class="sfi" style="margin-top:8px;"><label>Shadow <span class="rv" id="shadowVal">0%</span></label><div class="rr"><input type="range" id="shadowSize" min="0" max="50" value="0" step="1" oninput="document.getElementById('shadowVal').textContent=this.value+'%';drawOverlay();savePreset();"></div></div></div>
          </div>
        </div>
        <button class="submit" id="translateBtn" onclick="startTranslation()">Process Video</button>
        <div class="prog-wrap" id="dubProgWrap">
          <div class="prog-lbl"><span id="dubProgLbl">Processing...</span><span id="dubProgPct">0%</span></div>
          <div class="prog-track"><div class="prog-fill" id="dubProgFill"></div></div>
          <div class="prog-eta" id="dubProgEta"></div>
        </div>
        <div class="done-box" id="dubDoneBox">
          <div class="done-title" id="dubDoneTitle">// DONE</div>
          <video id="dubResultVideo" controls playsinline style="width:100%;border-radius:7px;margin-top:5px;"></video>
          <a class="dl-btn" id="dubDlBtn" href="#" download="dubbed_video.mp4">Download Video</a>
        </div>
        <div class="err-box" id="dubErrBox"><div class="err-title">// ERROR</div><div class="errmsg" id="dubErrMsg"></div></div>
      </div>
      <div class="right">
        <div class="phone-wrap" id="dubPhoneWrap">
          <div class="empty-state" id="dubEmptyState"><span>&#128241;</span><p>Upload a video</p></div>
          <video class="phone-video" id="dubPreviewVideo" preload="metadata" controls></video>
          <canvas class="sel-canvas" id="selCanvas"></canvas>
        </div>
        <div class="hint-bar">
          <span class="hint-txt" id="hintTxt">Upload a video to preview</span>
          <button class="clear-btn" id="clearBtn" onclick="clearBox()">Clear</button>
        </div>
      </div>
    </div>
  </div>
  <div class="tab-panel" id="tab-remover">
    <div class="workspace">
      <div class="left">
        <div class="upload-zone" id="remUploadZone">
          <input type="file" id="remFileInput" accept="video/mp4,video/quicktime,.mp4,.mov" style="display:none">
          <span class="up-icon">&#9986;</span>
          <div class="up-title">Drop video here</div>
          <div class="up-hint">MP4 or MOV &middot; Up to 500MB</div>
          <div class="up-name" id="remFileName"></div>
        </div>
        <button class="submit" id="remBtn" onclick="startRemoval()" disabled>Remove Captions</button>
        <div class="prog-wrap" id="remProgWrap">
          <div class="prog-lbl"><span id="remProgLbl">Detecting captions...</span><span id="remProgPct">0%</span></div>
          <div class="prog-track"><div class="prog-fill" id="remProgFill"></div></div>
          <div class="prog-eta" id="remProgEta">Takes 2-5 min depending on video length</div>
        </div>
        <div class="done-box" id="remDoneBox">
          <div class="done-title">// CAPTIONS REMOVED</div>
          <a class="dl-btn" id="remDlBtn" href="#" download="clean_video.mp4">Download Clean Video</a>
        </div>
        <div class="err-box" id="remErrBox"><div class="err-title">// ERROR</div><div class="errmsg" id="remErrMsg"></div></div>
        <div class="info-box"><b>How it works</b><br>1. EasyOCR scans frames to locate all caption text<br>2. A pixel mask is built around detected regions<br>3. LaMa AI inpaints those regions with background<br>4. Video is reassembled with your original audio</div>
      </div>
      <div class="right">
        <div class="phone-wrap">
          <div class="empty-state" id="remEmptyState"><span>&#128241;</span><p>Upload a video to preview</p></div>
          <video class="phone-video" id="remPreviewVideo" preload="metadata" controls></video>
        </div>
        <div class="preview-lbl" id="remPreviewLbl">ORIGINAL</div>
      </div>
    </div>
  </div>
</div>
<script>
function switchTab(t){document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));document.querySelectorAll('.ni').forEach(n=>n.classList.remove('active'));document.getElementById('tab-'+t).classList.add('active');document.getElementById('nav-'+t).classList.add('active');const titles={dub:['Dubbing','Translate video'],remover:['Caption Remover','AI-powered - EasyOCR + LaMa']};document.getElementById('topTitle').textContent=titles[t][0];document.getElementById('topSub').textContent=titles[t][1];}
const remFileInput=document.getElementById('remFileInput'),remUploadZone=document.getElementById('remUploadZone'),remPreviewVideo=document.getElementById('remPreviewVideo');
remUploadZone.addEventListener('click',()=>remFileInput.click());
remUploadZone.addEventListener('dragover',e=>{e.preventDefault();remUploadZone.classList.add('drag');});
remUploadZone.addEventListener('dragleave',()=>remUploadZone.classList.remove('drag'));
remUploadZone.addEventListener('drop',e=>{e.preventDefault();remUploadZone.classList.remove('drag');const f=e.dataTransfer.files[0];if(f)loadRemFile(f);});
remFileInput.addEventListener('change',()=>{if(remFileInput.files[0])loadRemFile(remFileInput.files[0]);});
function loadRemFile(f){document.getElementById('remFileName').textContent=f.name;remUploadZone.classList.add('has-file');document.getElementById('remEmptyState').style.display='none';remPreviewVideo.style.display='block';remPreviewVideo.src=URL.createObjectURL(f);document.getElementById('remBtn').disabled=false;document.getElementById('remPreviewLbl').textContent='ORIGINAL';hide('remDoneBox');hide('remErrBox');}
async function startRemoval(){const f=remFileInput.files[0];if(!f)return;const btn=document.getElementById('remBtn');btn.disabled=true;hide('remDoneBox');hide('remErrBox');startRemProg();const fd=new FormData();fd.append('video',f);try{const res=await fetch('/remove-captions',{method:'POST',body:fd}),data=await res.json();finishRemProg();if(data.success){show('remDoneBox');document.getElementById('remDlBtn').href=data.videoUrl;remPreviewVideo.src=data.videoUrl;document.getElementById('remPreviewLbl').textContent='RESULT - CAPTIONS REMOVED';}else{show('remErrBox');document.getElementById('remErrMsg').textContent=data.error;}}catch(err){finishRemProg();show('remErrBox');document.getElementById('remErrMsg').textContent='Server error: '+err.message;}btn.disabled=false;}
const REM_STEPS=[{label:'Loading AI models...',duration:15},{label:'Extracting frames...',duration:20},{label:'Detecting captions (EasyOCR)...',duration:35},{label:'Inpainting with LaMa AI...',duration:120},{label:'Reassembling video...',duration:20}];
let remProgInterval=null;
function startRemProg(){clearInterval(remProgInterval);document.getElementById('remProgWrap').style.display='block';document.getElementById('remProgFill').style.width='0%';const totalMs=REM_STEPS.reduce((a,s)=>a+s.duration*1000,0),start=Date.now();remProgInterval=setInterval(()=>{const elapsed=(Date.now()-start)/1000;let cum=0,lbl=REM_STEPS[REM_STEPS.length-1].label;for(const s of REM_STEPS){cum+=s.duration;if(elapsed<cum){lbl=s.label;break;}}const pct=Math.min(93,(elapsed/(totalMs/1000))*100);document.getElementById('remProgFill').style.width=pct.toFixed(1)+'%';document.getElementById('remProgPct').textContent=Math.round(pct)+'%';document.getElementById('remProgLbl').textContent=lbl;const rem=Math.max(0,totalMs/1000-elapsed);document.getElementById('remProgEta').textContent=rem>5?'~'+Math.ceil(rem)+'s remaining':'Almost done...';},400);}
function finishRemProg(){clearInterval(remProgInterval);document.getElementById('remProgFill').style.width='100%';document.getElementById('remProgPct').textContent='100%';document.getElementById('remProgLbl').textContent='Done!';document.getElementById('remProgEta').textContent='Complete!';setTimeout(()=>{document.getElementById('remProgWrap').style.display='none';},1500);}
const dubFileInput=document.getElementById('dubFileInput'),dubUploadZone=document.getElementById('dubUploadZone'),dubPreviewVideo=document.getElementById('dubPreviewVideo'),selCanvas=document.getElementById('selCanvas'),ctx=selCanvas.getContext('2d'),dubPhoneWrap=document.getElementById('dubPhoneWrap');
let captionBox=null,isDrawing=false,sx=0,sy=0,captionYPct=70,captionMode='single',dubProgInterval=null;
dubUploadZone.addEventListener('click',()=>dubFileInput.click());
dubUploadZone.addEventListener('dragover',e=>{e.preventDefault();dubUploadZone.style.borderColor='var(--y)';});
dubUploadZone.addEventListener('dragleave',()=>{dubUploadZone.style.borderColor='';});
dubUploadZone.addEventListener('drop',e=>{e.preventDefault();dubUploadZone.style.borderColor='';const f=e.dataTransfer.files[0];if(f){const dt=new DataTransfer();dt.items.add(f);dubFileInput.files=dt.files;dubFileInput.dispatchEvent(new Event('change'));}});
dubFileInput.addEventListener('change',()=>{const f=dubFileInput.files[0];if(!f)return;document.getElementById('dubFileName').textContent=f.name;dubUploadZone.classList.add('has-file');document.getElementById('dubEmptyState').style.display='none';dubPreviewVideo.style.display='block';dubPreviewVideo.src=URL.createObjectURL(f);updateTranslateBtn();setTimeout(fitCanvas,150);updateHint();});
function fitCanvas(){selCanvas.width=dubPhoneWrap.offsetWidth;selCanvas.height=dubPhoneWrap.offsetHeight;drawOverlay();}
window.addEventListener('resize',fitCanvas);setTimeout(fitCanvas,300);
function onRemove(){const on=document.getElementById('removeToggle').checked;document.getElementById('removeCard').classList.toggle('on',on);selCanvas.style.pointerEvents=on?'auto':'none';selCanvas.style.cursor=on?'crosshair':'default';updateHint();}
function onAdd(){const on=document.getElementById('addToggle').checked;document.getElementById('addCard').classList.toggle('on',on);document.getElementById('stylePanel').style.display=on?'block':'none';drawOverlay();updateHint();}
function updateHint(){const rem=document.getElementById('removeToggle').checked,add=document.getElementById('addToggle').checked,h=document.getElementById('hintTxt');if(!dubFileInput.files[0]){h.textContent='Upload a video to preview';return;}if(rem&&add)h.textContent='Draw box over captions then translate';else if(rem)h.textContent='Draw a box over the captions you want removed';else if(add)h.textContent='Preview shows where translated captions will appear';else h.textContent='Enable an option to get started';}
function onYPos(){captionYPct=parseInt(document.getElementById('yPos').value);document.getElementById('yposVal').textContent=captionYPct+'%';drawOverlay();savePreset();}
function updateTranslateBtn(){const lang=document.getElementById('langSelect').value,names={none:'Process Video',es:'Spanish',hi:'Hindi',pt:'Portuguese',ja:'Japanese',fr:'French',pl:'Polish',it:'Italian',zh:'Chinese'};document.getElementById('translateBtn').textContent=lang==='none'?'Process Video':'Translate to '+(names[lang]||lang);}
selCanvas.addEventListener('mousedown',e=>{if(!document.getElementById('removeToggle').checked)return;const r=selCanvas.getBoundingClientRect();sx=e.clientX-r.left;sy=e.clientY-r.top;isDrawing=true;captionBox=null;document.getElementById('clearBtn').style.display='none';});
selCanvas.addEventListener('mousemove',e=>{if(!isDrawing)return;const r=selCanvas.getBoundingClientRect();ctx.clearRect(0,0,selCanvas.width,selCanvas.height);drawBox(sx,sy,e.clientX-r.left-sx,e.clientY-r.top-sy);if(document.getElementById('addToggle').checked)drawCaption();});
selCanvas.addEventListener('mouseup',e=>{if(!isDrawing)return;isDrawing=false;const r=selCanvas.getBoundingClientRect(),bw=e.clientX-r.left-sx,bh=e.clientY-r.top-sy;if(Math.abs(bw)>6&&Math.abs(bh)>6){captionBox={x:Math.min(sx,sx+bw)/selCanvas.width,y:Math.min(sy,sy+bh)/selCanvas.height,w:Math.abs(bw)/selCanvas.width,h:Math.abs(bh)/selCanvas.height};document.getElementById('clearBtn').style.display='block';savePreset();}drawOverlay();});
function drawBox(x,y,w,h){ctx.save();ctx.strokeStyle='rgba(245,225,50,0.85)';ctx.lineWidth=1.5;ctx.setLineDash([4,3]);ctx.strokeRect(x,y,w,h);ctx.fillStyle='rgba(245,225,50,0.07)';ctx.fillRect(x,y,w,h);ctx.restore();}
function drawCaption(){const W=selCanvas.width,H=selCanvas.height;if(!W||!H)return;const fsp=parseFloat(document.getElementById('fontSize').value||4)/100,fs=Math.max(8,Math.round(H*fsp)),ff=document.getElementById('fontFamily').value||'sans-serif',ts=document.getElementById('textStyle').value||'bold',tc=document.getElementById('textColor').value||'#fff',oc=document.getElementById('outlineColor').value||'#000',ow=parseFloat(document.getElementById('outlineWidth').value||15)/100,tcase=document.getElementById('textCase').value||'upper',hc=document.getElementById('highlightColor').value||'#f5e132',shadow=parseFloat(document.getElementById('shadowSize').value||0)/100,y=(captionYPct/100)*H;ctx.save();ctx.font=ts+' '+fs+'px '+ff;ctx.textAlign='center';ctx.textBaseline='middle';if(captionMode==='single'){const txt=tcase==='lower'?'hola mundo':tcase==='normal'?'Hola Mundo':'HOLA MUNDO';if(shadow>0){ctx.shadowColor='rgba(0,0,0,0.9)';ctx.shadowBlur=shadow*fs;ctx.shadowOffsetY=shadow*fs*0.3;}if(ow>0){ctx.lineWidth=fs*ow;ctx.strokeStyle=oc;ctx.lineJoin='round';ctx.strokeText(txt,W/2,y);}ctx.shadowBlur=0;ctx.shadowOffsetY=0;ctx.fillStyle=tc;ctx.fillText(txt,W/2,y);}else{const words=tcase==='upper'?['HOLA','MUNDO','AMIGOS']:tcase==='lower'?['hola','mundo','amigos']:['Hola','Mundo','Amigos'];let curX=W/2-words.reduce((a,ww)=>a+ctx.measureText(ww+' ').width,0)/2;words.forEach((word,i)=>{const ww=ctx.measureText(word+' ').width,cx=curX+ww/2-ctx.measureText(' ').width/2,color=(captionMode==='highlight'&&i===1)?hc:tc;if(shadow>0){ctx.shadowColor='rgba(0,0,0,0.9)';ctx.shadowBlur=shadow*fs;ctx.shadowOffsetY=shadow*fs*0.3;}if(ow>0){ctx.lineWidth=fs*ow;ctx.strokeStyle=oc;ctx.lineJoin='round';ctx.strokeText(word,cx,y);}ctx.shadowBlur=0;ctx.shadowOffsetY=0;ctx.fillStyle=color;ctx.fillText(word,cx,y);curX+=ww;});}ctx.restore();}
function drawOverlay(){ctx.clearRect(0,0,selCanvas.width,selCanvas.height);if(captionBox&&document.getElementById('removeToggle').checked)drawBox(captionBox.x*selCanvas.width,captionBox.y*selCanvas.height,captionBox.w*selCanvas.width,captionBox.h*selCanvas.height);if(document.getElementById('addToggle').checked)drawCaption();}
function clearBox(){captionBox=null;document.getElementById('clearBtn').style.display='none';drawOverlay();savePreset();}
selCanvas.style.pointerEvents='none';
function startDubProg(){clearInterval(dubProgInterval);const totalMs=185000,start=Date.now();document.getElementById('dubProgWrap').style.display='block';document.getElementById('dubProgFill').style.width='0%';dubProgInterval=setInterval(()=>{const elapsed=(Date.now()-start)/1000,pct=Math.min(91,(elapsed/(totalMs/1000))*100);document.getElementById('dubProgFill').style.width=pct.toFixed(1)+'%';document.getElementById('dubProgPct').textContent=Math.round(pct)+'%';const rem=Math.max(0,totalMs/1000-elapsed);document.getElementById('dubProgEta').textContent=rem>5?'~'+Math.ceil(rem)+'s remaining':'Almost done...';},500);}
function finishDubProg(){clearInterval(dubProgInterval);document.getElementById('dubProgFill').style.width='100%';document.getElementById('dubProgPct').textContent='100%';document.getElementById('dubProgEta').textContent='Complete!';setTimeout(()=>{document.getElementById('dubProgWrap').style.display='none';},1500);}
function getStyle(){return{yPct:captionYPct,fontFamily:document.getElementById('fontFamily').value,fontSize:parseFloat(document.getElementById('fontSize').value),textColor:document.getElementById('textColor').value,outlineColor:document.getElementById('outlineColor').value,outlineWidth:parseFloat(document.getElementById('outlineWidth').value),textStyle:document.getElementById('textStyle').value,textCase:document.getElementById('textCase').value,shadowSize:parseFloat(document.getElementById('shadowSize').value)/100,captionMode,highlightColor:document.getElementById('highlightColor').value,enabled:document.getElementById('addToggle').checked};}
async function startTranslation(){const f=dubFileInput.files[0];if(!f){alert('Please select a video');return;}const btn=document.getElementById('translateBtn');btn.disabled=true;hide('dubDoneBox');hide('dubErrBox');startDubProg();const fd=new FormData();fd.append('video',f);fd.append('language',document.getElementById('langSelect').value);fd.append('captionStyle',JSON.stringify(getStyle()));fd.append('addCaption',document.getElementById('addToggle').checked?'true':'false');if(captionBox)fd.append('captionBox',JSON.stringify(captionBox));if(document.getElementById('removeToggle').checked)fd.append('removeCaption','true');try{const res=await fetch('/dub-speakers',{method:'POST',body:fd}),data=await res.json();finishDubProg();if(data.success){show('dubDoneBox');document.getElementById('dubResultVideo').src=data.videoUrl;document.getElementById('dubDlBtn').href=data.videoUrl;document.getElementById('dubDoneTitle').textContent=data.cached?'// DONE (cached)':'// DONE';}else{show('dubErrBox');document.getElementById('dubErrMsg').textContent=data.error;}}catch(err){finishDubProg();show('dubErrBox');document.getElementById('dubErrMsg').textContent='Could not reach the server.';}btn.disabled=false;}
const FONTS=[{name:'Impact',family:'Impact'},{name:'Anton',family:'Anton'},{name:'Bebas Neue',family:'BebasNeue'},{name:'Oswald Bold',family:'Oswald'},{name:'Barlow Condensed',family:'BarlowCondensed'},{name:'Fjalla One',family:'FjallaOne'},{name:'Roboto Bold',family:'Roboto'},{name:'Poppins Bold',family:'Poppins'},{name:'Lato Bold',family:'Lato'},{name:'Ubuntu Bold',family:'Ubuntu'},{name:'Bangers',family:'Bangers'},{name:'Pacifico',family:'Pacifico'},{name:'Permanent Marker',family:'PermanentMarker'},{name:'Righteous',family:'Righteous'},{name:'Montserrat Bold',family:'Montserrat'}];
function renderFontList(fonts){document.getElementById('fontList').innerHTML=fonts.map(f=>'<div onclick="selectFont(\''+f.family+'\',\''+f.name+'\')" style="padding:6px 9px;font-size:11px;cursor:pointer;color:var(--tx);" onmouseover="this.style.background=\'var(--s4)\'" onmouseout="this.style.background=\'\'"> '+f.name+'</div>').join('');}
function filterFonts(q){document.getElementById('fontList').style.display='block';renderFontList(FONTS.filter(f=>f.name.toLowerCase().includes(q.toLowerCase())));}
function selectFont(family,name){document.getElementById('fontFamily').value=family;document.getElementById('fontSelected').textContent='Selected: '+name;document.getElementById('fontSearch').value=name;document.getElementById('fontList').style.display='none';savePreset();document.fonts.load('bold 40px '+family).then(()=>drawOverlay()).catch(()=>drawOverlay());}
document.addEventListener('click',e=>{if(!e.target.closest('.sfi'))document.getElementById('fontList').style.display='none';});
renderFontList(FONTS);
function toggleStylePanel(){const inner=document.getElementById('styleInner'),arrow=document.getElementById('styleArrow'),collapsed=inner.style.display==='none';inner.style.display=collapsed?'block':'none';arrow.textContent=collapsed?'v':'>';}
function setMode(mode){captionMode=mode;['single','multi','highlight'].forEach(m=>{const el=document.getElementById('mode'+m.charAt(0).toUpperCase()+m.slice(1));if(el)el.classList.toggle('active',m===mode);});document.getElementById('hlColorRow').style.display=mode==='highlight'?'flex':'none';drawOverlay();}
function savePreset(){try{localStorage.setItem('dubshorts_preset',JSON.stringify({yPct:captionYPct,fontFamily:document.getElementById('fontFamily').value,fontSearch:document.getElementById('fontSearch').value,fontSize:document.getElementById('fontSize').value,textStyle:document.getElementById('textStyle').value,textCase:document.getElementById('textCase').value,textColor:document.getElementById('textColor').value,outlineColor:document.getElementById('outlineColor').value,outlineWidth:document.getElementById('outlineWidth').value,shadowSize:document.getElementById('shadowSize').value,captionMode,highlightColor:document.getElementById('highlightColor').value,language:document.getElementById('langSelect').value,removeCaption:document.getElementById('removeToggle').checked,addCaption:document.getElementById('addToggle').checked,captionBox}));}catch(e){}}
function loadPreset(){try{const p=JSON.parse(localStorage.getItem('dubshorts_preset'));if(!p)return;if(p.yPct!==undefined){captionYPct=p.yPct;document.getElementById('yPos').value=p.yPct;document.getElementById('yposVal').textContent=p.yPct+'%';}if(p.fontFamily)document.getElementById('fontFamily').value=p.fontFamily;if(p.fontSearch)document.getElementById('fontSearch').value=p.fontSearch;if(p.fontSize){document.getElementById('fontSize').value=p.fontSize;document.getElementById('sizeVal').textContent=p.fontSize+'%';}if(p.textStyle)document.getElementById('textStyle').value=p.textStyle;if(p.textCase)document.getElementById('textCase').value=p.textCase;if(p.textColor)document.getElementById('textColor').value=p.textColor;if(p.outlineColor)document.getElementById('outlineColor').value=p.outlineColor;if(p.outlineWidth){document.getElementById('outlineWidth').value=p.outlineWidth;document.getElementById('outlineVal').textContent=p.outlineWidth+'%';}if(p.shadowSize){document.getElementById('shadowSize').value=p.shadowSize;document.getElementById('shadowVal').textContent=p.shadowSize+'%';}if(p.captionMode)setMode(p.captionMode);if(p.highlightColor)document.getElementById('highlightColor').value=p.highlightColor;if(p.language){document.getElementById('langSelect').value=p.language;updateTranslateBtn();}if(p.removeCaption){document.getElementById('removeToggle').checked=true;onRemove();}if(p.addCaption){document.getElementById('addToggle').checked=true;onAdd();}if(p.captionBox){captionBox=p.captionBox;document.getElementById('clearBtn').style.display='block';drawOverlay();}}catch(e){}}
function show(id){document.getElementById(id).style.display='block';}
function hide(id){document.getElementById(id).style.display='none';}
loadPreset();updateHint();updateTranslateBtn();
const _sp=localStorage.getItem('dubshorts_preset'),_sf=_sp?JSON.parse(_sp).fontFamily:null,_sn=_sp?JSON.parse(_sp).fontSearch:null;
if(_sf&&_sn)selectFont(_sf,_sn);else selectFont('Impact','Impact');
</script>
</body>
</html>'''

with open('/Users/kanemcgregor/dubshorts/caption-remover/index.html', 'w') as f:
    f.write(content)

print('Done! Lines written:', content.count('\n'))
