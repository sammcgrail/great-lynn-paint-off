// The Great Lynn Paint Off — live 3-round painting contest with audience voting + pledged bids.
// Bun server: HTTP API + WebSocket fan-out, state persisted to SQLite (one JSON row per event).
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { randomBytes, timingSafeEqual } from "crypto";
import QRCode from "qrcode";

const PORT = Number(process.env.PORT || 8080);
const DATA = process.env.DATA_DIR || "/data";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const PUB = import.meta.dir + "/public";
mkdirSync(`${DATA}/photos`, { recursive: true });

// ---------- types ----------
type RoundState = "pending" | "painting" | "voting" | "closed" | "done";
interface Artist { id: string; name: string; photo: string | null; heat: 1 | 2 | null }
interface Round {
  n: 1 | 2 | 3; state: RoundState; artists: string[]; bidding: boolean;
  votes: Record<string, string>;           // voterId -> artistId (secret: never sent to clients)
  advancers: string[]; tie: boolean;
}
interface Bid { id: string; round: number; artistId: string; amount: number; name: string; pid: string; ts: number }
interface Voter { pid: string; name: string; joined: number; lastBid?: number }
interface Ev {
  id: string; name: string; hostToken: string; created: number;
  stage: "setup" | "live" | "done"; current: 0 | 1 | 2 | 3;
  artists: Artist[]; rounds: Round[]; bids: Bid[];
  voters: Record<string, Voter>;
  settings: { minBid: number; increment: number; currency: string; liveVotes: boolean };
  champion: string | null; v: number;
}

// ---------- persistence ----------
const db = new Database(`${DATA}/artbattle.db`);
db.exec("PRAGMA journal_mode=WAL;");
db.exec("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated INTEGER NOT NULL)");
const upsert = db.prepare("INSERT INTO events (id, json, updated) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated=excluded.updated");
const events = new Map<string, Ev>();
for (const row of db.query("SELECT json FROM events").all() as { json: string }[]) {
  try { const e = JSON.parse(row.json) as Ev; events.set(e.id, e); } catch {}
}
console.log(`loaded ${events.size} events`);
function save(e: Ev) { e.v++; upsert.run(e.id, JSON.stringify(e), Date.now()); }

// ---------- helpers ----------
const ID_ALPHA = "abcdefghjkmnpqrstuvwxyz23456789";
function rid(n: number) { const b = randomBytes(n); let s = ""; for (let i = 0; i < n; i++) s += ID_ALPHA[b[i] % ID_ALPHA.length]; return s; }
const tok = () => randomBytes(18).toString("base64url");
const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const err = (msg: string, status = 400) => json({ error: msg }, status);
function safeEq(a: string, b: string) {
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}
function counts(r: Round) {
  const c: Record<string, number> = {}; for (const a of r.artists) c[a] = 0;
  for (const a of Object.values(r.votes)) if (a in c) c[a]++;
  return c;
}
function showVotes(e: Ev, r: Round) { return r.state === "closed" || r.state === "done" || (e.settings.liveVotes && r.state === "voting"); }
function highs(e: Ev) {
  const h: Record<string, { amount: number; name: string; pid: string; ts: number; count: number }> = {};
  for (const b of e.bids) {
    const k = `${b.round}:${b.artistId}`; const cur = h[k];
    if (!cur) h[k] = { amount: b.amount, name: b.name, pid: b.pid, ts: b.ts, count: 1 };
    else { cur.count++; if (b.amount > cur.amount) Object.assign(cur, { amount: b.amount, name: b.name, pid: b.pid, ts: b.ts }); }
  }
  return h;
}
// Suggest advancers from vote counts; flags a tie when the cut line is ambiguous.
function suggest(r: Round) {
  const c = counts(r); const need = r.n === 3 ? 1 : 2;
  const sorted = [...r.artists].sort((a, b) => c[b] - c[a]);
  if (sorted.length <= need) return { advancers: sorted, tie: false };
  const cut = c[sorted[need - 1]], next = c[sorted[need]];
  if (cut > next) return { advancers: sorted.slice(0, need), tie: false };
  return { advancers: sorted.filter((a) => c[a] > cut), tie: true }; // clear leaders only; host breaks the tie
}

