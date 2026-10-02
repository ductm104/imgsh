const T = window.__TAURI__;

const FOLDER_SVG = `<svg viewBox="0 0 64 64" fill="none">
  <path d="M4 16a6 6 0 0 1 6-6h12l6 7h26a6 6 0 0 1 6 6v25a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6V16z" fill="#64A9FF"/>
  <path d="M4 22a6 6 0 0 1 6-6h50a6 6 0 0 1 6 6v26a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6V22z" fill="#9CC8FF"/>
  <path d="M4 24h56v24a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6V24z" fill="#E3F0FF"/>
</svg>`;

let hosts = [];
let online = [];
let opened = null; // null = home (folder list), string = machine view
let currentFiles = [];
let uploading = 0;
let openSeq = 0;
let refreshing = false;
// View history for mouse back/forward buttons: null = home, string = alias.
let navHistory = [null];
let navIndex = 0;
let suppressRecord = false;

function recordNav() {
  if (suppressRecord) return;
  if (navHistory[navIndex] === opened) return;
  navHistory = navHistory.slice(0, navIndex + 1);
  navHistory.push(opened);
  navIndex = navHistory.length - 1;
  if (navHistory.length > 50) {
    navHistory.shift();
    navIndex--;
  }
}

function isPreviewOpen() {
  return !$("preview-modal").classList.contains("hidden");
}

function goBack() {
  if (isPreviewOpen()) {
    closePreview();
    return;
  }
  if (navIndex <= 0) return;
  navIndex--;
  const target = navHistory[navIndex];
  suppressRecord = true;
  try {
    if (target === null) closeToHome();
    else openHost(target);
  } finally {
    suppressRecord = false;
  }
}

function goForward() {
  if (isPreviewOpen()) return;
  if (navIndex >= navHistory.length - 1) return;
  navIndex++;
  const target = navHistory[navIndex];
  suppressRecord = true;
  try {
    if (target === null) closeToHome();
    else openHost(target);
  } finally {
    suppressRecord = false;
  }
}
const fileCache = new Map(); // alias -> { files, at }
const CACHE_FRESH_MS = 30000;
const LS_CACHE_KEY = "imgsh.fileCache.v1";
const LS_HOSTS_KEY = "imgsh.hosts.v1";
let keepaliveTimer = null;

// Persist listings to localStorage so quit/reopen shows last-known files
// instantly (stale-while-revalidate) instead of an empty view.
try {
  const saved = JSON.parse(localStorage.getItem(LS_CACHE_KEY) || "{}");
  for (const [alias, e] of Object.entries(saved)) {
    if (e && Array.isArray(e.files)) fileCache.set(alias, { files: e.files, at: e.at || 0 });
  }
} catch {}
function persistCache() {
  try {
    const obj = {};
    for (const [alias, e] of fileCache) obj[alias] = e;
    localStorage.setItem(LS_CACHE_KEY, JSON.stringify(obj));
  } catch {}
}

function cacheGet(alias) {
  const e = fileCache.get(alias);
  return e ? e.files : null;
}
function cacheFresh(alias) {
  const e = fileCache.get(alias);
  return e && Date.now() - e.at < CACHE_FRESH_MS ? e.files : null;
}
function cacheSet(alias, files) {
  fileCache.set(alias, { files, at: Date.now() });
  persistCache();
}
function cacheInvalidate(alias) {
  fileCache.delete(alias);
  persistCache();
}
// Background handshakes: fetch every online host's listing right after
// scan, so masters are warm and open() finds data already cached.
function warmupHosts(list) {
  if (!invoke || !list.length) return;
  for (const h of list) {
    invoke("list_remote_files", { alias: h.alias }).then(
      (files) => cacheSet(h.alias, files),
      () => {}
    );
  }
}
// Keep SSH masters alive so later opens reuse them (matches 10m persist).
function startKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = setInterval(() => {
    for (const h of online) invoke("check_host", { alias: h.alias }).catch(() => {});
  }, 4 * 60 * 1000);
}

const $ = (id) => document.getElementById(id);
const invoke = T ? T.core.invoke.bind(T.core) : null;

