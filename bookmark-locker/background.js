const PREFIX = "locked_folder_";
const PENDING_KEY = "_pendingLockOps";

// ---------- Service Worker 生命周期 ----------
chrome.runtime.onStartup.addListener(recoverIfPending);
chrome.runtime.onInstalled.addListener(recoverIfPending);

// ---------- 辅助函数 ----------
function uuidv4() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,c=>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c/4).toString(16)
  );
}

async function getPendingOps() {
  const data = await chrome.storage.local.get(PENDING_KEY);
  return data[PENDING_KEY] || {};
}

async function setPendingOps(obj) {
  const data = {};
  data[PENDING_KEY] = obj;
  await chrome.storage.local.set(data);
}

async function clearPending(folderId) {
  const pending = await getPendingOps();
  delete pending[folderId];
  await setPendingOps(pending);
}

// ---------- 事务性恢复 ----------
async function recoverIfPending() {
  const pending = await getPendingOps();
  for (const folderId of Object.keys(pending)) {
    const op = pending[folderId];
    if (op.status === "pending" && op.backup) {
      try {
        await restoreFromSerialized(folderId, op.backup);
        await clearPending(folderId);
        console.log(`[BookmarkLocker] Recovered folder ${folderId}`);
      } catch (err) {
        console.error("Recovery failed:", err);
      }
    }
  }
}

// ---------- Bookmarks serialize / restore ----------
async function serializeNode(folderId) {
  const tree = await chrome.bookmarks.getSubTree(folderId);
  return tree && tree[0];
}

async function replaceWithPlaceholder(folderId, folderTitle) {
  const children = await chrome.bookmarks.getChildren(folderId);
  for (const c of children) await chrome.bookmarks.removeTree(c.id);
  await chrome.bookmarks.create({
    parentId: folderId,
    title: `🔒 Locked: ${folderTitle} (by Bookmark Locker)`,
    url: "about:blank"
  });
}

async function restoreFromSerialized(folderId, serialized) {
  const children = await chrome.bookmarks.getChildren(folderId);
  for (const c of children) await chrome.bookmarks.removeTree(c.id);

  async function createRec(parentId, node) {
    if (node.url) {
      await chrome.bookmarks.create({ parentId, title: node.title, url: node.url });
    } else {
      const f = await chrome.bookmarks.create({ parentId, title: node.title });
      if (node.children) {
        for (const ch of node.children) await createRec(f.id, ch);
      }
    }
  }

  if (serialized.children) {
    for (const ch of serialized.children) await createRec(folderId, ch);
  }
}

// ---------- Encryption ----------
async function getKeyMaterial(password) {
  const enc = new TextEncoder().encode(password);
  return crypto.subtle.importKey("raw", enc, "PBKDF2", false, ["deriveKey"]);
}

async function deriveKey(material, salt) {
  return crypto.subtle.deriveKey(
    { name:"PBKDF2", salt, iterations:200000, hash:"SHA-256" },
    material,
    { name:"AES-GCM", length:256 },
    false,
    ["encrypt","decrypt"]
  );
}

function ab2b64(buf) {
  const bytes = new Uint8Array(buf);
  let str = "";
  for(let i=0;i<bytes.length;i++) str += String.fromCharCode(bytes[i]);
  return btoa(str);
}

function b642ab(b64) {
  const str = atob(b64);
  const buf = new Uint8Array(str.length);
  for(let i=0;i<str.length;i++) buf[i] = str.charCodeAt(i);
  return buf.buffer;
}

// ---------- Export Locked ----------
async function exportLocked() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(PREFIX));
  const obj = {};
  for(const k of keys) obj[k] = all[k];
  const blob = new Blob([JSON.stringify(obj)], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename:"bookmarks_locked_export.json" });
}

// ---------- Message Handler ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  if(msg?.action==="getFolderTree"){
    chrome.bookmarks.getTree().then(tree=>{
      const folders=[];
      (function walk(nodes){
        for(const n of nodes){
          if(!n.url){
            folders.push({ id:n.id, title:n.title });
            if(n.children) walk(n.children);
          }
        }
      })(tree);
      sendResponse({folders});
    });
    return true;
  }

  if(msg?.action==="lockFolder"){
    (async()=>{
      const { folderId, password } = msg;

      // ---------- 判断是否已锁 ----------
      const exists = await chrome.storage.local.get(PREFIX+folderId);
      if(exists[PREFIX+folderId]){
        sendResponse({ok:false,error:"already_locked"});
        return;
      }

      // ---------- 事务性备份 ----------
      const version = uuidv4();
      const backup = await serializeNode(folderId);
      const folderTitle = backup.title || "(no title)";
      const pending = await getPendingOps();
      pending[folderId] = { status:"pending", title:folderTitle, backup };
      await setPendingOps(pending);

      // ---------- 加密 ----------
      const json = new TextEncoder().encode(JSON.stringify(backup));
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const keyMaterial = await getKeyMaterial(password);
      const key = await deriveKey(keyMaterial, salt);
      const cipher = await crypto.subtle.encrypt({name:"AES-GCM",iv}, key, json);
      const obj = {};
      obj[PREFIX+folderId]={ cipher:ab2b64(cipher), iv:ab2b64(iv), salt:ab2b64(salt), title:folderTitle, version, timestamp:Date.now()};
      await chrome.storage.local.set(obj);

      // ---------- 替换为锁定占位 ----------
      await replaceWithPlaceholder(folderId, folderTitle);
      await clearPending(folderId);

      sendResponse({ok:true});
    })();
    return true;
  }

  if(msg?.action==="unlockFolder"){
    (async()=>{
      const { folderId, password } = msg;
      const data = await chrome.storage.local.get(PREFIX+folderId);
      const saved = data[PREFIX+folderId];
      if(!saved) return sendResponse({ok:false,error:"no_saved"});
      try{
        const keyMaterial = await getKeyMaterial(password);
        const key = await deriveKey(keyMaterial, b642ab(saved.salt));
        const plain = await crypto.subtle.decrypt({name:"AES-GCM",iv:b642ab(saved.iv)},key,b642ab(saved.cipher));
        const node = JSON.parse(new TextDecoder().decode(plain));
        await restoreFromSerialized(folderId, node);
        await chrome.storage.local.remove(PREFIX+folderId);
        sendResponse({ok:true});
      }catch(e){
        sendResponse({ok:false,error:"bad_password"});
      }
    })();
    return true;
  }

  if(msg?.action==="export_locked"){
    exportLocked();
    sendResponse({ok:true});
  }
});