function publicState(e: Ev) {
  return {
    id: e.id, name: e.name, stage: e.stage, current: e.current, champion: e.champion, v: e.v,
    settings: { minBid: e.settings.minBid, increment: e.settings.increment, currency: e.settings.currency, liveVotes: e.settings.liveVotes },
    artists: e.artists.map(({ id, name, photo, heat }) => ({ id, name, photo, heat })),
    rounds: e.rounds.map((r) => ({
      n: r.n, state: r.state, artists: r.artists, bidding: r.bidding, tie: r.tie,
      advancers: r.state === "closed" || r.state === "done" ? r.advancers : [],
      total: Object.keys(r.votes).length, counts: showVotes(e, r) ? counts(r) : null,
    })),
    highs: highs(e),
    recent: e.bids.slice(-25).reverse().map(({ id, round, artistId, amount, name, pid, ts }) => ({ id, round, artistId, amount, name, pid, ts })),
    audience: Object.keys(e.voters).length,
  };
}
function hostState(e: Ev) {
  const s: any = publicState(e);
  s.host = true;
  s.rounds = e.rounds.map((r, i) => ({ ...s.rounds[i], counts: counts(r), advancers: r.advancers }));
  s.bids = e.bids.slice().reverse();
  return s;
}

let server: ReturnType<typeof Bun.serve>;
function broadcast(e: Ev, fx?: unknown) {
  server.publish(`pub:${e.id}`, JSON.stringify({ t: "state", s: publicState(e), fx }));
  server.publish(`host:${e.id}`, JSON.stringify({ t: "state", s: hostState(e), fx }));
}
const commit = (e: Ev, fx?: unknown) => { save(e); broadcast(e, fx); };

// ---------- event creation ----------
const createLog = new Map<string, number[]>();
function newEvent(name: string): Ev {
  let id = rid(6); while (events.has(id)) id = rid(6);
  const mk = (n: 1 | 2 | 3): Round => ({ n, state: "pending", artists: [], bidding: false, votes: {}, advancers: [], tie: false });
  const e: Ev = {
    id, name: name || "The Great Lynn Paint Off", hostToken: tok(), created: Date.now(), stage: "setup", current: 0,
    artists: [], rounds: [mk(1), mk(2), mk(3)], bids: [], voters: {},
    settings: { minBid: 20, increment: 5, currency: "$", liveVotes: false }, champion: null, v: 0,
  };
  events.set(id, e); save(e); return e;
}

