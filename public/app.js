/* The Great Lynn Paint Off client — one bundle, four views: landing, audience (/e), host (/h), projector (/s), bracket (/b). */
(function () {
  "use strict";

  // ---------- mobile guards (selection loupe, double-tap zoom) ----------
  const isField = (t) => t && t.closest && t.closest("input, textarea");
  document.addEventListener("selectstart", (e) => { if (!isField(e.target)) e.preventDefault(); });
  document.addEventListener("contextmenu", (e) => { if (!isField(e.target)) e.preventDefault(); });
  let lastTap = null;
  document.addEventListener("touchend", (e) => {
    if (e.target.closest && e.target.closest('button, a, input, label, [role="button"]')) { lastTap = null; return; }
    const t = e.changedTouches[0], now = Date.now();
    if (lastTap && now - lastTap.t <= 450 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) <= 48) e.preventDefault();
    lastTap = { x: t.clientX, y: t.clientY, t: now };
  }, { passive: false });

  // ---------- utils ----------
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const app = $("#app");
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const m = path.match(/^\/([ehsb])\/([a-z0-9]{6})$/);
  const VIEW = m ? m[1] : path === "/" ? "home" : "404";
  const EID = m ? m[2] : null;
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
  };

  let toastT;
  function toast(msg, bad) {
    const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (bad ? " bad" : "");
    clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast" + (bad ? " bad" : "")), 2800);
  }

  let HOSTKEY = null;
  async function api(url, body) {
    const opt = { method: body === undefined ? "GET" : "POST", headers: {} };
    if (body !== undefined) { opt.headers["content-type"] = "application/json"; opt.body = JSON.stringify(body); }
    if (HOSTKEY) opt.headers["x-host-key"] = HOSTKEY;
    let r;
    try { r = await fetch(url, opt); } catch (_) { throw new Error("Network hiccup — try again"); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Something went wrong");
    return d;
  }
  const hostAct = (name, body) => api(`/api/e/${EID}/host/${name}`, body || {}).catch((e) => { toast(e.message, true); throw e; });

  function onLoad(fn) { if (document.readyState === "complete") fn(); else window.addEventListener("load", fn, { once: true }); }

  // ---------- state ----------
  let S = null, prevS = null;
  const A = (id) => (S && S.artists.find((a) => a.id === id)) || { id, name: "?", photo: null };
  const cur = () => (S && S.current ? S.rounds[S.current - 1] : null);
  const RN = (n) => (n === 3 ? "Final" : "Round " + n);
  const money = (n) => (S ? S.settings.currency : "$") + Number(n).toLocaleString("en-US");
  const high = (round, aid) => S && S.highs[round + ":" + aid];
  const nextMin = (round, aid) => { const h = high(round, aid); return h ? h.amount + S.settings.increment : S.settings.minBid; };
  const origin = location.origin;

  const SWATCH = [
    ["#c4321a", "#fcf3f0"], ["#2e62c9", "#f1f5fc"], ["#007653", "#f0f7f3"],
    ["#eab532", "#25170c"], ["#bf2a82", "#fbf2f6"], ["#39b4dd", "#081822"],
    ["#7c4523", "#f8ece0"], ["#5daf4a", "#0c1a08"],
  ];
  function hash(s) { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
  function initials(n) { const p = String(n).trim().split(/\s+/); return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase(); }
  function av(a, cls) {
    if (a.photo) return `<div class="av ${cls || ""}"><img src="${esc(a.photo)}" alt="${esc(a.name)}"></div>`;
    const [bg, fg] = SWATCH[hash(a.id || a.name) % SWATCH.length];
    return `<div class="av ${cls || ""}" style="background:${bg}"><div class="mono" style="color:${fg}">${esc(initials(a.name))}</div></div>`;
  }

  // ---------- live connection ----------
  let ws, wsBackoff = 1000, pingT, onState = () => {};
  function setConn(on) { $$(".conn").forEach((c) => { c.classList.toggle("on", on); c.textContent = on ? "Live" : "…"; }); }
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?e=${EID}${HOSTKEY ? "&k=" + encodeURIComponent(HOSTKEY) : ""}`);
    ws.onopen = () => { setConn(true); wsBackoff = 1000; clearInterval(pingT); pingT = setInterval(() => ws.readyState === 1 && ws.send("ping"), 25000); };
    ws.onmessage = (ev) => {
      if (ev.data === "pong") return;
      let d; try { d = JSON.parse(ev.data); } catch (_) { return; }
      if (d.t === "state") { prevS = S; S = d.s; onState(d.fx); }
    };
    ws.onclose = () => { setConn(false); clearInterval(pingT); setTimeout(connect, wsBackoff); wsBackoff = Math.min(wsBackoff * 1.7, 15000); };
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && ws && ws.readyState > 1) connect(); });
  async function boot(render) {
    onState = render;
    try { S = await api(`/api/e/${EID}${HOSTKEY ? "/host" : ""}`); }
    catch (e) { app.innerHTML = notFound(e.message); return; }
    render(); connect();
  }
  function notFound(msg) {
    return `<div class="wrap"><div class="poster"><div class="kick">${esc(msg || "Not found")}</div><h1>No<span>canvas</span></h1><p>This event link doesn't exist. Check the link or start a new event.</p></div><a class="btn primary" href="/">Create an event</a></div>`;
  }
  const topbar = (extra) => `<header class="topbar"><a class="brand" href="/">The Great Lynn <b>Paint Off</b></a><span class="ev">${esc(S ? S.name : "")}</span>${extra || ""}<span class="conn">…</span></header>`;

  // ======================================================================
  // LANDING
  // ======================================================================
  function home() {
    const mine = LS.get("ab_events", []);
    app.innerHTML = `
      <main class="wrap landing">
        <header class="poster">
          <div class="kick">Live painting · the room decides</div>
          <h1><small>The Great Lynn</small><span>Paint Off</span></h1>
          <p>Three rounds of live painting. The audience votes who advances and bids on the canvases while the paint is still wet.</p>
        </header>
        <form class="create" id="create">
          <h2>Start an event</h2>
          <div class="field"><label for="nm">Event name</label><input class="input" id="nm" name="name" maxlength="60" placeholder="The Great Lynn Paint Off" autocomplete="off" enterkeyhint="go"></div>
          <button class="btn primary block" type="submit">Create event</button>
          <p class="fine">You get a private host link to run the show, plus an audience link and QR code to share.</p>
        </form>
        <div class="flow" aria-label="Format">
          <div class="heat"><b>Round 1</b><span>5–6 painters</span></div>
          <div class="arrow">→</div>
          <div class="final"><b>Final</b><span>Top 2 from each round. The room crowns a champion.</span></div>
          <div class="heat"><b>Round 2</b><span>5–6 painters</span></div>
        </div>
        <p class="flow-note">Audience votes after every round. Bidding stays open all round. Bids are pledges, settled with the organizers.</p>
        ${mine.length ? `<section class="mine"><h2>Your events</h2><ul>${mine.slice().reverse().map((e) => `
          <li><span class="n">${esc(e.name)}</span><a class="btn line small" href="/s/${esc(e.id)}">Screen</a><a class="btn primary small" href="/h/${esc(e.id)}?k=${encodeURIComponent(e.k)}">Host</a></li>`).join("")}</ul></section>` : ""}
      </main>`;
    $("#create").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const btn = $("#create button"); btn.disabled = true;
      try {
        const name = $("#nm").value.trim() || "The Great Lynn Paint Off";
        const d = await api("/api/events", { name });
        const list = LS.get("ab_events", []); list.push({ id: d.id, k: d.hostToken, name }); LS.set("ab_events", list);
        LS.set("ab_host_" + d.id, d.hostToken);
        location.href = `/h/${d.id}?k=${encodeURIComponent(d.hostToken)}`;
      } catch (e) { toast(e.message, true); btn.disabled = false; }
    });
  }

  // ======================================================================
  // AUDIENCE
  // ======================================================================
  function deviceId() {
    let v = LS.get("ab_vid", null);
    if (!v) { const c = document.cookie.match(/(?:^|; )ab_vid=([A-Za-z0-9_-]{16,64})/); v = c ? c[1] : null; }
    if (!v) {
      const b = new Uint8Array(16); (window.crypto || window.msCrypto).getRandomValues(b);
      v = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    }
    LS.set("ab_vid", v);
    document.cookie = `ab_vid=${v}; path=/; max-age=31536000; samesite=lax; secure`;
    return v;
  }
  function audience() {
    const VIDv = deviceId();
    let ME = LS.get("ab_me_" + EID, null);   // {pid,name,votes,bids}
    let armedVote = null, armT, sheetFor = null;
    const saveMe = (d) => { ME = d; LS.set("ab_me_" + EID, d); };

    function shell() {
      app.innerHTML = `${topbar()}
        <main class="wrap aud">
          <div id="joinbox"></div>
          <section id="banner"></section>
          <section id="lineup"></section>
          <section id="mine"></section>
          <footer class="foot">
            <a href="/b/${EID}">Full bracket →</a>
            <p class="fine">Bids are pledges only. No payment is taken in this app; winning bidders settle with the organizers.</p>
          </footer>
        </main>
        <div class="sheet-wrap" id="sheet" hidden>
          <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-t">
            <header><div id="sh-av"></div><div class="t"><div class="rn" id="sh-rn"></div><h3 id="sh-t"></h3></div><button class="x" id="sh-x" aria-label="Close">×</button></header>
            <div class="high" id="sh-high"></div>
            <form id="sh-form">
              <label class="lbl" for="sh-amt">Your pledge</label>
              <div class="amt"><span id="sh-cur">$</span><input id="sh-amt" inputmode="numeric" pattern="[0-9]*" autocomplete="off" enterkeyhint="send"></div>
              <div class="min" id="sh-min"></div>
              <div class="quick" id="sh-q"></div>
              <button class="btn primary block" type="submit" id="sh-go">Place pledge</button>
              <p class="fine">Pledge only. No payment is taken in this app; if you're the high bidder when the round ends, the organizers will settle up with you.</p>
            </form>
          </div>
        </div>`;
      $("#sh-x").onclick = closeSheet;
      $("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
      $("#sh-form").addEventListener("submit", placeBid);
      app.addEventListener("click", onClick);
      renderJoin();
    }

    function renderJoin() {
      const box = $("#joinbox");
      if (ME && ME.pid) {
        box.innerHTML = `<div class="hello">You're in as <b>${esc(ME.name)}</b><button id="rename">change</button></div>`;
        $("#rename").onclick = () => { ME = Object.assign({}, ME, { pid: null }); renderJoin(); $("#jn").focus(); };
        return;
      }
      box.innerHTML = `<form class="join" id="joinf">
          <h2>Join the Paint Off</h2>
          <p>Pick a name. It shows next to your bids. One vote per phone, per round.</p>
          <div class="row"><input class="input" id="jn" maxlength="24" placeholder="Your name" autocomplete="nickname" enterkeyhint="go" value="${esc((ME && ME.name) || "")}"><button class="btn primary" type="submit">Join</button></div>
        </form>`;
      $("#joinf").addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = $("#jn").value.trim(); if (!name) { $("#jn").focus(); return; }
        try { saveMe(await api(`/api/e/${EID}/join`, { vid: VIDv, name })); renderJoin(); render(); toast("You're in. Enjoy the show."); }
        catch (x) { toast(x.message, true); }
      });
    }
    function needJoin() {
      if (ME && ME.pid) return false;
      toast("Enter your name first", true);
      window.scrollTo({ top: 0, behavior: "smooth" }); setTimeout(() => $("#jn") && $("#jn").focus(), 300);
      return true;
    }

    function banner() {
      const r = cur(); const b = $("#banner");
      let cls = "", rn = "", h = "", p = "", chips = "";
      if (S.stage === "done") {
        const c = A(S.champion); cls = "gold"; rn = "Champion"; h = esc(c.name); p = "Takes The Great Lynn Paint Off crown. Thanks for voting.";
      } else if (S.stage === "setup") {
        rn = "Doors open"; h = "Lineup loading"; p = "The host is setting the painters. This page updates live, no need to refresh.";
      } else if (r.state === "pending") {
        rn = RN(r.n); h = "Up next"; p = r.n === 3 ? "The four finalists are getting ready." : "Painters are setting up. Bidding opens when the round starts.";
      } else if (r.state === "painting") {
        rn = RN(r.n); h = "Painting now"; p = "Bid on any canvas in this round. Voting opens when the brushes drop.";
      } else if (r.state === "voting") {
        cls = "hot"; rn = RN(r.n); h = "Vote now"; p = ME && ME.votes && ME.votes[r.n] ? `Your vote is in for ${esc(A(ME.votes[r.n]).name)}.` : `Pick the best painting of ${RN(r.n).toLowerCase() === "final" ? "the final" : RN(r.n)}. One vote per phone.`;
      } else if (r.state === "closed") {
        rn = RN(r.n); h = "Votes are in";
        p = r.advancers.length ? (r.n === 3 ? "The champion is about to be crowned." : `Advancing to the final: ${r.advancers.map((id) => esc(A(id).name)).join(" & ")}.`) : "The host is confirming who advances.";
      }
      if (S.stage === "live" && r.state !== "pending") chips = `<div class="chips"><span class="chip ${r.bidding ? "green" : "ghost"}">${r.bidding ? "Bidding open" : "Bidding closed"}</span><span class="chip ghost">${S.audience} in the room</span></div>`;
      b.innerHTML = `<div class="banner ${cls}"><div class="rn">${rn}</div><h2>${h}</h2><p>${p}</p>${chips}</div>`;
    }

    function card(a, r, opts) {
      const h = r ? high(r.n, a.id) : null;
      const mineLead = h && ME && h.pid === ME.pid;
      const bidline = !r ? `<span>Heat ${a.heat || "?"}</span>` : h ? `High bid <b>${money(h.amount)}</b> ${mineLead ? `<span class="lead">· you lead</span>` : `· ${esc(h.name)}`}` : `No bids yet · opens at ${money(S.settings.minBid)}`;
      let vb = "";
      if (r && r.counts) {
        const max = Math.max(1, ...Object.values(r.counts)); const v = r.counts[a.id] || 0;
        vb = `<div class="vbar"><div class="track"><div class="fill" style="width:${(v / max) * 100}%"></div></div><div class="val">${v} vote${v === 1 ? "" : "s"}</div></div>`;
      }
      let acts = "";
      if (r && S.stage === "live" && (r.state !== "pending")) {
        const myVote = ME && ME.votes && ME.votes[r.n];
        const canBid = r.bidding;
        acts = `<div class="acts">
          <button class="btn ${r.state === "voting" ? "line" : "primary"} small" data-bid="${a.id}" ${canBid ? "" : "disabled"}>${canBid ? "Bid" : "Bids closed"}</button>
          ${r.state === "voting" ? (myVote ? (myVote === a.id ? `<button class="btn gold small" disabled style="opacity:1">Your vote</button>` : "")
            : `<button class="btn ${armedVote === a.id ? "armed" : "primary"} small" data-vote="${a.id}">${armedVote === a.id ? "Confirm vote" : "Vote"}</button>`) : ""}
        </div>`;
      }
      const adv = r && (r.state === "closed" || r.state === "done") && r.advancers.includes(a.id);
      const out = r && r.state === "done" && !adv;
      const voted = r && ME && ME.votes && ME.votes[r.n] === a.id;
      return `<article class="art ${voted ? "voted" : ""} ${adv ? "adv" : ""} ${out ? "out" : ""}">
        <div class="frame">${av(a)}</div>
        <div class="plac"><h4>${esc(a.name)}</h4><div class="bidline">${bidline}</div>${vb}${acts}</div>
        ${adv ? `<span class="chip red stamp">${r.n === 3 ? "Champion" : "→ Final"}</span>` : ""}
      </article>`;
    }

    function lineup() {
      const el = $("#lineup"); const r = cur();
      if (S.stage === "setup") {
        const h1 = S.artists.filter((a) => a.heat === 1), h2 = S.artists.filter((a) => a.heat === 2);
        el.innerHTML = !S.artists.length ? `<p class="empty">No painters announced yet.</p>` :
          [[1, h1], [2, h2]].map(([n, list]) => list.length ? `<div class="sect-h"><h3>Round ${n}</h3><span>${list.length} painters</span></div><div class="lineup">${list.map((a) => card(a, null)).join("")}</div>` : "").join("");
        return;
      }
      const rr = S.stage === "done" ? S.rounds[2] : r;
      el.innerHTML = `<div class="sect-h"><h3>${RN(rr.n)} canvases</h3><span>${rr.total} vote${rr.total === 1 ? "" : "s"} cast</span></div>
        <div class="lineup">${(rr.state === "closed" || rr.state === "done") && rr.counts ? rr.artists.slice().sort((x, y) => (rr.advancers.includes(y) - rr.advancers.includes(x)) || ((rr.counts[y] || 0) - (rr.counts[x] || 0))).map((id) => card(A(id), rr)).join("") : rr.artists.map((id) => card(A(id), rr)).join("")}</div>`;
    }

    function mine() {
      const el = $("#mine");
      if (!ME || !ME.bids || !ME.bids.length) { el.innerHTML = ""; return; }
      const by = {}; for (const b of ME.bids) { const k = b.round + ":" + b.artistId; if (!by[k] || b.amount > by[k].amount) by[k] = b; }
      const rows = Object.values(by).sort((a, b) => b.ts - a.ts).map((b) => {
        const h = S.highs[b.round + ":" + b.artistId]; const lead = h && h.pid === ME.pid;
        return `<li><span class="who">${esc(A(b.artistId).name)} <span class="fine">· ${RN(b.round)}</span></span><span class="amt">${money(b.amount)}</span>${lead ? `<span class="chip green">Leading</span>` : `<span class="chip red">Outbid</span>`}</li>`;
      }).join("");
      el.innerHTML = `<div class="sect-h"><h3>Your pledges</h3></div><ul class="mybids">${rows}</ul>`;
    }

    function onClick(e) {
      const bidB = e.target.closest("[data-bid]"), voteB = e.target.closest("[data-vote]");
      if (bidB) { if (!needJoin()) openSheet(bidB.dataset.bid); }
      else if (voteB) {
        if (needJoin()) return;
        const id = voteB.dataset.vote;
        if (armedVote !== id) { armedVote = id; clearTimeout(armT); armT = setTimeout(() => { armedVote = null; lineup(); }, 4000); lineup(); return; }
        armedVote = null; clearTimeout(armT);
        api(`/api/e/${EID}/vote`, { vid: VIDv, artistId: id }).then((d) => { saveMe(Object.assign({}, ME, d)); render(); toast(`Vote locked in for ${A(id).name}`); })
          .catch((x) => { toast(x.message, true); render(); });
      }
    }

    function openSheet(aid) {
      sheetFor = aid; const r = cur(); const a = A(aid);
      $("#sh-av").innerHTML = av(a); $("#sh-t").textContent = a.name; $("#sh-rn").textContent = RN(r.n) + " canvas";
      $("#sh-cur").textContent = S.settings.currency;
      $("#sh-amt").value = nextMin(r.n, aid);
      updateSheet(); $("#sheet").hidden = false;
      setTimeout(() => { const i = $("#sh-amt"); i.focus(); i.select(); }, 60);
    }
    function closeSheet() { sheetFor = null; $("#sheet").hidden = true; }
    function updateSheet() {
      if (!sheetFor) return; const r = cur();
      if (!r || !r.bidding || !r.artists.includes(sheetFor)) { closeSheet(); toast("Bidding just closed for that canvas", true); return; }
      const h = high(r.n, sheetFor), min = nextMin(r.n, sheetFor);
      $("#sh-high").innerHTML = h ? `High bid<b>${money(h.amount)}</b>${h.pid === (ME && ME.pid) ? "· that's you" : "· " + esc(h.name)}` : `No bids yet. Opening bid<b>${money(S.settings.minBid)}</b>`;
      $("#sh-min").textContent = `Minimum pledge: ${money(min)}`;
      const inc = S.settings.increment;
      $("#sh-q").innerHTML = [min, min + inc * 4, min + inc * 9].map((v) => `<button type="button" data-q="${v}">${money(v)}</button>`).join("");
      $$("#sh-q button").forEach((b) => (b.onclick = () => { $("#sh-amt").value = b.dataset.q; }));
      const i = $("#sh-amt"); if (Number(i.value) < min && document.activeElement !== i) i.value = min;
    }
    async function placeBid(e) {
      e.preventDefault(); const r = cur(); const aid = sheetFor; if (!aid) return;
      const amount = Number(String($("#sh-amt").value).replace(/[^0-9]/g, ""));
      const btn = $("#sh-go"); btn.disabled = true;
      try {
        const d = await api(`/api/e/${EID}/bid`, { vid: VIDv, artistId: aid, amount });
        saveMe(Object.assign({}, ME, { bids: (ME.bids || []).concat([d.bid]) }));
        closeSheet(); toast(`Pledged ${money(amount)} on ${A(aid).name}`); render();
      } catch (x) { toast(x.message, true); updateSheet(); $("#sh-amt").value = nextMin(r.n, aid); }
      btn.disabled = false;
    }

    function render(fx) {
      if (!$("#banner")) shell();
      $(".topbar .ev").textContent = S.name; document.title = S.name + " · The Great Lynn Paint Off";
      // outbid alert
      if (prevS && ME && ME.pid) for (const k in S.highs) { const o = prevS.highs[k]; if (o && o.pid === ME.pid && S.highs[k].pid !== ME.pid) toast(`Outbid on ${A(k.split(":")[1]).name}: now ${money(S.highs[k].amount)}`, true); }
      if (fx && fx.type === "voting") toast("Voting is open. Pick your favorite.");
      banner(); lineup(); mine(); updateSheet();
    }
    onLoad(async () => {
      if (ME && ME.pid) api(`/api/e/${EID}/me?vid=${VIDv}`).then((d) => { if (d) { saveMe(d); S && render(); } else { ME = null; LS.set("ab_me_" + EID, null); S && (renderJoin(), render()); } }).catch(() => {});
      boot(render);
    });
  }

  // ======================================================================
  // HOST
  // ======================================================================
  function host() {
    const qk = new URLSearchParams(location.search).get("k");
    HOSTKEY = qk || LS.get("ab_host_" + EID, null);
    if (!HOSTKEY) { app.innerHTML = notFound("Host key missing"); return; }
    LS.set("ab_host_" + EID, HOSTKEY);
    let armed = null, armT, uploadFor = null;
    const arm = (key) => { armed = key; clearTimeout(armT); armT = setTimeout(() => { armed = null; render(); }, 4000); render(); };
    const isArmed = (key) => armed === key;

    function shell() {
      const list = LS.get("ab_events", []); if (!list.find((e) => e.id === EID)) { list.push({ id: EID, k: HOSTKEY, name: S.name }); LS.set("ab_events", list); }
      const aud = `${origin}/e/${EID}`, scr = `${origin}/s/${EID}`, brk = `${origin}/b/${EID}`, hst = `${origin}/h/${EID}?k=${encodeURIComponent(HOSTKEY)}`;
      app.innerHTML = `${topbar('<span class="chip red">Host</span>')}
      <main class="wrap host">
        <div class="evhead"><h1 id="evn"></h1><button class="btn line small" id="ren">Rename</button></div>
        <section class="links">
          <div class="ls">
            ${lrow("Audience", aud, true)}${lrow("Projector", scr, false)}${lrow("Bracket", brk, false)}
            <div class="lrow priv"><span class="k">Host link</span><span class="u">Private. Anyone with it can run the show</span><button class="btn line" data-copy="${esc(hst)}">Copy</button></div>
          </div>
          <a class="qr" href="/qr/${EID}.svg" target="_blank" rel="noopener" title="Audience QR code"><img src="/qr/${EID}.svg" alt="QR code for the audience link"></a>
        </section>
        <section><h2 class="sh">Run of show</h2><div id="run"></div></section>
        <section id="boardsec"></section>
        <section><h2 class="sh">Artists <small id="acount"></small></h2>
          <div id="addwrap"><form class="addform" id="addf"><input class="input" id="an" maxlength="40" placeholder="Artist name" autocomplete="off" enterkeyhint="done"><button class="btn primary" type="submit">Add</button></form>
          <p class="fine" style="margin-top:8px">Add 10–12 painters. Photos are optional: tap “photo” on any artist.</p></div>
          <div id="alist"></div>
        </section>
        <section><h2 class="sh">Bids <small id="bcount"></small></h2><div id="bids"></div></section>
        <section><h2 class="sh">Bidding rules</h2>
          <form class="settings" id="setf">
            <div class="field"><label for="s-min">Opening bid</label><input class="input" id="s-min" inputmode="numeric" pattern="[0-9]*"></div>
            <div class="field"><label for="s-inc">Min raise</label><input class="input" id="s-inc" inputmode="numeric" pattern="[0-9]*"></div>
            <div class="field"><label for="s-cur">Currency</label><input class="input" id="s-cur" maxlength="3"></div>
            <button class="btn line block" type="submit" style="grid-column:1/-1">Save bidding rules</button>
          </form>
          <p class="fine" style="margin-top:8px">Bids are pledges only. Nothing is charged; settle with high bidders after each round.</p>
        </section>
        <input type="file" id="photo" accept="image/*" hidden>
      </main>`;
      $("#ren").onclick = async () => { const n = prompt("Event name", S.name); if (n && n.trim()) hostAct("rename", { name: n.trim() }); };
      $("#addf").addEventListener("submit", async (e) => {
        e.preventDefault(); const i = $("#an"); const name = i.value.trim(); if (!name) return i.focus();
        try { await hostAct("addArtist", { name }); i.value = ""; i.focus(); } catch (_) {}
      });
      $("#setf").addEventListener("submit", (e) => { e.preventDefault(); hostAct("settings", { minBid: $("#s-min").value, increment: $("#s-inc").value, currency: $("#s-cur").value }).then(() => toast("Bidding rules saved")); });
      $("#photo").addEventListener("change", onPhoto);
      app.addEventListener("click", onClick);
      fillSettings();
    }
    const lrow = (k, u, copy) => `<div class="lrow"><span class="k">${k}</span><span class="u">${esc(u.replace(/^https?:\/\//, ""))}</span>${copy ? `<button class="btn line" data-copy="${esc(u)}">Copy</button>` : ""}<a class="btn line" href="${esc(u)}" target="_blank" rel="noopener">Open</a></div>`;
    function fillSettings() {
      [["#s-min", S.settings.minBid], ["#s-inc", S.settings.increment], ["#s-cur", S.settings.currency]].forEach(([s, v]) => { const i = $(s); if (document.activeElement !== i) i.value = v; });
    }

    function steps() {
      const idx = S.stage === "setup" ? 0 : S.stage === "done" ? 4 : S.current;
      return `<div class="steps">${["Lineup", "Round 1", "Round 2", "Final", "Champion"].map((t, i) => `<div class="${i < idx ? "done" : i === idx ? "now" : ""}">${t}</div>`).join("")}</div>`;
    }
    function run() {
      const r = cur(); let now = "", hint = "", acts = "";
      const btn = (act, label, cls, confirm) => {
        const key = "a:" + act;
        if (confirm && isArmed(key)) return `<button class="btn armed block" data-act="${act}" data-confirmed="1">Tap again: ${label}</button>`;
        return `<button class="btn ${cls || "primary"} block" data-act="${act}" ${confirm ? 'data-confirm="1"' : ""}>${label}</button>`;
      };
      const liveToggle = `<label class="toggle"><input type="checkbox" data-live ${S.settings.liveVotes ? "checked" : ""}><span class="sw"></span>Show live vote bars while voting is open</label>`;
      const bidToggle = r && r.state !== "pending" && r.state !== "done" ? `<label class="toggle"><input type="checkbox" data-bidding ${r.bidding ? "checked" : ""}><span class="sw"></span>Bidding open for ${RN(r.n)}</label>` : "";
      if (S.stage === "setup") {
        const h1 = S.artists.filter((a) => a.heat === 1).length, h2 = S.artists.filter((a) => a.heat === 2).length, un = S.artists.filter((a) => !a.heat).length;
        now = "Set the lineup"; hint = `Add painters below and split them into Round 1 and Round 2 (5–6 each). Round 1: ${h1} · Round 2: ${h2}${un ? ` · unassigned: ${un}` : ""}.`;
        const ok = h1 >= 3 && h2 >= 3 && !un;
        acts = (ok && (h1 < 5 || h1 > 6 || h2 < 5 || h2 > 6) ? `<div class="warn">Format calls for 5–6 painters per round. You can still go ahead.</div>` : "") +
          `<div class="row2"><button class="btn line block" data-act="autoAssign" ${S.artists.length < 2 ? "disabled" : ""}>Shuffle into rounds</button>${btn("lockLineup", "Lock lineup", "primary", true).replace("<button", ok ? "<button" : "<button disabled")}</div>`;
      } else if (S.stage === "done") {
        now = `${A(S.champion).name} wins`; hint = "The champion is on the projector and every phone. Bids from all rounds are listed below.";
      } else if (r.state === "pending") {
        now = `${RN(r.n)}: ready`; hint = r.n === 3 ? `Finalists: ${r.artists.map((id) => A(id).name).join(", ")}.` : `${r.artists.length} painters: ${r.artists.map((id) => A(id).name).join(", ")}.`;
        acts = btn("startRound", `Start ${RN(r.n)} · open bidding`) + (r.n === 1 ? `<button class="btn line block" data-act="unlockLineup">Back to lineup</button>` : "");
      } else if (r.state === "painting") {
        now = `${RN(r.n)}: painting`; hint = "Bidding is live. Open voting when the time's up.";
        acts = btn("openVoting", "Open voting") + bidToggle + liveToggle;
      } else if (r.state === "voting") {
        now = `${RN(r.n)}: voting`; hint = `${r.total} vote${r.total === 1 ? "" : "s"} in from ${S.audience} joined. Counts are shown to you below${S.settings.liveVotes ? " and live on the projector" : ", hidden from the audience until you close voting"}.`;
        acts = btn("closeVoting", "Close voting & show results", "primary", true) + bidToggle + liveToggle;
      } else if (r.state === "closed") {
        const need = r.n === 3 ? 1 : 2;
        now = `${RN(r.n)}: results`;
        hint = r.n === 3 ? "Tap the winner below if needed, then crown the champion." : `Top 2 advance to the final. Tap artists below to change who advances (${r.advancers.length}/${need} picked).`;
        acts = (r.tie ? `<div class="warn">Tie at the cut line. Tap artists below to pick ${need === 1 ? "the champion" : "who advances"}.</div>` : "") +
          btn("advance", r.n === 3 ? `Crown ${r.advancers.length === 1 ? A(r.advancers[0]).name : "champion"}` : r.n === 1 ? "Confirm & set up Round 2" : "Confirm & set up the Final", r.n === 3 ? "gold" : "primary", true).replace("<button", r.advancers.length === need ? "<button" : "<button disabled") +
          `<button class="btn line block" data-act="reopenVoting">Reopen voting</button>` + bidToggle;
      }
      $("#run").innerHTML = steps() + `<div class="run"><div class="now">${esc(now)}</div><p class="hint">${esc(hint)}</p><div class="acts">${acts}</div></div>`;
    }
    function board() {
      const r = cur(); const sec = $("#boardsec");
      if (!r || S.stage === "setup") { sec.innerHTML = ""; return; }
      const rr = S.stage === "done" ? S.rounds[2] : r;
      const pickable = rr.state === "closed" && S.stage !== "done";
      const c = rr.counts || {}; const max = Math.max(1, ...Object.values(c));
      const order = rr.state === "closed" || rr.state === "done" ? rr.artists.slice().sort((a, b) => (c[b] || 0) - (c[a] || 0)) : rr.artists;
      sec.innerHTML = `<h2 class="sh">${RN(rr.n)} live board <small>${rr.total} vote${rr.total === 1 ? "" : "s"} · only you see counts</small></h2><ul class="board">${order.map((id) => {
        const a = A(id), h = high(rr.n, id), v = c[id] || 0, pick = rr.advancers.includes(id);
        return `<li class="${pick ? "pick" : ""} ${pickable ? "pickable" : ""}" ${pickable ? `data-pick="${id}" role="button" tabindex="0"` : ""}>
          ${pickable ? `<span class="check"></span>` : ""}${av(a)}
          <div class="nm"><b>${esc(a.name)}</b><div class="vbar"><div class="track"><div class="fill" style="width:${(v / max) * 100}%"></div></div></div></div>
          <div class="v"><b>${v}</b>vote${v === 1 ? "" : "s"}</div>
          <div class="bb"><b>${h ? money(h.amount) : "—"}</b>${h ? `${h.count} bid${h.count === 1 ? "" : "s"}` : "no bids"}</div></li>`;
      }).join("")}</ul>`;
    }
    function artists() {
      const setup = S.stage === "setup";
      $("#addwrap").hidden = !setup;
      $("#acount").textContent = `${S.artists.length} · ${S.artists.filter((a) => a.heat === 1).length} in R1 · ${S.artists.filter((a) => a.heat === 2).length} in R2`;
      $("#alist").innerHTML = !S.artists.length ? `<p class="empty">No artists yet. Add the first painter above.</p>` :
        `<ul class="alist">${S.artists.map((a) => `<li>${av(a)}<div class="nm"><b>${esc(a.name)}</b><div class="mini">
          <button data-photo="${a.id}">${a.photo ? "change photo" : "photo"}</button>${a.photo ? `<button data-nophoto="${a.id}">remove photo</button>` : ""}
          <button data-rename="${a.id}">rename</button>${setup ? `<button data-del="${a.id}">${isArmed("del:" + a.id) ? "tap to delete" : "delete"}</button>` : ""}</div></div>
          ${setup ? `<div class="seg" role="group" aria-label="Round"><button data-heat="${a.id}:1" class="${a.heat === 1 ? "on" : ""}">R1</button><button data-heat="${a.id}:2" class="${a.heat === 2 ? "on" : ""}">R2</button></div>` : `<span class="chip ghost">R${a.heat}${S.rounds[2].artists.includes(a.id) ? " · Final" : ""}</span>`}
        </li>`).join("")}</ul>`;
    }
    function bids() {
      $("#bcount").textContent = S.bids.length ? `${S.bids.length} pledges` : "";
      $("#bids").innerHTML = !S.bids.length ? `<p class="empty">No bids yet. They show up here live.</p>` :
        `<ul class="bidlog">${S.bids.slice(0, 80).map((b) => `<li><span class="d"><b>${esc(b.name)}</b> on ${esc(A(b.artistId).name)} · ${RN(b.round)} · ${new Date(b.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span><span class="a">${money(b.amount)}</span><button class="rm" data-rmbid="${b.id}" aria-label="Remove bid" title="${isArmed("rm:" + b.id) ? "Tap again to remove" : "Remove bid"}">${isArmed("rm:" + b.id) ? "!" : "×"}</button></li>`).join("")}</ul>`;
    }

    async function onClick(e) {
      const t = e.target.closest("button, [data-pick], [data-copy]"); if (!t) return;
      const d = t.dataset;
      if (d.copy) { try { await navigator.clipboard.writeText(d.copy); toast("Link copied"); } catch (_) { prompt("Copy this link", d.copy); } return; }
      if (d.act) {
        if (d.confirm && !d.confirmed) { arm("a:" + d.act); return; }
        armed = null; t.disabled = true;
        hostAct(d.act).catch(() => render()); return;
      }
      if (d.heat) { const [id, h] = d.heat.split(":"); hostAct("setHeat", { id, heat: Number(h) }); return; }
      if (d.photo) { uploadFor = d.photo; $("#photo").value = ""; $("#photo").click(); return; }
      if (d.nophoto) { hostAct("removePhoto", { id: d.nophoto }); return; }
      if (d.rename) { const a = A(d.rename); const n = prompt("Artist name", a.name); if (n && n.trim()) hostAct("updateArtist", { id: a.id, name: n.trim() }); return; }
      if (d.del) { if (!isArmed("del:" + d.del)) return arm("del:" + d.del); armed = null; hostAct("removeArtist", { id: d.del }); return; }
      if (d.rmbid) { if (!isArmed("rm:" + d.rmbid)) return arm("rm:" + d.rmbid); armed = null; hostAct("removeBid", { id: d.rmbid }).then(() => toast("Bid removed")); return; }
      if (d.pick) {
        const r = cur(); const need = r.n === 3 ? 1 : 2; let ids = r.advancers.slice();
        if (ids.includes(d.pick)) ids = ids.filter((x) => x !== d.pick);
        else { ids.push(d.pick); if (ids.length > need) ids = ids.slice(-need); }
        hostAct("setAdvancers", { ids });
      }
    }
    app.addEventListener("change", (e) => {
      if (e.target.matches("[data-live]")) hostAct("setLiveVotes", { on: e.target.checked });
      if (e.target.matches("[data-bidding]")) hostAct("setBidding", { open: e.target.checked });
    });

    async function onPhoto() {
      const f = $("#photo").files[0]; const id = uploadFor; if (!f || !id) return;
      toast("Uploading photo…");
      try {
        const blob = await shrink(f, 1000);
        const r = await fetch(`/api/e/${EID}/host/photo/${id}`, { method: "POST", headers: { "content-type": blob.type, "x-host-key": HOSTKEY }, body: blob });
        const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || "Upload failed");
        toast("Photo added");
      } catch (x) { toast(x.message || "Upload failed", true); }
    }
    function shrink(file, max) {
      return new Promise((res, rej) => {
        const url = URL.createObjectURL(file); const img = new Image();
        img.onload = () => {
          const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
          const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
          c.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't read that image"))), "image/jpeg", 0.85);
        };
        img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("Couldn't read that image")); };
        img.src = url;
      });
    }

    function render() {
      if (!$("#run")) shell();
      $("#evn").textContent = S.name; $(".topbar .ev").textContent = S.name; document.title = "Host · " + S.name;
      run(); board(); artists(); bids(); fillSettings();
    }
    onLoad(() => boot(render));
  }

  // ======================================================================
  // PROJECTOR
  // ======================================================================
  function screen() {
    document.body.classList.add("screen-mode");
    let flashT, seenChamp = false;
    function tile(a, r) {
      const h = high(r.n, a.id);
      let vb;
      if (r.counts) { const max = Math.max(1, ...Object.values(r.counts)); const v = r.counts[a.id] || 0; vb = `<div class="track"><div class="fill" style="width:${(v / max) * 100}%"></div></div><span>${v}</span>`; }
      else vb = `<div class="hid"></div><span>${r.state === "voting" ? "?" : ""}</span>`;
      const adv = (r.state === "closed" || r.state === "done") && r.advancers.includes(a.id);
      const out = r.state === "done" && !adv;
      return `<div class="s-tile ${adv ? "adv" : ""} ${out ? "out" : ""}" data-t="${a.id}">
        <div class="frame">${av(a)}</div>
        <div class="pl"><h3>${esc(a.name)}</h3>
          <div class="bid">${h ? `<b>${money(h.amount)}</b><span>${esc(h.name)}</span>` : `<span>Opening bid ${money(S.settings.minBid)}</span>`}</div>
          <div class="vb">${vb}</div></div>
        ${adv ? `<div class="stamp">${r.n === 3 ? "Champion" : "→ Final"}</div>` : ""}
      </div>`;
    }
    function render(fx) {
      const r = cur(); document.title = "Screen · " + S.name;
      let title = "", state = "", stCls = "", main = "";
      if (S.stage === "setup") {
        title = "Tonight's painters"; state = "Scan to join"; stCls = "";
        const h1 = S.artists.filter((a) => a.heat === 1), h2 = S.artists.filter((a) => a.heat === 2);
        main = `<div class="s-lineup">${[[1, h1], [2, h2]].map(([n, l]) => `<div><h2>Round ${n}</h2><ul>${l.map((a) => `<li>${av(a)}<b>${esc(a.name)}</b></li>`).join("") || `<li><span class="fine">TBA</span></li>`}</ul></div>`).join("")}</div>`;
      } else {
        const rr = S.stage === "done" ? S.rounds[2] : r;
        title = RN(rr.n);
        state = { pending: "Up next", painting: "Painting · bid now", voting: "Vote now", closed: "Results", done: S.stage === "done" ? "Champion" : "Complete" }[rr.state];
        stCls = rr.state === "voting" ? "hot" : rr.state === "closed" || S.stage === "done" ? "gold" : "";
        const n = rr.artists.length;
        main = `<div class="s-grid n${Math.min(8, Math.max(3, n))}">${rr.artists.map((id) => tile(A(id), rr)).join("")}</div>`;
      }
      const rounds = S.rounds;
      const advTxt = (i) => rounds[i].state === "done" || rounds[i].state === "closed" ? (rounds[i].advancers.map((id) => esc(A(id).name)).join(" · ") || "TBD") : "TBD";
      const tick = S.recent.filter((b) => !r || b.round === (S.stage === "done" ? 3 : r.n)).slice(0, 12);
      const html = `<div class="screen">
        <header class="s-head"><div class="t"><div class="ev">${esc(S.name)}</div><h1>${esc(title)}</h1></div><div class="s-state ${stCls}">${esc(state)}</div></header>
        ${main}
        <aside class="s-side">
          <div class="s-qr"><img src="/qr/${EID}.svg" alt=""><div><b>Vote &amp; bid</b><span>${esc(location.host)}/e/${EID}</span></div></div>
          <div class="s-tick"><h2>Top bids <small>${S.audience} in the room</small></h2>${topBids()}</div>
          <div class="s-tick" style="flex:0.8"><h2>Latest pledges</h2>${tick.length ? `<ol>${tick.map((b, i) => `<li class="${fx && fx.type === "bid" && fx.bid.id === b.id ? "new" : ""}"><span class="w"><b>${esc(b.name)}</b> → ${esc(A(b.artistId).name)}</span><span class="a">${money(b.amount)}</span></li>`).join("")}</ol>` : `<p class="none">No bids yet. Scan the code to pledge on a canvas.</p>`}</div>
          <div class="s-mini"><h2>Bracket</h2><div class="rows"><span class="k">R1 →</span><span class="v ${rounds[0].advancers.length ? "y" : ""}">${advTxt(0)}</span><span class="k">R2 →</span><span class="v ${rounds[1].advancers.length ? "y" : ""}">${advTxt(1)}</span><span class="k">Champ</span><span class="v ${S.champion ? "y" : ""}">${S.champion ? esc(A(S.champion).name) : "TBD"}</span></div></div>
        </aside>
        <div class="s-flash" id="flash"></div>
        ${S.stage === "done" ? champ() : ""}
      </div>`;
      app.innerHTML = html;
      if (fx && fx.type === "bid") {
        const f = $("#flash"); f.innerHTML = `<small>New pledge · ${esc(fx.bid.name)}</small><b>${money(fx.bid.amount)}</b><span>${esc(A(fx.bid.artistId).name)}</span>`;
        f.classList.add("show"); clearTimeout(flashT); flashT = setTimeout(() => { const g = $("#flash"); g && g.classList.remove("show"); }, 2600);
        const t = $(`[data-t="${fx.bid.artistId}"]`); t && t.classList.add("flash");
      }
      seenChamp = S.stage === "done";
    }
    function topBids() {
      const r = S.stage === "done" ? S.rounds[2] : cur();
      const rows = Object.entries(S.highs).filter(([k]) => !r || k.startsWith(r.n + ":")).sort((a, b) => b[1].amount - a[1].amount).slice(0, 6);
      return rows.length ? `<ol>${rows.map(([k, h]) => `<li><span class="w"><b>${esc(A(k.split(":")[1]).name)}</b> · ${esc(h.name)}</span><span class="a">${money(h.amount)}</span></li>`).join("")}</ol>` : `<p class="none">${r && r.bidding ? "No bids yet. Scan the code to pledge on a canvas." : "Bidding opens when the round starts."}</p>`;
    }
    function champ() {
      const c = A(S.champion);
      const SPOTS = [[2, 4, 7], [93, 8, 11], [88, 80, 16], [44, 90, 6], [96, 46, 5], [-3, 88, 14], [60, 2, 5], [70, 93, 9]];
      const splats = seenChamp ? "" : SPOTS.map(([x, y, s], i) => `<span class="splat" style="width:${s}vh;height:${s}vh;left:calc(${x}% - ${s / 2}vh);top:calc(${y}% - ${s / 2}vh);animation-delay:${0.2 + i * 0.08}s;${i % 3 === 1 ? "background:#2e62c9" : ""}"></span>`).join("");
      return `<div class="s-champ" style="${seenChamp ? "animation:none" : ""}">${splats}<div class="frame">${av(c)}</div><div><small>${esc(S.name)} · Champion</small><h1>Winner</h1><h2>${esc(c.name)}</h2><p>Crowned by the room. Thanks for voting and bidding.</p></div></div>`;
    }
    onLoad(() => boot(render));
  }

  // ======================================================================
  // BRACKET
  // ======================================================================
  function bracket() {
    function rows(r, ids, final) {
      const c = r.counts || {};
      const showC = !!r.counts;
      const order = showC && (r.state === "closed" || r.state === "done") ? ids.slice().sort((a, b) => (c[b] || 0) - (c[a] || 0)) : ids;
      return order.map((id) => {
        const a = A(id); const adv = (r.state === "closed" || r.state === "done") && r.advancers.includes(id); const out = r.state === "done" && !adv;
        return `<div class="bk-row ${adv ? "adv" : ""} ${out ? "out" : ""}">${av(a)}<span class="n">${esc(a.name)}</span><span class="s">${showC ? `${c[id] || 0} vote${(c[id] || 0) === 1 ? "" : "s"}` : ""}${adv ? (final ? " · Winner" : " · →") : ""}</span></div>`;
      }).join("");
    }
    const tbd = (n) => Array.from({ length: n }, () => `<div class="bk-row tbd"><div class="av"></div><span class="n">To be decided</span><span class="s"></span></div>`).join("");
    function render() {
      document.title = "Bracket · " + S.name;
      const [r1, r2, r3] = S.rounds;
      const ids = (n) => (S.stage === "setup" ? S.artists.filter((a) => a.heat === n).map((a) => a.id) : S.rounds[n - 1].artists);
      const lab = (r) => (S.stage === "setup" ? "" : `<span class="chip ${r.state === "voting" ? "red" : r.state === "painting" ? "green" : "ghost"}">${{ pending: "Up next", painting: "Painting", voting: "Voting", closed: "Results", done: "Done" }[r.state]}</span>`);
      const finalFrom = (r) => (r.state === "done" ? r.advancers : []);
      const fin1 = r3.artists.length ? r3.artists.filter((id) => r1.advancers.includes(id)) : finalFrom(r1);
      const fin2 = r3.artists.length ? r3.artists.filter((id) => r2.advancers.includes(id)) : finalFrom(r2);
      const c = S.champion ? A(S.champion) : null;
      app.innerHTML = `${topbar()}<main class="bracket"><div class="wrap">
        <h1>Bracket</h1>
        <div class="bk">
          <div class="bk-col c-r1"><h3>Round 1 ${lab(r1)}</h3><div class="bk-box">${ids(1).length ? rows(r1, ids(1)) : tbd(5)}</div></div>
          <div class="bk-arrow">↓</div>
          <div class="bk-col c-r2"><h3>Round 2 ${lab(r2)}</h3><div class="bk-box">${ids(2).length ? rows(r2, ids(2)) : tbd(5)}</div></div>
          <div class="bk-arrow">↓</div><div class="ln h1"></div><div class="ln h2"></div><div class="ln v"></div>
          <div class="bk-col c-f1"><h3>Final ${S.current === 3 || S.stage === "done" ? lab(r3) : ""}</h3><div class="bk-box final">${fin1.length ? rows(r3, fin1, true) : tbd(2)}</div></div>
          <div class="bk-col c-f2"><h3 class="dsk" aria-hidden="true">Final</h3><div class="bk-box final">${fin2.length ? rows(r3, fin2, true) : tbd(2)}</div></div>
          <div class="bk-arrow">↓</div>
          <div class="bk-col c-ch"><h3>Champion</h3>${c ? `<div class="bk-champ">${av(c)}<div><small>Champion</small><b>${esc(c.name)}</b></div></div>` : `<div class="bk-champ tbd"><div class="av"></div><div><small>Champion</small><b>TBD</b></div></div>`}</div>
        </div>
        <footer class="foot"><a href="/e/${EID}">← Vote &amp; bid</a><a href="/s/${EID}">Projector view</a></footer>
      </div></main>`;
      setConn(ws && ws.readyState === 1);
    }
    onLoad(() => boot(render));
  }

  // ---------- router ----------
  if (VIEW === "home") home();
  else if (VIEW === "e") audience();
  else if (VIEW === "h") host();
  else if (VIEW === "s") screen();
  else if (VIEW === "b") bracket();
  else app.innerHTML = notFound("Page not found");
})();