function toast(msg, kind = "") {
  const box = $("toasts");
  box.innerHTML = "";
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function fmtSize(n) {
  if (!n) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

// ---------- views: home (folders) <-> machine (opened folder) ----------

function showHome() {
  opened = null;
  setMachineLoading(false);
  $("topbar").classList.remove("hidden");
  $("view-machine").classList.add("hidden");
  $("view-home").classList.remove("hidden");
}

function setMachineLoading(on, alias) {
  const el = $("machine-loading");
  if (!el) return;
  if (on) {
    if (alias) $("loading-host").textContent = alias;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

function showMachine(alias) {
  opened = alias;
  setMachineLoading(false);
  $("topbar").classList.add("hidden");
  $("view-home").classList.add("hidden");
  $("view-machine").classList.remove("hidden");
  $("detail-title").textContent = "📁 " + alias;
  $("dz-target").textContent = alias + ":/tmp/imgsh/";
  renderJustUploaded();
  const cached = cacheGet(alias);
  renderFiles(cached || []);
}

// ---------- scan: list config, keep only hosts that connect ----------

async function loadHosts() {
  const grid = $("hosts");
  showHome();
  // Rescan is a fresh start, not a back/forward step.
  navHistory = [null];
  navIndex = 0;
  if (!invoke) {
    grid.innerHTML = `<div class="empty">Tauri API not available (window.__TAURI__ missing).<br/>Run via <code>bun run dev</code>, not by opening the HTML file.</div>`;
    return;
  }
  // Instant paint: show last-known hosts from the previous session while
  // re-scanning in background, so reopen never shows an empty window.
  let paintedCache = false;
  try {
    const saved = JSON.parse(localStorage.getItem(LS_HOSTS_KEY) || "null");
    if (saved && Array.isArray(saved.online) && saved.online.length) {
      hosts = saved.hosts || [];
      online = saved.online;
      grid.innerHTML = "";
      for (const h of online) grid.appendChild(hostCard(h));
      paintedCache = true;
    }
  } catch {}
  if (!paintedCache) {
    grid.innerHTML = `<div class="startup-loading" role="status"><div class="spinner" aria-hidden="true"></div><div class="loading-title">Connecting…</div><div class="loading-sub">Checking your SSH hosts</div></div>`;
  }
  try {
    hosts = await invoke("list_ssh_hosts");
  } catch (e) {
    if (!paintedCache) {
      grid.innerHTML = `<div class="empty">Failed to scan SSH hosts: ${e}</div>`;
    } else {
      toast(String(e), "err");
    }
    return;
  }
  if (!hosts.length) {
    grid.innerHTML = `<div class="empty">No hosts found in ~/.ssh/config.<br/>Add a Host entry, then Rescan.</div>`;
    return;
  }
  const results = await Promise.all(
    hosts.map(async (h) => {
      try {
        return { host: h, ok: await invoke("check_host", { alias: h.alias }) };
      } catch {
        return { host: h, ok: false };
      }
    })
  );
  online = results.filter((r) => r.ok).map((r) => r.host);

  grid.innerHTML = "";
  if (!online.length) {
    grid.innerHTML = `<div class="empty">Found ${hosts.length} host(s) but none are reachable.<br/>Check network / VPN, then Rescan.</div>`;
  }
  for (const h of online) {
    grid.appendChild(hostCard(h));
  }
  try {
    localStorage.setItem(LS_HOSTS_KEY, JSON.stringify({ hosts, online, at: Date.now() }));
  } catch {}
  warmupHosts(online);
  startKeepalive();
}

function hostCard(h) {
  const card = document.createElement("div");
  card.className = "host";
  card.dataset.alias = h.alias;
  card.innerHTML = `<span class="dot on"></span>${FOLDER_SVG}
    <div class="alias"></div><div class="target"></div>`;
  card.querySelector(".alias").textContent = h.alias;
  card.querySelector(".target").textContent =
    (h.user ? h.user + "@" : "") + h.hostname;
  card.title = `Click to open ${h.alias}`;
  // Single handler only: dblclick fires click x2 + dblclick = 3 loads.
  // Opening on first click makes single AND double click feel instant.
  card.onclick = () => openHost(h.alias);
  return card;
}

// ---------- open / close ----------

async function openHost(alias) {
  // De-dupe rapid clicks (double-click) into one load.
  if (opened === alias && refreshing) return;
  const seq = ++openSeq;
  showMachine(alias);
  recordNav();
  // Already handshaked + cached in background: just open, no SSH wait.
  const fresh = cacheFresh(alias);
  if (fresh) {
    setMachineLoading(false);
    renderFiles(fresh);
    refreshing = false;
    return;
  }
  // Cold open: show loading screen instead of empty/black view
  // while the SSH handshake + listing runs.
  setMachineLoading(true, alias);
  refreshing = true;
  try {
    const files = await invoke("list_remote_files", { alias });
    if (seq !== openSeq || opened !== alias) return; // stale
    cacheSet(alias, files);
    renderFiles(files);
  } catch (e) {
    if (seq !== openSeq) return;
    toast(String(e), "err");
  } finally {
    if (seq === openSeq) {
      setMachineLoading(false);
      refreshing = false;
    }
  }
}

function closeToHome() {
  openSeq++; // cancel any in-flight open
  refreshing = false;
  showHome();
  recordNav();
}

async function refreshFiles() {
  if (!opened) return;
  const alias = opened;
  const seq = ++openSeq;
  refreshing = true;
  const btn = $("refresh");
  const hadFiles = ($("files")?.children.length || 0) > 0;
  if (!hadFiles) setMachineLoading(true, alias);
  else if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }
  try {
    const files = await invoke("list_remote_files", { alias });
    if (seq !== openSeq || opened !== alias) return;
    cacheSet(alias, files);
    renderFiles(files);
  } catch (e) {
    if (seq !== openSeq) return;
    toast(String(e), "err");
  } finally {
    if (seq === openSeq) {
      setMachineLoading(false);
      refreshing = false;
      if (btn) { btn.disabled = false; btn.textContent = "Refresh"; }
    }
  }
}

function sortLatestFirst(files) {
  return [...(files || [])].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return b.name.localeCompare(a.name);
  });
}

function renderFiles(files) {
  currentFiles = sortLatestFirst(files);
  const ul = $("files");
  ul.innerHTML = "";
  for (const f of currentFiles) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "fn";
    name.textContent = f.name;
    const meta = document.createElement("span");
    meta.className = "fm";
    meta.textContent = f.is_dir ? f.modified : `${fmtSize(f.size)} · ${f.modified}`;
    li.append(name, meta);
    if (!f.is_dir && opened) {
      const full = `/tmp/imgsh/${f.name}`;
      name.title = full + " — click to preview";
      name.onclick = () => previewFile(opened, f.name);
      const btns = document.createElement("span");
      btns.className = "rowbtns";
      if (isImage(f.name)) {
        const pv = document.createElement("button");
        pv.className = "del";
        pv.textContent = "👁";
        pv.title = "Preview image";
        pv.onclick = (ev) => {
          ev.stopPropagation();
          previewFile(opened, f.name);
        };
        btns.appendChild(pv);
      }
      const cp = document.createElement("button");
      cp.className = "del";
      cp.textContent = "⧉";
      cp.title = "Copy full path";
      cp.onclick = (ev) => {
        ev.stopPropagation();
        copyText(full);
      };
      btns.appendChild(cp);
      li.appendChild(btns);
      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "×";
      del.title = "Delete from remote";
      del.onclick = async (ev) => {
        ev.stopPropagation();
        if (!del.dataset.armed) {
          del.dataset.armed = "1";
          del.textContent = "?";
          del.title = `Click again to delete ${f.name}`;
          setTimeout(() => {
            if (del.isConnected) {
              delete del.dataset.armed;
              del.textContent = "×";
              del.title = "Delete from remote";
            }
          }, 3000);
          return;
        }
        delete del.dataset.armed;
        del.textContent = "×";
        try {
          await invoke("delete_remote_file", { alias: opened, name: f.name });
          toast("Deleted " + f.name, "ok");
          cacheInvalidate(opened);
          refreshFiles();
        } catch (e) {
          toast(String(e), "err");
        }
      };
      li.appendChild(del);
    }
    ul.appendChild(li);
  }
}