// ---------- host actions ----------
type Act = (e: Ev, b: any) => string | null | { fx: unknown };
const cur = (e: Ev) => (e.current ? e.rounds[e.current - 1] : null);
const inSetup = (e: Ev) => (e.stage === "setup" ? null : "Lineup is locked once the Paint Off starts");
const MAX_ARTISTS = 16;
const actions: Record<string, Act> = {
  rename(e, b) { const n = clean(b.name, 60); if (!n) return "Name required"; e.name = n; return null; },
  addArtist(e, b) {
    const x = inSetup(e); if (x) return x;
    const name = clean(b.name, 40); if (!name) return "Artist name required";
    if (e.artists.length >= MAX_ARTISTS) return `Max ${MAX_ARTISTS} artists`;
    const n1 = e.artists.filter((a) => a.heat === 1).length, n2 = e.artists.filter((a) => a.heat === 2).length;
    e.artists.push({ id: rid(8), name, photo: null, heat: n1 <= n2 ? 1 : 2 });
    return null;
  },
  updateArtist(e, b) {
    const a = e.artists.find((x) => x.id === b.id); if (!a) return "No such artist";
    const name = clean(b.name, 40); if (!name) return "Artist name required"; a.name = name; return null;
  },
  removeArtist(e, b) {
    const x = inSetup(e); if (x) return x;
    e.artists = e.artists.filter((a) => a.id !== b.id); return null;
  },
  removePhoto(e, b) { const a = e.artists.find((x) => x.id === b.id); if (a) a.photo = null; return null; },
  setHeat(e, b) {
    const x = inSetup(e); if (x) return x;
    const a = e.artists.find((x) => x.id === b.id); if (!a) return "No such artist";
    a.heat = b.heat === 1 || b.heat === 2 ? b.heat : null; return null;
  },
  autoAssign(e) {
    const x = inSetup(e); if (x) return x;
    const sh = e.artists.slice(); for (let i = sh.length - 1; i > 0; i--) { const j = randomBytes(1)[0] % (i + 1); [sh[i], sh[j]] = [sh[j], sh[i]]; }
    const half = Math.ceil(sh.length / 2); sh.forEach((a, i) => (a.heat = i < half ? 1 : 2));
    e.artists = [...sh.filter((a) => a.heat === 1), ...sh.filter((a) => a.heat === 2)];
    return null;
  },
  lockLineup(e) {
    const x = inSetup(e); if (x) return x;
    if (e.artists.some((a) => !a.heat)) return "Assign every artist to Round 1 or Round 2";
    const h1 = e.artists.filter((a) => a.heat === 1), h2 = e.artists.filter((a) => a.heat === 2);
    if (h1.length < 3 || h2.length < 3) return "Each of Rounds 1 and 2 needs at least 3 artists (5–6 recommended)";
    e.rounds[0].artists = h1.map((a) => a.id); e.rounds[1].artists = h2.map((a) => a.id);
    e.stage = "live"; e.current = 1; return null;
  },
  unlockLineup(e) {
    if (e.stage !== "live" || e.current !== 1 || e.rounds[0].state !== "pending") return "Can only edit the lineup before Round 1 starts";
    e.stage = "setup"; e.current = 0; e.rounds[0].artists = []; e.rounds[1].artists = []; return null;
  },
  startRound(e) {
    const r = cur(e); if (!r || r.state !== "pending") return "No round waiting to start";
    r.state = "painting"; r.bidding = true; return { fx: { type: "round", n: r.n } };
  },
  openVoting(e) {
    const r = cur(e); if (!r || (r.state !== "painting")) return "Voting opens after the round starts";
    r.state = "voting"; return { fx: { type: "voting", n: r.n } };
  },
  closeVoting(e) {
    const r = cur(e); if (!r || r.state !== "voting") return "Voting is not open";
    r.state = "closed"; const s = suggest(r); r.advancers = s.advancers; r.tie = s.tie;
    return { fx: { type: "closed", n: r.n } };
  },
  reopenVoting(e) {
    const r = cur(e); if (!r || r.state !== "closed") return "Voting is not closed";
    r.state = "voting"; r.advancers = []; r.tie = false; return null;
  },
  setBidding(e, b) {
    const r = cur(e); if (!r || r.state === "pending" || r.state === "done") return "No live round";
    r.bidding = !!b.open; return null;
  },
  setLiveVotes(e, b) { e.settings.liveVotes = !!b.on; return null; },
  setAdvancers(e, b) {
    const r = cur(e); if (!r || r.state !== "closed") return "Close voting first";
    const need = r.n === 3 ? 1 : 2;
    const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(String))] as string[] : [];
    if (ids.some((id) => !r.artists.includes(id))) return "Pick artists from this round";
    if (ids.length > need) return `Pick ${need}`;
    r.advancers = ids; return null;
  },
  advance(e) {
    const r = cur(e); if (!r || r.state !== "closed") return "Close voting first";
    const need = r.n === 3 ? 1 : 2;
    if (r.advancers.length !== need) return need === 1 ? "Pick the champion" : "Pick exactly 2 artists to advance";
    r.state = "done"; r.bidding = false; r.tie = false;
    if (r.n === 1) { e.current = 2; }
    else if (r.n === 2) { e.current = 3; e.rounds[2].artists = [...e.rounds[0].advancers, ...e.rounds[1].advancers]; }
    else { e.champion = r.advancers[0]; e.stage = "done"; return { fx: { type: "champion", id: e.champion } }; }
    return { fx: { type: "advance", n: r.n, ids: r.advancers } };
  },
  removeBid(e, b) { const before = e.bids.length; e.bids = e.bids.filter((x) => x.id !== b.id); return before === e.bids.length ? "No such bid" : null; },
  settings(e, b) {
    const mb = Math.round(Number(b.minBid)), inc = Math.round(Number(b.increment));
    if (!(mb >= 0 && mb <= 1e6)) return "Bad opening bid"; if (!(inc >= 1 && inc <= 1e5)) return "Bad increment";
    e.settings.minBid = mb; e.settings.increment = inc;
    const c = clean(b.currency, 3); if (c) e.settings.currency = c; return null;
  },
};

