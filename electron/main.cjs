// SERVARI — the operating system shell (Electron entry).
// The exe is the WINDOW; the shell server (server/servari_server.py) is LAUNCHED
// from the project at runtime (not bundled). Home-resolution is robust for the
// packaged portable exe, whose __dirname points at a temp extraction dir — it
// finds the real project via env var, then the dev-relative path.
const { app, BrowserWindow, session, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");

// Bind address mirrors the server's env config (SERVARI_HOST / SERVARI_PORT),
// so the window targets the same address the launched server binds to. Defaults
// to localhost:8911. The launched server inherits this process's env.
const HOST = (process.env.SERVARI_HOST || "").trim() || "127.0.0.1";
const PORT = (() => {
  const raw = (process.env.SERVARI_PORT || "").trim();
  const p = parseInt(raw, 10);
  return raw && p >= 1 && p <= 65535 ? p : 8911;
})();
const URL = `http://${HOST}:${PORT}/`;

// --- home resolution -------------------------------------------------------------------------
// Order: SERVARI_HOME env -> portable exe location -> dev-relative -> cwd.
// A "home" is any directory that contains server/servari_server.py.
function isHome(p) {
  try {
    return fs.existsSync(path.join(p, "server", "servari_server.py"));
  } catch (_) {
    return false;
  }
}
function candidateDirsFrom(p) {
  if (!p) return [];
  const base = path.resolve(p);
  return [base, path.resolve(base, ".."), path.resolve(base, "..", "..")];
}
function resolveHome() {
  if (process.env.SERVARI_HOME && isHome(process.env.SERVARI_HOME)) return process.env.SERVARI_HOME;
  const portableDirs = [
    ...candidateDirsFrom(process.env.PORTABLE_EXECUTABLE_DIR),
    ...candidateDirsFrom(process.env.PORTABLE_EXECUTABLE_FILE ? path.dirname(process.env.PORTABLE_EXECUTABLE_FILE) : ""),
  ];
  for (const p of portableDirs) {
    if (isHome(p)) return p;
  }
  // electron/main.cjs lives one level below the repo root.
  const repoRoot = path.resolve(__dirname, "..");
  if (isHome(repoRoot)) return repoRoot;
  // also try the current working directory (or its parents, when launched from dist-exe).
  const cwd = process.cwd();
  for (const p of candidateDirsFrom(cwd)) {
    if (isHome(p)) return p;
  }
  return null;
}
const ROOT = resolveHome();

// Resolve the Python interpreter. Prefer a configured one (SERVARI_PYTHON),
// otherwise fall back to "python" on PATH.
function resolvePython() {
  const configured = process.env.SERVARI_PYTHON;
  try {
    if (configured && fs.existsSync(configured)) return configured;
  } catch (_) {}
  const candidates = [
    ROOT ? path.join(ROOT, ".venv", "Scripts", "python.exe") : "",
    ROOT ? path.join(ROOT, "venv", "Scripts", "python.exe") : "",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "hermes", "hermes-agent", "venv", "Scripts", "python.exe")
      : "",
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return "python";
}

let shellProc = null; // only set if WE start the server (so we only kill what we started)

function pingShell() {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: "/api/health", timeout: 800 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startShell() {
  if (!ROOT) return; // no home found - window will show the connection-failed retry loop
  const py = resolvePython();
  shellProc = spawn(py, [path.join(ROOT, "server", "servari_server.py")], {
    cwd: ROOT,
    stdio: "ignore",
    windowsHide: true,
  });
  shellProc.on("error", (e) => console.error(`[servari] could not start shell with '${py}':`, e.message));
}

async function waitForShell(tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await pingShell()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function createWindow() {
  const iconPath = path.join(__dirname, "servari.ico");
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    backgroundColor: "#0F1218",
    title: "SERVARI",
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    show: false, // show maximized once ready (no white flash, OS-feel)
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // Better startup feel: transparent shell surface, then show only when ready.
  win.setMenuBarVisibility(false);
  win.once("ready-to-show", () => {
    win.show();
  });
  win.maximize();
  win.loadURL(URL);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://${HOST}:${PORT}`)) {
      return { action: "allow" };
    }
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "deny" };
  });
  win.webContents.on("did-fail-load", () => {
    setTimeout(() => win.loadURL(URL), 1000);
  });
  // F11 = fullscreen toggle
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "F11") {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });
}

app.whenReady().then(async () => {
  // CACHE KILL: the exe's disk cache can serve stale bundles across restarts, so
  // server-side fixes never reach the window. Wipe the cache on every launch.
  try {
    await session.defaultSession.clearCache();
  } catch (_) {}

  // VOICE: auto-grant microphone/media permission to our own localhost shell (and nothing else).
  // BOTH handlers are required: the CHECK handler is consulted synchronously by
  // getUserMedia/enumerateDevices BEFORE the request handler ever fires — without
  // it the mic dies silently in the packaged exe.
  const isOurShellUrl = (u) => (u || "").startsWith(`http://${HOST}:${PORT}/`);
  const MEDIA_PERMS = new Set(["media", "audioCapture", "mediaKeySystem", "speaker-selection"]);

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const ok = isOurShellUrl(webContents.getURL()) && MEDIA_PERMS.has(permission);
    callback(ok);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const origin = requestingOrigin || (webContents ? webContents.getURL() : "");
    return isOurShellUrl(origin) && MEDIA_PERMS.has(permission);
  });

  const alreadyUp = await pingShell();
  if (!alreadyUp) startShell();
  await waitForShell();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (shellProc) {
    try {
      shellProc.kill();
    } catch (_) {}
  }
  app.quit();
});