// ---------- upload (only inside an opened folder) ----------

function trackStart(label) {
  uploading++;
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    toast("Copied: " + t, "ok");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      toast("Copied: " + t, "ok");
    } catch {
      toast(t);
    }
    ta.remove();
  }
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];

function isImage(name) {
  const ext = name.split(".").pop().toLowerCase();
  return IMAGE_EXTS.includes(ext);
}

function mimeFor(name) {
  const ext = name.split(".").pop().toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "svg") return "image/svg+xml";
  return "image/" + ext;
}

// Session history of pasted/uploaded files per host.
// Shown as "Just pasted" list so the user can click-copy paths manually.
// No auto-copy to clipboard.
const justUploadedByHost = new Map(); // alias -> [{ name, path, size }]

function renderJustUploaded() {
  const box = $("just-uploaded");
  const ul = $("just-uploaded-list");
  if (!box || !ul) return;
  const items = opened ? justUploadedByHost.get(opened) || [] : [];
  ul.innerHTML = "";
  if (!items.length) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  // Newest first.
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const full = it.path;
    const li = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = full;
    code.title = "Click to preview";
    code.onclick = () => {
      if (opened) previewFile(opened, it.name);
      else copyText(full);
    };
    const meta = document.createElement("span");
    meta.className = "ju-meta";
    meta.textContent = it.size ? fmtSize(it.size) : "";
    const cp = document.createElement("button");
    cp.className = "del";
    cp.textContent = "⧉";
    cp.title = "Copy full path";
    cp.onclick = (ev) => {
      ev.stopPropagation();
      copyText(full);
    };
    li.append(code, meta, cp);
    ul.appendChild(li);
  }
}

