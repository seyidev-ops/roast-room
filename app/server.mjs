import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { APP_ROOT, env } from "./lib/env.mjs";
import { loadRoster, BOARD, PUBLIC as PUBLIC_MODE } from "./lib/seats.mjs";
import { startCouncil, getSession, subscribe, listSaved, loadSaved, MODELS } from "./lib/council.mjs";
import { usage } from "./lib/anthropic.mjs";
import * as watch from "./lib/watch.mjs";

const PORT = Number(process.env.PORT) || 4730;
const PUBLIC = path.join(APP_ROOT, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8" };

let running = null; // one council at a time (API runner, local)
const runningSet = new Set(); // public edition: several councils at once
const MAX_RUNNING = Number(process.env.MAX_RUNNING || 3);

// ---- Public edition: every roast is paid for first (Paystack), then runs on the Anthropic API ----
const PAY = {
  link: process.env.ROAST_PAY_LINK || "",
  priceNgn: Number(process.env.ROAST_PRICE_NGN || 15000),
  priceUsd: Number(process.env.ROAST_PRICE_USD || 10),
  minNgn: Number(process.env.ROAST_MIN_NGN || process.env.ROAST_PRICE_NGN || 15000),
  minUsd: Number(process.env.ROAST_MIN_USD || process.env.ROAST_PRICE_USD || 10),
  site: process.env.SITE_URL || "https://oluwaseyiashiru.com/",
};
const REFS_FILE = path.join(APP_ROOT, "..", "data", "used-refs.json");
const usedRefs = (() => { try { return new Map(Object.entries(JSON.parse(fs.readFileSync(REFS_FILE, "utf8")))); } catch { return new Map(); } })();
function saveRefs() { try { fs.mkdirSync(path.dirname(REFS_FILE), { recursive: true }); fs.writeFileSync(REFS_FILE, JSON.stringify(Object.fromEntries(usedRefs))); } catch {} }

async function verifyPayment(ref) {
  const secret = env("PAYSTACK_SECRET_KEY");
  if (!secret) throw new Error("Payments are not switched on yet.");
  const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, { headers: { Authorization: `Bearer ${secret}` } });
  const v = await r.json().catch(() => ({}));
  const t = v.data || {};
  if (!v.status || t.status !== "success") throw new Error("We couldn't confirm that payment. If you were charged, message +234 703 313 4979 on WhatsApp with your receipt.");
  const min = t.currency === "USD" ? PAY.minUsd * 100 : PAY.minNgn * 100;
  if (Number(t.amount) < min) throw new Error("That payment was less than the price of a roast.");
  return t;
}

// "viewer" (default): the room plays councils that /roast-room runs in Claude Code.
// "api": the room can also run councils itself on ANTHROPIC_API_KEY (COUNCIL_RUNNER=api in .env).
const RUNNER = PUBLIC_MODE || (process.env.COUNCIL_RUNNER || env("COUNCIL_RUNNER") || "viewer").toLowerCase() === "api" ? "api" : "viewer";
if (!PUBLIC_MODE) watch.startWatching();

