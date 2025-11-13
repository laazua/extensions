const folderSelect = document.getElementById("folders");
const lockBtn = document.getElementById("lockBtn");
const unlockBtn = document.getElementById("unlockBtn");
const exportBtn = document.getElementById("exportBtn");
const passwordInput = document.getElementById("password");
const statusEl = document.getElementById("status");

function setStatus(text, ok=true){ statusEl.textContent=text; statusEl.style.color=ok?"green":"red"; }
async function sendToBg(msg){ return new Promise(res=>chrome.runtime.sendMessage(msg,res)); }

async function init(){
  setStatus("Loading folders...");
  const resp = await sendToBg({action:"getFolderTree"});
  folderSelect.innerHTML="";
  resp.folders.forEach(f=>{
    const opt=document.createElement("option");
    opt.value=f.id; opt.textContent=`${f.title || "(root)"} — ${f.id}`;
    folderSelect.appendChild(opt);
  });
  setStatus("Ready",true);
}
init();

lockBtn.addEventListener("click",async()=>{
  const folderId=folderSelect.value,password=passwordInput.value;
  if(!folderId||!password){setStatus("Select folder & enter password",false);return;}
  setStatus("Locking...");
  const r=await sendToBg({action:"lockFolder",folderId,password});
  if(r.ok){
    setStatus("Locked ✓",true);
  } else if(r.error==="already_locked") {
    setStatus("This folder is already locked",false);
  } else {
    setStatus("Lock failed",false);
  }
});


unlockBtn.addEventListener("click",async()=>{
  const folderId=folderSelect.value,password=passwordInput.value;
  if(!folderId||!password){setStatus("Select folder & enter password",false);return;}
  setStatus("Unlocking...");
  const r=await sendToBg({action:"unlockFolder",folderId,password});
  if(r.ok)setStatus("Unlocked ✓",true);
  else setStatus(r.error==="no_saved"?"No locked data":"Wrong password/data corrupt",false);
});

exportBtn.addEventListener("click",async()=>{
  await sendToBg({action:"export_locked"});
  setStatus("Export started",true);
});