function trackDone(alias, label, ok, msg, result) {
  uploading = Math.max(0, uploading - 1);
  if (ok) {
    const full = result.path;
    const list = justUploadedByHost.get(alias) || [];
    list.push({ name: result.name, path: result.path, size: result.size });
    justUploadedByHost.set(alias, list);
    if (opened === alias) renderJustUploaded();
    toast(`Uploaded ${result.name} (${fmtSize(result.size)}) → ${full}`, "ok");
    cacheInvalidate(alias);
    if (opened === alias) refreshFiles();
  } else {
    toast(`Failed ${label}: ${msg}`, "err");
  }
}

async function uploadFileObject(alias, file) {
  const name = file.name || "";
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!buf.length) {
    toast("Clipboard item is empty, nothing to upload", "err");
    return;
  }
  trackStart(`${name || "clipboard image"} (${fmtSize(buf.length)})`);
  try {
    const result = await invoke("upload_bytes", {
      alias,
      filename: name,
      data: Array.from(buf),
    });
    trackDone(alias, result.name, true, "", result);
  } catch (e) {
    trackDone(alias, name || "clipboard image", false, String(e));
  }
}

async function uploadTauriPath(alias, path) {
  const short = path.split("/").pop();
  trackStart(short);
  try {
    const result = await invoke("upload_local_path", { alias, localPath: path });
    trackDone(alias, result.name, true, "", result);
  } catch (e) {
    trackDone(alias, short, false, String(e));
  }
}

function needTarget() {
  if (!opened) {
    toast("Open a machine folder first (double-click it)", "err");
    return false;
  }
  return true;
}

async function collectClipboardFiles(dt) {
  const out = [];
  if (dt?.files?.length) return [...dt.files];
  if (dt?.items?.length) {
    for (const it of dt.items) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}

// paste / drop only work inside the opened folder
document.addEventListener("paste", async (e) => {
  if (!opened) return;
  const files = await collectClipboardFiles(e.clipboardData);
  if (files.length) {
    e.preventDefault();
    for (const f of files) await uploadFileObject(opened, f);
  }
});

// ---------- image preview (downloads from remote, shows locally) ----------

let previewUrl = null;

async function previewFile(alias, name) {
  const modal = $("preview-modal");
  modal.classList.remove("hidden");
  $("preview-name").textContent = name;
  const full = `/tmp/imgsh/${name}`;
  $("preview-path").textContent = full;
  $("preview-path").title = "Click to copy";
  $("preview-path").onclick = () => copyText(full);
  const img = $("preview-img");
  img.removeAttribute("src");
  if (!isImage(name)) {
    img.classList.add("hidden");
    return;
  }
  img.classList.remove("hidden");
  try {
    const bytes = await invoke("download_file", { alias, name });
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(
      new Blob([new Uint8Array(bytes)], { type: mimeFor(name) })
    );
    img.src = previewUrl;
  } catch (e) {
    toast(String(e), "err");
  }
}

function closePreview() {
  $("preview-modal").classList.add("hidden");
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
}

// html5 drag & drop onto the opened folder's dropzone
const dz = $("dropzone");
["dragenter", "dragover"].forEach((ev) =>
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.add("over");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.remove("over");
  })
);
dz.addEventListener("drop", async (e) => {
  if (!opened || !needTarget()) return;
  const files = e.dataTransfer?.files;
  if (files && files.length) {
    for (const f of files) {
      if (f.path) await uploadTauriPath(opened, f.path);
      else await uploadFileObject(opened, f);
    }
  }
});

// native Finder drag & drop via Tauri events -> opened folder
if (T && T.event && T.event.listen) {
  T.event.listen("tauri://drag-drop", (ev) => {
    const list = ev.payload?.paths ?? [];
    if (list.length && opened) {
      for (const p of list) uploadTauriPath(opened, p);
    }
  });
}

$("preview-close").onclick = closePreview;
$("preview-copy").onclick = () => copyText($("preview-path").textContent);
$("preview-modal").addEventListener("click", (e) => {
  if (e.target.id === "preview-modal") closePreview();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("preview-modal").classList.contains("hidden")) closePreview();
    else if (opened) closeToHome();
  }
});
// Mouse back (button 3) / forward (button 4): mirror browser navigation.
// mousedown + mouseup + auxclick all preventDefaulted so the webview
// never triggers its own history navigation.
function handleMouseNav(e) {
  if (e.button === 3) {
    e.preventDefault();
    goBack();
  } else if (e.button === 4) {
    e.preventDefault();
    goForward();
  }
}
document.addEventListener("mousedown", handleMouseNav);
document.addEventListener("mouseup", handleMouseNav);
document.addEventListener("auxclick", handleMouseNav);
$("rescan").onclick = loadHosts;
$("refresh").onclick = refreshFiles;
$("back").onclick = closeToHome;
$("ju-clear").onclick = () => {
  if (!opened) return;
  justUploadedByHost.delete(opened);
  renderJustUploaded();
};

// NOTE: SSH masters are intentionally left running on quit so reopening
// within a few minutes reuses them (they idle-expire via ControlPersist=10m).
loadHosts();
