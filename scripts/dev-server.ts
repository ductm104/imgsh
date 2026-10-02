import { watch } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT ?? "1420");
const DIST = path.resolve(import.meta.dir, "../dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

const RELOAD_SNIPPET = `<script>
(() => {
  const url = "ws://" + location.host + "/__reload";
  let manual = false;
  function connect() {
    const ws = new WebSocket(url);
    ws.onmessage = (e) => { if (e.data === "reload") location.reload(); };
    ws.onopen = () => console.log("[dev] live-reload connected");
    ws.onclose = () => { if (!manual) setTimeout(connect, 500); };
    window.addEventListener("beforeunload", () => { manual = true; try { ws.close(); } catch {} });
  }
  connect();
})();
</script>`;

const clients = new Set<any>();
let timer: Timer | null = null;
function broadcastReload() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    for (const ws of clients) {
      try {
        ws.send("reload");
      } catch {}
    }
    console.log("[dev] reloaded clients on dist/ change");
  }, 120);
}

try {
  const watcher = watch(DIST, { recursive: true }, (_evt, file) => {
    if (file?.toString().includes(".DS_Store")) return;
    broadcastReload();
  });
  watcher.on("error", (e) => console.error("[dev] watcher error:", e.message));
} catch (e: any) {
  console.error("[dev] cannot watch dist/:", e?.message ?? e);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/__reload") {
      if (server.upgrade(req)) return undefined as any;
      return new Response("websocket expected", { status: 400 });
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const filePath = path.normalize(path.join(DIST, rel));
    if (!filePath.startsWith(DIST)) return new Response("forbidden", { status: 403 });
    const file = Bun.file(filePath);
    return file.exists().then((ok) => {
      if (!ok) {
        const fallback = Bun.file(path.join(DIST, "index.html"));
        return fallback.exists().then((has) =>
          has
            ? injectReload(fallback)
            : new Response("not found", { status: 404 }),
        );
      }
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".html") return injectReload(file);
      return new Response(file, {
        headers: { "Content-Type": MIME[ext] ?? "application/octet-stream" },
      });
    });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
    },
    close(ws) {
      clients.delete(ws);
    },
    message() {},
  },
});

async function injectReload(file: any) {
  let html = await file.text();
  if (html.includes("/__reload")) return new Response(html, { headers: { "Content-Type": MIME[".html"] } });
  html = html.includes("</body>")
    ? html.replace("</body>", `${RELOAD_SNIPPET}</body>`)
    : html + RELOAD_SNIPPET;
  return new Response(html, { headers: { "Content-Type": MIME[".html"] } });
}

console.log(`[dev] serving ${DIST} at http://127.0.0.1:${server.port}/`);
