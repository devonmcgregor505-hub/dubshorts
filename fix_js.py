content = open('/Users/kanemcgregor/dubshorts/caption-remover/index.html').read()

old = 'function show(id){'

new = """async function startFastRemoval(){
  const f=remFileInput.files[0];if(!f)return;
  if(!remBox){alert('Draw a box over the captions first');return;}
  const btn=document.getElementById('remBtnFast');
  btn.disabled=true;hide('remDoneBox');hide('remErrBox');startRemProg();
  document.getElementById('remProgLbl').textContent='Running ffmpeg delogo...';
  const fd=new FormData();
  fd.append('video',f);
  fd.append('captionBox',JSON.stringify(remBox));
  try{
    const res=await fetch('/remove-captions-fast',{method:'POST',body:fd});
    const data=await res.json();
    finishRemProg();
    if(data.success){
      show('remDoneBox');
      document.getElementById('remDlBtn').href=data.videoUrl;
      remPreviewVideo.src=data.videoUrl;
      remPreviewVideo.controls=true;
      document.getElementById('remPreviewLbl').textContent='RESULT - FAST MODE';
    } else {
      show('remErrBox');
      document.getElementById('remErrMsg').textContent=data.error;
    }
  }catch(err){
    finishRemProg();
    show('remErrBox');
    document.getElementById('remErrMsg').textContent='Server error: '+err.message;
  }
  btn.disabled=false;
}
function show(id){"""

content = content.replace(old, new)
open('/Users/kanemcgregor/dubshorts/caption-remover/index.html', 'w').write(content)
print('JS added!')
