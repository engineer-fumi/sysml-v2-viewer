/**
 * SysML v2 Viewer – companion server.
 *
 * Provides SSH/SFTP access for the browser UI (the browser itself cannot
 * open SSH connections) and serves the built app from ../dist.
 *
 *   node server/index.mjs            # http://localhost:3001
 *   PORT=8080 node server/index.mjs
 *
 * Credentials are used once to open the SSH session and are NOT stored;
 * sessions live in memory and expire after 30 minutes of inactivity.
 */
import express from "express";
import { Client } from "ssh2";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3001);
const SESSION_TTL_MS = 30 * 60 * 1000;
const SYSML_EXT = /\.(sysml|kerml)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__"]);

const app = express();
app.use(express.json({ limit: "20mb" }));

/** @type {Map<string, {client: import('ssh2').Client, sftp: any, label: string, lastUsed: number}>} */
const sessions = new Map();
let nextSessionId = 1;

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > SESSION_TTL_MS) {
      try { s.client.end(); } catch { /* ignore */ }
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

function getSession(req, res) {
  const id = req.query.session ?? req.body?.sessionId;
  const s = sessions.get(String(id));
  if (!s) {
    res.status(440).json({ error: "SSH セッションが見つかりません(期限切れの可能性)" });
    return null;
  }
  s.lastUsed = Date.now();
  return s;
}

// ---- connect ---------------------------------------------------------

app.post("/api/ssh/connect", (req, res) => {
  const { host, port = 22, username, password, privateKey, passphrase } = req.body ?? {};
  if (!host || !username) {
    return res.status(400).json({ error: "host と username は必須です" });
  }
  const client = new Client();
  let settled = false;

  client.on("ready", () => {
    client.sftp((err, sftp) => {
      if (settled) return;
      settled = true;
      if (err) {
        client.end();
        return res.status(500).json({ error: "SFTP の開始に失敗: " + err.message });
      }
      const id = String(nextSessionId++);
      sessions.set(id, { client, sftp, label: `${username}@${host}`, lastUsed: Date.now() });
      client.on("close", () => sessions.delete(id));
      sftp.realpath(".", (rpErr, home) => {
        res.json({ sessionId: id, label: `${username}@${host}`, home: rpErr ? "." : home });
      });
    });
  });

  client.on("error", (e) => {
    if (settled) return;
    settled = true;
    res.status(400).json({ error: "接続に失敗: " + e.message });
  });

  try {
    client.connect({
      host,
      port: Number(port) || 22,
      username,
      password: password || undefined,
      privateKey: privateKey || undefined,
      passphrase: passphrase || undefined,
      readyTimeout: 15000,
      tryKeyboard: false,
    });
  } catch (e) {
    if (!settled) {
      settled = true;
      res.status(400).json({ error: "接続に失敗: " + e.message });
    }
  }
});

app.post("/api/ssh/disconnect", (req, res) => {
  const s = sessions.get(String(req.body?.sessionId));
  if (s) {
    try { s.client.end(); } catch { /* ignore */ }
    sessions.delete(String(req.body.sessionId));
  }
  res.json({ ok: true });
});

// ---- directory listing / scan ---------------------------------------

function readdir(sftp, dir) {
  return new Promise((resolve, reject) =>
    sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list)))
  );
}

app.get("/api/ssh/list", async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  const dir = String(req.query.path || ".");
  try {
    const list = await readdir(s.sftp, dir);
    res.json({
      entries: list
        .map((e) => ({
          name: e.filename,
          type: e.attrs.isDirectory() ? "dir" : "file",
          size: e.attrs.size,
        }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Recursively find .sysml/.kerml files below a directory. */
app.get("/api/ssh/scan", async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  const root = String(req.query.path || ".");
  const found = [];
  const MAX_FILES = 200;
  const MAX_DEPTH = 8;

  async function walk(dir, depth) {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
    let list;
    try {
      list = await readdir(s.sftp, dir);
    } catch {
      return; // unreadable dir – skip
    }
    for (const e of list) {
      if (found.length >= MAX_FILES) return;
      const p = dir.replace(/\/$/, "") + "/" + e.filename;
      if (e.attrs.isDirectory()) {
        if (e.filename.startsWith(".") || SKIP_DIRS.has(e.filename)) continue;
        await walk(p, depth + 1);
      } else if (SYSML_EXT.test(e.filename)) {
        found.push(p);
      }
    }
  }

  try {
    await walk(root, 0);
    res.json({ files: found });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- read / write ----------------------------------------------------

app.get("/api/ssh/read", (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  const p = String(req.query.path || "");
  s.sftp.readFile(p, "utf8", (err, data) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ content: data });
  });
});

app.put("/api/ssh/write", (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  const { path: p, content } = req.body ?? {};
  if (!p || typeof content !== "string") {
    return res.status(400).json({ error: "path と content は必須です" });
  }
  s.sftp.writeFile(p, content, "utf8", (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// ---- static app ------------------------------------------------------

const dist = path.resolve(__dirname, "../dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.listen(PORT, () => {
  console.log(`SysML v2 Viewer server: http://localhost:${PORT}`);
  if (!fs.existsSync(dist)) {
    console.log("(dist/ がないため API のみ提供。開発時は `npm run dev` と併用してください)");
  }
});