// ---------- audience ----------
const VID = /^[A-Za-z0-9_-]{16,64}$/;
function voterFrom(e: Ev, vid: unknown) { return typeof vid === "string" && VID.test(vid) ? e.voters[vid] : undefined; }
function me(e: Ev, vid: string) {
  const v = e.voters[vid]; if (!v) return null;
  const votes: Record<number, string> = {}; for (const r of e.rounds) if (r.votes[vid]) votes[r.n] = r.votes[vid];
  const bids = e.bids.filter((b) => b.pid === v.pid).map(({ id, round, artistId, amount, ts }) => ({ id, round, artistId, amount, ts }));
  return { pid: v.pid, name: v.name, votes, bids };
}

// ---------- static ----------
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".ico": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".jpg": "image/jpeg", ".json": "application/json",
};
async function staticFile(path: string, cache: string) {
  const f = Bun.file(path); if (!(await f.exists())) return null;
  const ext = path.slice(path.lastIndexOf("."));
  return new Response(f, { headers: { "content-type": MIME[ext] || "application/octet-stream", "cache-control": cache } });
}
const qrCache = new Map<string, string>();

server = Bun.serve({
  port: PORT,
  maxRequestBodySize: 6 * 1024 * 1024,
  async fetch(req, srv) {
    const url = new URL(req.url); const p = url.pathname;
    const origin = PUBLIC_URL || `${req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "")}://${req.headers.get("host")}`;

    if (p === "/ws") {
      const e = events.get(url.searchParams.get("e") || ""); if (!e) return err("No such event", 404);
      const k = url.searchParams.get("k") || ""; const host = !!k && safeEq(k, e.hostToken);
      return srv.upgrade(req, { data: { id: e.id, host } }) ? undefined : err("upgrade failed", 400);
    }

    if (p.startsWith("/api/")) {
      try {
        if (p === "/api/events" && req.method === "POST") {
          const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "x";
          const now = Date.now(); const log = (createLog.get(ip) || []).filter((t) => now - t < 3600e3);
          if (log.length >= 20) return err("Too many events created — try again later", 429);
          log.push(now); createLog.set(ip, log);
          const b = await req.json().catch(() => ({}));
          const e = newEvent(clean(b.name, 60));
          return json({ id: e.id, hostToken: e.hostToken });
        }
        const m = p.match(/^\/api\/e\/([a-z0-9]{6})(?:\/(.*))?$/);
        if (!m) return err("Not found", 404);
        const e = events.get(m[1]); if (!e) return err("No such event", 404);
        const rest = m[2] || "";
        if (rest === "" && req.method === "GET") return json(publicState(e));

        if (rest.startsWith("host")) {
          const k = req.headers.get("x-host-key") || url.searchParams.get("k") || "";
          if (!k || !safeEq(k, e.hostToken)) return err("Wrong host key", 403);
          if (rest === "host" && req.method === "GET") return json(hostState(e));
          const pm = rest.match(/^host\/photo\/([a-z0-9]{8})$/);
          if (pm && req.method === "POST") {
            const a = e.artists.find((x) => x.id === pm[1]); if (!a) return err("No such artist", 404);
            const ct = (req.headers.get("content-type") || "").split(";")[0];
            const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as Record<string, string>)[ct];
            if (!ext) return err("Upload a JPEG, PNG or WebP image");
            const buf = new Uint8Array(await req.arrayBuffer());
            if (buf.length < 100 || buf.length > 5 * 1024 * 1024) return err("Image must be under 5 MB");
            const file = `${e.id}-${a.id}-${rid(5)}.${ext}`;
            await Bun.write(`${DATA}/photos/${file}`, buf);
            a.photo = `/photos/${file}`; commit(e); return json({ ok: true, photo: a.photo });
          }
          const am = rest.match(/^host\/([a-zA-Z]+)$/);
          if (am && req.method === "POST" && actions[am[1]]) {
            const b = await req.json().catch(() => ({}));
            const r = actions[am[1]](e, b || {});
            if (typeof r === "string") return err(r);
            commit(e, r && typeof r === "object" ? r.fx : undefined);
            return json({ ok: true });
          }
          return err("Unknown host action", 404);
        }

        if (rest === "join" && req.method === "POST") {
          const b = await req.json().catch(() => ({}));
          if (typeof b.vid !== "string" || !VID.test(b.vid)) return err("Bad device id");
          const name = clean(b.name, 24); if (!name) return err("Enter a name");
          if (!e.voters[b.vid] && Object.keys(e.voters).length >= 5000) return err("Event is full", 403);
          const v = e.voters[b.vid];
          if (v) v.name = name; else e.voters[b.vid] = { pid: rid(8), name, joined: Date.now() };
          commit(e); return json(me(e, b.vid));
        }
        if (rest === "me" && req.method === "GET") {
          const vid = url.searchParams.get("vid") || "";
          return json(VID.test(vid) ? me(e, vid) : null);
        }
        if (rest === "vote" && req.method === "POST") {
          const b = await req.json().catch(() => ({}));
          const v = voterFrom(e, b.vid); if (!v) return err("Join first", 401);
          const r = cur(e); if (!r || r.state !== "voting") return err("Voting is not open right now");
          if (!r.artists.includes(b.artistId)) return err("That artist isn't in this round");
          if (r.votes[b.vid]) return err("You already voted this round");
          r.votes[b.vid] = b.artistId; commit(e);
          return json(me(e, b.vid));
        }
        if (rest === "bid" && req.method === "POST") {
          const b = await req.json().catch(() => ({}));
          const v = voterFrom(e, b.vid); if (!v) return err("Join first", 401);
          const r = cur(e); if (!r || !r.bidding || e.stage !== "live") return err("Bidding is closed right now");
          if (!r.artists.includes(b.artistId)) return err("That painting isn't in this round");
          const amount = Math.floor(Number(b.amount));
          if (!Number.isFinite(amount) || amount < 1 || amount > 10_000_000) return err("Enter a whole-number amount");
          const h = highs(e)[`${r.n}:${b.artistId}`];
          const min = h ? h.amount + e.settings.increment : e.settings.minBid;
          if (amount < min) return err(`Bid at least ${e.settings.currency}${min.toLocaleString("en-US")}`, 409);
          const now = Date.now(); if (v.lastBid && now - v.lastBid < 1000) return err("Slow down a moment");
          v.lastBid = now;
          const bid: Bid = { id: rid(8), round: r.n, artistId: b.artistId, amount, name: v.name, pid: v.pid, ts: now };
          e.bids.push(bid); commit(e, { type: "bid", bid: { ...bid } });
          return json({ ok: true, bid });
        }
        return err("Not found", 404);
      } catch (x) {
        console.error(x); return err("Server error", 500);
      }
    }

    if (p.startsWith("/qr/")) {
      const m = p.match(/^\/qr\/([a-z0-9]{6})\.svg$/); const e = m && events.get(m[1]); if (!e) return new Response("not found", { status: 404 });
      const target = `${origin}/e/${e.id}`;
      let svg = qrCache.get(target);
      if (!svg) { svg = await QRCode.toString(target, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#16110f", light: "#f4f1ec" } }); qrCache.set(target, svg); }
      return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } });
    }
    if (p.startsWith("/photos/")) {
      const f = p.slice(8); if (!/^[a-z0-9-]+\.(jpg|png|webp)$/.test(f)) return new Response("not found", { status: 404 });
      const file = Bun.file(`${DATA}/photos/${f}`); if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file, { headers: { "content-type": file.type, "cache-control": "public, max-age=31536000, immutable" } });
    }
    // icon probes at any depth (Safari + nested routes like /e/<id>/favicon.ico)
    const icon = p.match(/(?:^|\/)(favicon\.ico|favicon\.png|apple-touch-icon(?:-precomposed)?\.png)$/);
    if (icon) return (await staticFile(`${PUB}/${icon[1]}`, "public, max-age=86400"))!;
    if (/^\/[a-z0-9._-]+(\/[a-z0-9._-]+)?$/i.test(p) && p.includes(".")) {
      if (p.includes("..")) return new Response("not found", { status: 404 });
      const r = await staticFile(PUB + p, p.startsWith("/fonts/") ? "public, max-age=31536000, immutable" : "public, max-age=300, must-revalidate");
      return r || new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    // SPA routes
    if (p === "/" || /^\/[ehsb]\/[a-z0-9]{6}\/?$/.test(p)) return (await staticFile(`${PUB}/index.html`, "no-cache"))!;
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  },
  websocket: {
    idleTimeout: 120,
    open(ws) {
      const d = ws.data as { id: string; host: boolean }; const e = events.get(d.id); if (!e) return ws.close();
      ws.subscribe(`${d.host ? "host" : "pub"}:${d.id}`);
      ws.send(JSON.stringify({ t: "state", s: d.host ? hostState(e) : publicState(e) }));
    },
    message(ws, msg) { if (msg === "ping") ws.send("pong"); },
  },
});
console.log(`paint off on :${PORT}`);