// The room's page lives on oluwaseyiashiru.com; this engine answers it from another address.
const ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((x) => x.trim()).filter(Boolean);
function cors(res) { const o = res.__origin || ""; return ORIGINS.includes(o) ? { "access-control-allow-origin": o, "vary": "Origin", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" } : {}; }
function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...cors(res) });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const c of req) { raw += c; if (raw.length > 1e5) throw new Error("body too large"); }
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  res.__origin = req.headers.origin || "";
  if (req.method === "OPTIONS") { res.writeHead(204, cors(res)); return res.end(); }
  try {
    if (p === "/api/seats") {
      // portraits: which of the four mouth shapes exist for each seat (a seat with none gets a drawn bust)
      const frame = (key, sh) => ["webp", "png", "jpg"].map((x) => `${key}-${sh}.${x}`).find((f) => fs.existsSync(path.join(PUBLIC, "portraits", f)));
      const seats = loadRoster().map((s) => ({ ...s, portraits: Object.fromEntries(["base", "open", "mid", "blink"].map((sh) => [sh, frame(s.key, sh)]).filter(([, f]) => f).map(([sh, f]) => [sh, `/portraits/${f}`])) }));
      if (PUBLIC_MODE && process.env.ARCHETYPES === "1") for (const x of seats) x.portraits = {}; // archetypes are drawn, not likenesses
      return send(res, 200, { seats, board: BOARD, models: MODELS, runner: RUNNER, hasKey: Boolean(env("ANTHROPIC_API_KEY")), public: PUBLIC_MODE, pay: PUBLIC_MODE ? { link: PAY.link, priceNgn: PAY.priceNgn, priceUsd: PAY.priceUsd, site: PAY.site } : null });
    }
    if (p === "/api/usage") return send(res, 200, PUBLIC_MODE ? {} : usage);
    if (p === "/api/council" && req.method === "POST") {
      if (RUNNER !== "api") return send(res, 403, { error: "This room is a viewer. Run /roast-room in Claude Code, or set COUNCIL_RUNNER=api in .env." });
      const { prompt, mode, ref, code } = await readJson(req);
      if (!PUBLIC_MODE && running && getSession(running)?.status === "running") return send(res, 409, { error: "A council is already in session. Wait for its verdict." });
      if (PUBLIC_MODE) {
        const reference = String(ref || "").trim(), admin = env("ROAST_ADMIN_CODE");
        const isAdmin = admin && code && code === admin;
        if (!reference && !isAdmin) return send(res, 402, { error: "Book your roast first." });
        if (reference && usedRefs.has(reference)) return send(res, 200, { id: usedRefs.get(reference), resumed: true });
        for (const id of runningSet) if (getSession(id)?.status !== "running") runningSet.delete(id);
        if (runningSet.size >= MAX_RUNNING) return send(res, 429, { error: "The room is full right now. Your payment is safe: try again in a few minutes with this same page." });
        if (!prompt || prompt.trim().length < 30) return send(res, 400, { error: "Tell the council a bit more: the idea, who it is for, and what you want to know (a few sentences)." });
        if (!isAdmin) { try { await verifyPayment(reference); } catch (e) { return send(res, 402, { error: String(e.message || e) }); } }
        const s = startCouncil(prompt.trim().slice(0, 4000), "full");
        runningSet.add(s.id);
        if (reference) { usedRefs.set(reference, s.id); saveRefs(); }
        return send(res, 200, { id: s.id });
      }
      if (!prompt || prompt.trim().length < 10) return send(res, 400, { error: "Give the council a real decision (at least a sentence)." });
      const s = startCouncil(prompt.trim().slice(0, 4000), mode === "quick" ? "quick" : "full");
      running = s.id;
      return send(res, 200, { id: s.id });
    }
    if (p.startsWith("/api/stream/")) {
      const id = decodeURIComponent(p.split("/").pop());
      const s = getSession(id) || watch.getLive(id);
      if (!s) return send(res, 404, { error: "no such session" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", ...cors(res) });
      res.write(": connected\n\n");
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      res.on("close", () => clearInterval(ping));
      return subscribe(s, res);
    }
    if (p === "/api/sessions" && PUBLIC_MODE) return send(res, 200, { sessions: [], running: null, live: null });
    if (p === "/api/sessions") {
      const all = [...listSaved(), ...watch.listLive()].sort((a, b) => (a.id < b.id ? 1 : -1));
      const apiRunning = running && getSession(running)?.status === "running" ? running : null;
      return send(res, 200, { sessions: all, running: apiRunning, live: watch.runningId() });
    }
    if (p.startsWith("/api/sessions/")) {
      const id = decodeURIComponent(p.split("/").pop());
      const x = watch.getLive(id);
      const j = loadSaved(id) || (x && { id, title: x.title, mode: x.mode, status: x.status, events: x.events });
      return j ? send(res, 200, j) : send(res, 404, { error: "not found" });
    }
    // static
    const file = path.normalize(path.join(PUBLIC, p === "/" ? "index.html" : p));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "Not found", "text/plain");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, PUBLIC_MODE ? "0.0.0.0" : "127.0.0.1", () => console.log(`Roast Room on http://localhost:${PORT} (${RUNNER === "api" ? "viewer + API runner" : "viewer: run /roast-room in Claude Code"})`));
