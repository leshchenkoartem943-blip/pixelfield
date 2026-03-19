const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); tg.setHeaderColor?.("#060912"); }

const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const mini = document.getElementById("mini");
const mctx = mini.getContext("2d");
const statsEl = document.getElementById("stats");
const loadingEl = document.getElementById("loading");
const toastEl = document.getElementById("toast");
const overlay = document.getElementById("overlay");
const panel = document.getElementById("panel");
const panelTitle = document.getElementById("panelTitle");
const panelBody = document.getElementById("panelBody");

const btnClose = document.getElementById("btnClose");
const btnRecenter = document.getElementById("btnRecenter");
const btnShop = document.getElementById("btnShop");
const btnLoot = document.getElementById("btnLoot");
const btnProfile = document.getElementById("btnProfile");
const btnTop = document.getElementById("btnTop");
const btnPool = document.getElementById("btnPool");

// Remove legacy elements
const btnRoundEl = document.getElementById("btnRound");
if (btnRoundEl) btnRoundEl.remove();

const INITDATA = tg?.initData || "";
const headers = INITDATA
  ? { "X-TG-INITDATA": INITDATA }
  : { "X-ADMIN-SECRET": "change_me" };

const API_BASE = (
  window.__API_BASE__ ||
  (location.hostname.endsWith("github.io") ? "https://pixel-field-backend.onrender.com" : "") ||
  ""
).replace(/\/$/, "");

let mapW = 150, mapH = 150;
let me = { x: 75, y: 75, id: 0 };
let meData = {};
let coins = 0, score = 0;
let tiles = new Map();
let players = new Map();
let zoom = 14;
let offsetX = 0, offsetY = 0;
let dragging = false, dragMoved = false;
let lastMouse = { x: 0, y: 0 };
let dragStart = { x: 0, y: 0 };
let suppressClickUntil = 0;
let actionInFlight = false;
let t0 = performance.now();

// ─── Toast ───────────────────────────────
let toastTimer = null;
function showToast(msg, type = "", duration = 1800) {
  toastEl.textContent = msg;
  toastEl.className = "show" + (type ? " toast-" + type : "");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ""; }, duration);
}

// ─── Panel open/close ─────────────────────
function openPanel(title, contentFn) {
  panelTitle.textContent = title;
  panelBody.innerHTML = `<div style="text-align:center;padding:24px 0"><div class="spinner" style="margin:0 auto"></div></div>`;
  panel.classList.remove("hidden");
  overlay.classList.add("show");
  contentFn();
}
function closePanel() {
  panel.classList.add("hidden");
  overlay.classList.remove("show");
}
btnClose.onclick = closePanel;
overlay.onclick = closePanel;

// ─── API helpers ─────────────────────────
async function apiGet(path) {
  const r = await fetch(`${API_BASE}${path}`, { headers });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function apiPost(path, body) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ─── Canvas helpers ──────────────────────
function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mini.width = Math.floor(mini.clientWidth * dpr);
  mini.height = Math.floor(mini.clientHeight * dpr);
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", () => { resize(); render(); });
resize();

function key(x, y) { return `${x},${y}`; }
function screenToTile(sx, sy) {
  return { x: Math.floor((sx - offsetX) / zoom), y: Math.floor((sy - offsetY) / zoom) };
}
function tileToScreen(x, y) {
  return { sx: x * zoom + offsetX, sy: y * zoom + offsetY };
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function recenter() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  offsetX = Math.floor(w / 2 - me.x * zoom - zoom / 2);
  offsetY = Math.floor(h / 2 - me.y * zoom - zoom / 2);
}
btnRecenter.onclick = () => { recenter(); render(); };

function inWorldTile(tx, ty) {
  const cx = Math.floor(mapW / 2), cy = Math.floor(mapH / 2);
  const r = Math.floor(Math.min(mapW, mapH) / 2) - 1;
  return (tx - cx) ** 2 + (ty - cy) ** 2 <= r * r;
}

function viewportTiles() {
  const w = canvas.clientWidth, h = canvas.clientHeight, pad = 2;
  const x0 = Math.floor((-offsetX) / zoom) - pad;
  const y0 = Math.floor((-offsetY) / zoom) - pad;
  const x1 = Math.floor((w - offsetX) / zoom) + pad;
  const y1 = Math.floor((h - offsetY) / zoom) + pad;
  return {
    x0: clamp(x0, 0, mapW - 1), y0: clamp(y0, 0, mapH - 1),
    x1: clamp(x1, 0, mapW - 1), y1: clamp(y1, 0, mapH - 1),
  };
}

// ─── Style rendering ─────────────────────
function parseStyle(s) {
  if (!s || typeof s !== "string") return { style: "solid", color: "#44ccff" };
  const parts = s.split(":");
  let color = parts.length >= 2 ? parts[1] : s;
  if (/^#?[0-9a-fA-F]{3}$/.test(color)) {
    const h = color.replace("#", "");
    color = `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(color)) color = `#${color}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = "#44ccff";
  return { style: parts.length >= 2 ? parts[0] : "solid", color: color.toLowerCase() };
}

function hash2(x, y) {
  let n = x * 374761393 + y * 668265263;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967295;
}

function shade(hex, f) {
  const h = hex.replace("#", "");
  const r = Math.max(0, Math.min(255, Math.round(parseInt(h.slice(0,2),16) * f)));
  const g = Math.max(0, Math.min(255, Math.round(parseInt(h.slice(2,4),16) * f)));
  const b = Math.max(0, Math.min(255, Math.round(parseInt(h.slice(4,6),16) * f)));
  return `#${r.toString(16).padStart(2,"0")}${g.toString(16).padStart(2,"0")}${b.toString(16).padStart(2,"0")}`;
}

function lerp(a, b, t) { return a + (b - a) * t; }
function mix(c1, c2, t) {
  const h1 = c1.replace("#",""), h2 = c2.replace("#","");
  const r = Math.round(lerp(parseInt(h1.slice(0,2),16), parseInt(h2.slice(0,2),16), t));
  const g = Math.round(lerp(parseInt(h1.slice(2,4),16), parseInt(h2.slice(2,4),16), t));
  const b = Math.round(lerp(parseInt(h1.slice(4,6),16), parseInt(h2.slice(4,6),16), t));
  return `#${r.toString(16).padStart(2,"0")}${g.toString(16).padStart(2,"0")}${b.toString(16).padStart(2,"0")}`;
}

function hsvToHex(h, s, v) {
  const i = Math.floor(h*6), f = h*6-i, p = v*(1-s), q = v*(1-f*s), t = v*(1-(1-f)*s);
  let r,g,b;
  switch(i%6){case 0:r=v;g=t;b=p;break;case 1:r=q;g=v;b=p;break;case 2:r=p;g=v;b=t;break;
    case 3:r=p;g=q;b=v;break;case 4:r=t;g=p;b=v;break;default:r=v;g=p;b=q;}
  return `#${Math.max(0,Math.min(255,Math.round(r*255))).toString(16).padStart(2,"0")}${Math.max(0,Math.min(255,Math.round(g*255))).toString(16).padStart(2,"0")}${Math.max(0,Math.min(255,Math.round(b*255))).toString(16).padStart(2,"0")}`;
}

function drawStyledTile(sx, sy, size, styleStr, x, y, timeSec) {
  const { style, color } = parseStyle(styleStr);
  switch (style) {
    case "gradient": {
      const g = ctx.createLinearGradient(sx, sy, sx+size, sy+size);
      g.addColorStop(0, color); g.addColorStop(1, shade(color, 0.55));
      ctx.fillStyle = g; ctx.fillRect(sx, sy, size, size); return;
    }
    case "marble": {
      const n = hash2(x, y);
      const veins = Math.abs(Math.sin((x*0.9+y*0.7)+n*6.0));
      ctx.fillStyle = shade(color, 0.55+veins*0.65); ctx.fillRect(sx, sy, size, size);
      if (size >= 10) {
        ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(sx+n*size, sy); ctx.lineTo(sx+size, sy+n*size); ctx.stroke();
      } return;
    }
    case "magma": case "magma_sparks": {
      const n = hash2(x, y);
      const pulse = Math.sin(timeSec*1.8+n*4.0)*0.5+0.5;
      const g = ctx.createRadialGradient(sx+size*.5,sy+size*.5,size*.1,sx+size*.5,sy+size*.5,size*.75);
      g.addColorStop(0, shade(mix("#ffd44a","#ffffff",0.3), 0.9+0.4*pulse));
      g.addColorStop(1, shade(color, 0.7));
      ctx.fillStyle = g; ctx.fillRect(sx, sy, size, size);
      if (size >= 10) { ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.strokeRect(sx+.5,sy+.5,size-1,size-1); }
      if (style === "magma_sparks" && size >= 10) {
        if (hash2(x+Math.floor(timeSec*3),y+19) > 0.99) {
          ctx.fillStyle = "rgba(255,245,200,0.95)";
          ctx.fillRect(sx+size*(hash2(x,y)*.7+.15), sy+size*(hash2(y,x)*.7+.15), 2, 2);
        }
      } return;
    }
    case "rainbow_shift": {
      const h = (timeSec*0.08+(x*0.02)+(y*0.015))%1;
      ctx.fillStyle = hsvToHex(h, 0.9, 0.95); ctx.fillRect(sx, sy, size, size); return;
    }
    case "neon_pulse": {
      const phase = Math.sin(timeSec*4.0+(x+y)*0.35)*0.5+0.5;
      ctx.fillStyle = shade(color, 0.9+0.4*phase); ctx.fillRect(sx, sy, size, size);
      if (size >= 10) {
        ctx.strokeStyle = `rgba(255,255,255,${0.25+0.35*phase})`; ctx.lineWidth = 1.5;
        ctx.strokeRect(sx+.5,sy+.5,size-1,size-1);
      } return;
    }
    case "ice": {
      const g = ctx.createLinearGradient(sx, sy, sx+size, sy+size);
      g.addColorStop(0, mix("#a5f3fc",color,.35)); g.addColorStop(1, mix("#60a5fa",color,.55));
      ctx.fillStyle = g; ctx.fillRect(sx, sy, size, size);
      if (size >= 10) {
        const n = hash2(x,y); ctx.strokeStyle = `rgba(255,255,255,${0.08+n*.18})`;
        ctx.beginPath(); ctx.moveTo(sx+size*.2,sy+size*.1); ctx.lineTo(sx+size*.9,sy+size*.8); ctx.stroke();
      } return;
    }
    case "crystal": {
      const g = ctx.createLinearGradient(sx, sy+size, sx+size, sy);
      g.addColorStop(0, mix(color,"#ffffff",.2)); g.addColorStop(1, mix(color,"#22d3ee",.35));
      ctx.fillStyle = g; ctx.fillRect(sx, sy, size, size);
      if (size >= 10) {
        const n = hash2(x,y); ctx.fillStyle = `rgba(255,255,255,${0.15+0.25*n})`;
        ctx.beginPath(); ctx.moveTo(sx+size*.15,sy+size*.85); ctx.lineTo(sx+size*.55,sy+size*.25);
        ctx.lineTo(sx+size*.85,sy+size*.65); ctx.closePath(); ctx.fill();
      } return;
    }
    case "aurora": {
      const n = hash2(x,y);
      const g = ctx.createLinearGradient(sx, sy+size, sx+size, sy);
      g.addColorStop(0, mix(hsvToHex((timeSec*.03+n)%1,.75,.95),color,.35));
      g.addColorStop(1, mix(hsvToHex((timeSec*.03+n+.18)%1,.75,.75),color,.35));
      ctx.fillStyle = g; ctx.fillRect(sx, sy, size, size); return;
    }
    case "galaxy": {
      const n = hash2(x,y);
      ctx.fillStyle = mix("#020617",color,.18); ctx.fillRect(sx, sy, size, size);
      if (size >= 10) {
        const s1 = hash2(x*7+11,y*13+3);
        if (s1 > 0.97) {
          ctx.fillStyle = "rgba(255,255,255,0.95)";
          ctx.fillRect(sx+size*(hash2(x,y)*.8+.1), sy+size*(hash2(y,x)*.8+.1), 1+(s1-.97)*6, 1+(s1-.97)*6);
        }
        const glow = Math.max(0, Math.sin(timeSec*.4+x*.12+y*.07)*.5+.5);
        ctx.fillStyle = `rgba(129,140,248,${.04+.10*glow*n})`; ctx.fillRect(sx, sy, size, size);
        ctx.fillStyle = `rgba(45,212,191,${.03+.08*(1-glow)*n})`; ctx.fillRect(sx, sy, size, size);
      } return;
    }
    case "glitch": {
      ctx.fillStyle = "#020617"; ctx.fillRect(sx, sy, size, size);
      if (size >= 6) {
        const palette = ["rgba(255,45,85,0.9)","rgba(0,122,255,0.9)","rgba(52,199,89,0.9)","rgba(191,90,242,0.9)"];
        for (let i = 0; i < 4; i++) {
          const r = hash2(x*13+i*7,y*17+i*3);
          const pw=(0.2+r*0.6)*size, ph=(0.1+hash2(x+i,y+i)*0.3)*size;
          ctx.fillStyle = palette[i%4];
          ctx.fillRect(sx+hash2(x+i*31,y)*(size-pw), sy+hash2(x,y+i*19)*(size-ph), pw, ph);
        }
      } return;
    }
    case "carbon": {
      const n = ((x+y)&1) ? 0.15 : 0.0;
      ctx.fillStyle = mix("#0b0f17",color,.25+n); ctx.fillRect(sx, sy, size, size);
      if (size >= 10) { ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.strokeRect(sx+.5,sy+.5,size-1,size-1); }
      return;
    }
    default: {
      const n = hash2(x, y), f = 0.90+n*0.16;
      ctx.fillStyle = shade(color, f); ctx.fillRect(sx, sy, size, size);
    }
  }
}

// ─── Render ──────────────────────────────
let particlePool = [];

function render(timeNow = performance.now()) {
  const timeSec = (timeNow - t0) / 1000;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  // Deep-space background
  ctx.fillStyle = "#060912";
  ctx.fillRect(0, 0, w, h);

  const { x0, y0, x1, y1 } = viewportTiles();

  // Draw arena background glow
  const cx = Math.floor(mapW/2), cy = Math.floor(mapH/2);
  const ar = Math.floor(Math.min(mapW,mapH)/2)-1;
  const { sx: acx, sy: acy } = tileToScreen(cx, cy);
  const arPx = ar * zoom;
  const grd = ctx.createRadialGradient(acx, acy, 0, acx, acy, arPx);
  grd.addColorStop(0, "rgba(76,201,240,0.03)");
  grd.addColorStop(0.4, "rgba(76,201,240,0.015)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(acx, acy, arPx, 0, Math.PI*2);
  ctx.fill();

  // Draw tiles
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!inWorldTile(x, y)) continue;
      const it = tiles.get(key(x, y));
      const { sx, sy } = tileToScreen(x, y);
      if (it) {
        drawStyledTile(sx, sy, zoom, it.c || "#44ccff", x, y, timeSec);
      } else {
        ctx.fillStyle = (x+y)%23===0 ? "#0a1422" : "#080d18";
        ctx.fillRect(sx, sy, zoom, zoom);
      }
    }
  }

  // Subtle grid at high zoom
  if (zoom >= 16) {
    ctx.strokeStyle = "rgba(76,201,240,0.04)";
    ctx.lineWidth = 0.5;
    for (let x = x0; x <= x1+1; x++) {
      const { sx } = tileToScreen(x, y0);
      ctx.beginPath(); ctx.moveTo(sx, tileToScreen(x,y0).sy); ctx.lineTo(sx, tileToScreen(x,y1+1).sy); ctx.stroke();
    }
    for (let y = y0; y <= y1+1; y++) {
      const { sy } = tileToScreen(x0, y);
      ctx.beginPath(); ctx.moveTo(tileToScreen(x0,y).sx, sy); ctx.lineTo(tileToScreen(x1+1,y).sx, sy); ctx.stroke();
    }
  }

  // Arena border
  ctx.save();
  ctx.beginPath();
  ctx.arc(acx, acy, arPx, 0, Math.PI*2);
  ctx.strokeStyle = "rgba(76,201,240,0.3)";
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // Other players
  for (const [id, pl] of players.entries()) {
    if (id === me.id) continue;
    const ps = tileToScreen(pl.x, pl.y);
    const { color } = parseStyle(pl.style);
    const r = Math.max(4, zoom * 0.3);
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = zoom >= 10 ? 8 : 0;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(ps.sx+zoom*.5, ps.sy+zoom*.5, r, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // Name label at high zoom
    if (zoom >= 14 && pl.name) {
      ctx.save();
      ctx.font = `bold ${Math.max(9, zoom*0.55)}px ui-sans-serif,system-ui,sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,0.8)"; ctx.shadowBlur = 4;
      ctx.fillText(pl.name.slice(0,12), ps.sx+zoom*.5, ps.sy-4);
      ctx.restore();
    }
  }

  // My player — glowing dot
  const p = tileToScreen(me.x, me.y);
  const pulse = Math.sin(timeSec*3.5)*0.3+0.7;
  ctx.save();
  ctx.shadowColor = "#4cc9f0";
  ctx.shadowBlur = 16*pulse;
  ctx.strokeStyle = "#4cc9f0";
  ctx.lineWidth = 2;
  ctx.strokeRect(p.sx+1, p.sy+1, zoom-2, zoom-2);
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#ffffff";
  const inner = zoom*0.3;
  ctx.fillRect(p.sx+(zoom-inner)*.5, p.sy+(zoom-inner)*.5, inner, inner);
  ctx.restore();
}

// ─── Minimap ─────────────────────────────
async function fetchMinimap() {
  const data = await apiGet("/api/game/minimap");
  mapW = data.map.w; mapH = data.map.h;
  const w = mini.clientWidth, h = mini.clientHeight;
  const cw = w/mapW, ch = h/mapH;
  mctx.clearRect(0, 0, w, h);

  // background
  mctx.fillStyle = "rgba(6,9,18,0.9)";
  mctx.fillRect(0, 0, w, h);

  // arena circle
  const mcx = (mapW/2)*cw, mcy = (mapH/2)*ch;
  const mr = (Math.min(mapW,mapH)/2-1)*cw;
  mctx.strokeStyle = "rgba(76,201,240,0.25)";
  mctx.lineWidth = 1;
  mctx.beginPath(); mctx.arc(mcx, mcy, mr, 0, Math.PI*2); mctx.stroke();

  for (const t of data.tiles) {
    if (!inWorldTile(t.x, t.y)) continue;
    const { color } = parseStyle(t.c);
    mctx.fillStyle = color;
    mctx.fillRect(t.x*cw, t.y*ch, Math.max(1,cw), Math.max(1,ch));
  }
  for (const p of data.players) {
    if (!inWorldTile(p.x, p.y)) continue;
    const { color } = parseStyle(p.style);
    mctx.fillStyle = color;
    mctx.fillRect(p.x*cw, p.y*ch, Math.max(2,cw), Math.max(2,ch));
  }

  // me
  mctx.fillStyle = "#ffffff";
  mctx.fillRect(data.me.x*cw-1, data.me.y*ch-1, Math.max(3,cw)+2, Math.max(3,ch)+2);

  // viewport
  const vp = viewportTiles();
  mctx.strokeStyle = "rgba(76,201,240,0.5)";
  mctx.lineWidth = 1;
  mctx.strokeRect(vp.x0*cw, vp.y0*ch, (vp.x1-vp.x0)*cw, (vp.y1-vp.y0)*ch);
}

// ─── State fetch ─────────────────────────
let lastStateFetch = 0;
async function fetchState() {
  const t = Date.now();
  if (t - lastStateFetch < 200) return;
  lastStateFetch = t;
  const { x0, y0, x1, y1 } = viewportTiles();
  const data = await apiGet(`/api/game/state?x0=${x0}&y0=${y0}&x1=${x1}&y1=${y1}`);
  mapW = data.map.w; mapH = data.map.h;
  me = { x: data.me.x, y: data.me.y, id: data.me.id };
  for (const it of data.tiles) tiles.set(key(it.x,it.y), {c:it.c,o:it.o});
  players.clear();
  for (const pl of (data.players||[])) players.set(pl.id, pl);
}

function updateStats(d) {
  if (d) { coins = d.coins; score = d.score; if (d.pos) me = {...d.pos, id: me.id}; }
  statsEl.innerHTML = `<span style="color:#4cc9f0">⬡ ${coins}</span> &nbsp; <span style="color:#a78bfa">★ ${score}</span>`;
}

// ─── Input ───────────────────────────────
canvas.addEventListener("mousedown", e => {
  dragging = true; dragMoved = false;
  lastMouse = dragStart = { x: e.clientX, y: e.clientY };
});
window.addEventListener("mouseup", () => {
  dragging = false;
  if (dragMoved) suppressClickUntil = performance.now() + 250;
});
window.addEventListener("mousemove", e => {
  if (!dragging) return;
  const dx = e.clientX-lastMouse.x, dy = e.clientY-lastMouse.y;
  lastMouse = { x: e.clientX, y: e.clientY };
  const ddx = e.clientX-dragStart.x, ddy = e.clientY-dragStart.y;
  if (ddx*ddx+ddy*ddy > 36) dragMoved = true;
  offsetX += dx; offsetY += dy;
  fetchState().then(render).catch(()=>render());
});

canvas.addEventListener("touchstart", e => {
  if (e.touches.length === 1) {
    const t = e.touches[0];
    dragging = true; dragMoved = false;
    lastMouse = dragStart = { x: t.clientX, y: t.clientY };
  }
}, { passive: true });
window.addEventListener("touchend", () => {
  dragging = false;
  if (dragMoved) suppressClickUntil = performance.now() + 250;
});
window.addEventListener("touchmove", e => {
  if (!dragging || e.touches.length !== 1) return;
  const t = e.touches[0];
  const dx = t.clientX-lastMouse.x, dy = t.clientY-lastMouse.y;
  lastMouse = { x: t.clientX, y: t.clientY };
  const ddx = t.clientX-dragStart.x, ddy = t.clientY-dragStart.y;
  if (ddx*ddx+ddy*ddy > 36) dragMoved = true;
  offsetX += dx; offsetY += dy;
  fetchState().then(render).catch(()=>render());
}, { passive: true });

canvas.addEventListener("wheel", e => {
  e.preventDefault();
  suppressClickUntil = performance.now()+200;
  const oldZoom = zoom;
  zoom = clamp(zoom + (Math.sign(e.deltaY) > 0 ? -1 : 1), 5, 36);
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX-rect.left, my = e.clientY-rect.top;
  offsetX = mx - ((mx-offsetX)/oldZoom)*zoom;
  offsetY = my - ((my-offsetY)/oldZoom)*zoom;
  fetchState().then(render).catch(render);
}, { passive: false });

canvas.addEventListener("click", async e => {
  if (dragging || actionInFlight || performance.now() < suppressClickUntil) return;
  const rect = canvas.getBoundingClientRect();
  const t = screenToTile(e.clientX-rect.left, e.clientY-rect.top);
  if (!inWorldTile(t.x, t.y)) { showToast("вне арены", "error"); return; }
  const dx = clamp(t.x-me.x, -1, 1), dy = clamp(t.y-me.y, -1, 1);
  if (Math.abs(dx)+Math.abs(dy) === 0) return;
  let sx1 = dx, sy1 = dy;
  if (Math.abs(dx)+Math.abs(dy) === 2) {
    if (Math.abs(t.x-me.x) >= Math.abs(t.y-me.y)) sy1 = 0; else sx1 = 0;
  }
  const nx = clamp(me.x+sx1, 0, mapW-1), ny = clamp(me.y+sy1, 0, mapH-1);
  try {
    actionInFlight = true;
    const resp = await apiPost("/api/game/paint", { x: nx, y: ny, color: "#44ccff" });
    me = { ...resp.pos, id: me.id };
    coins = resp.coins; score = resp.score;
    if (resp.result?.new) {
      if (resp.result.loot) showToast(`📦 Лут!`, "loot");
      if (resp.result.level && resp.result.level > (meData.level||1)) {
        showToast(`⭐ Уровень ${resp.result.level}!`, "level");
        meData.level = resp.result.level;
      }
    }
    updateStats();
    await fetchState();
    render();
  } catch (err) {
    const msg = (err?.message) || "";
    if (msg.includes("paint_cooldown")) {
      try {
        const m = await apiPost("/api/game/move", { dx: sx1, dy: sy1 });
        me = { ...m.pos, id: me.id };
        showToast("кулдаун покраски"); updateStats();
        await fetchState(); render(); return;
      } catch {}
    }
    if (msg.includes("move_cooldown")) showToast("кулдаун", "error");
    else if (msg.includes("out_of_arena")) showToast("за пределами", "error");
    else if (msg.includes("too_far")) showToast("слишком далеко", "error");
    updateStats();
  } finally { actionInFlight = false; }
});

// ─── Profile ─────────────────────────────
btnProfile.onclick = () => openPanel("👤 Профиль", async () => {
  const prof = await apiGet("/api/profile");
  const m = prof.me;
  meData = m;
  const inv = prof.inventory || [];
  const invStyles = inv.filter(x => x.kind === "style");
  const invColors = inv.filter(x => x.kind === "color");
  const xpForNext = (m.level * 25);
  const xpPct = Math.min(100, Math.round((m.xp % 25)/25*100));
  const avatarColor = m.base_color || "#44ccff";
  const letter = (m.display_name||"P")[0].toUpperCase();

  panelBody.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="row">
        <div class="row-start">
          <div class="avatar" style="background:${avatarColor}22;border-color:${avatarColor}44;color:${avatarColor}">${letter}</div>
          <div class="col">
            <div class="bold">${m.display_name}</div>
            <div class="muted">Уровень ${m.level} · ${m.xp} XP</div>
            <div class="level-bar-wrap" style="width:120px">
              <div class="level-bar-fill" style="width:${xpPct}%"></div>
            </div>
          </div>
        </div>
        <div class="col" style="text-align:right">
          <div class="gold bold">⬡ ${m.coins}</div>
          <div class="muted">★ ${m.score} очков</div>
          <div class="muted">🟩 ${m.tiles_painted} кл.</div>
        </div>
      </div>
      <div class="sep"></div>
      <div class="row">
        <div class="muted small">Стиль: <span style="color:#e8eefc">${m.paint_style}</span></div>
        <div class="row-start">
          <div class="color-dot" style="background:${m.base_color}"></div>
          <div class="muted small">${m.base_color}</div>
        </div>
      </div>
    </div>
    ${invStyles.length||invColors.length ? `
    <div class="bold small" style="margin-bottom:8px;color:var(--muted)">ИНВЕНТАРЬ</div>
    <div id="invItems"></div>
    ` : `<div class="card"><div class="muted" style="text-align:center;padding:8px 0">Инвентарь пуст. Открой Магазин!</div></div>`}
  `;

  const wrap = panelBody.querySelector("#invItems");
  if (wrap) {
    [...invStyles, ...invColors].forEach(it => {
      const div = document.createElement("div");
      div.className = "card";
      const isColor = it.kind === "color";
      div.innerHTML = `
        <div class="row">
          <div class="row-start">
            ${isColor
              ? `<div class="color-swatch" style="background:${it.payload}"></div>`
              : `<div class="style-preview" id="prev_${it.id}"></div>`}
            <div class="col"><div class="bold small">${it.title}</div><div class="muted" style="font-size:11px">${it.id}</div></div>
          </div>
          <button class="btn btn-accent small equip-btn">Экипировать</button>
        </div>
      `;
      div.querySelector(".equip-btn").onclick = async () => {
        try {
          await apiPost("/api/cosmetics/equip", { cosmetic_id: it.id });
          showToast("Экипировано!");
          tiles.clear();
          await fetchState(); await fetchMinimap(); render();
        } catch { showToast("Ошибка", "error"); }
      };
      wrap.appendChild(div);
    });
  }
});

// ─── Shop ────────────────────────────────
const SHOP_CATEGORIES = [
  { id: "boost", label: "⚡ Бусты" },
  { id: "style", label: "✨ Стили" },
  { id: "color", label: "🎨 Цвета" },
];

btnShop.onclick = () => openPanel("🛒 Магазин", async () => {
  const cat = await apiGet("/api/shop/catalog");
  const allItems = cat.items;
  let currentTab = "boost";

  function renderTab(tabId) {
    currentTab = tabId;
    const items = allItems.filter(it => it.kind === tabId);
    const grid = panelBody.querySelector("#shopGrid");
    if (!grid) return;
    grid.innerHTML = "";
    if (!items.length) {
      grid.innerHTML = `<div class="muted" style="text-align:center;padding:16px">Пусто</div>`;
      return;
    }
    items.forEach(it => {
      const div = document.createElement("div");
      div.className = "card";
      const isColor = it.kind === "color";
      const isStyle = it.kind === "style";
      const priceStr = it.price === 0 ? `<span class="green bold">Бесплатно</span>` : `<span class="gold">${it.price} ⬡</span>`;
      let preview = "";
      if (isColor) preview = `<div class="color-swatch" style="background:${it.payload}"></div>`;
      else if (isStyle) preview = `<div class="style-preview" style="background:linear-gradient(135deg,#0c1220,#1a2840);font-size:10px;display:flex;align-items:center;justify-content:center;color:var(--muted)">${it.payload.slice(0,4)}</div>`;

      div.innerHTML = `
        <div class="row">
          <div class="row-start">
            ${preview}
            <div class="col">
              <div class="bold small">${it.title}</div>
              <div>${priceStr}</div>
            </div>
          </div>
          <button class="btn btn-accent small buy-btn">Купить</button>
        </div>
      `;
      div.querySelector(".buy-btn").onclick = async (e) => {
        const btn = e.currentTarget;
        btn.textContent = "..."; btn.disabled = true;
        try {
          const r = await apiPost("/api/shop/buy", { item_id: it.id });
          coins = r.coins; updateStats();
          btn.textContent = "✓"; btn.style.color = "var(--green)";
          showToast(`Куплено: ${it.title}`);
        } catch (err) {
          btn.textContent = "✕"; btn.style.color = "var(--red)";
          showToast("Ошибка покупки", "error");
          setTimeout(() => { btn.textContent = "Купить"; btn.style.color = ""; btn.disabled = false; }, 1500);
          return;
        }
      };
      grid.appendChild(div);
    });
  }

  const tabsHtml = SHOP_CATEGORIES.map(c =>
    `<button class="tab-btn${c.id===currentTab?' active':''}" data-tab="${c.id}">${c.label}</button>`
  ).join("");

  panelBody.innerHTML = `
    <div class="shop-tabs">${tabsHtml}</div>
    <div id="shopGrid"></div>
  `;
  panelBody.querySelectorAll(".tab-btn").forEach(btn => {
    btn.onclick = () => {
      panelBody.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderTab(btn.dataset.tab);
    };
  });
  renderTab(currentTab);
});

// ─── Loot ────────────────────────────────
btnLoot.onclick = () => openPanel("📦 Лутбоксы", async () => {
  const list = await apiGet("/api/loot/list");
  if (!list.crates.length) {
    panelBody.innerHTML = `<div class="card"><div class="muted" style="text-align:center;padding:12px 0">Ящиков нет. Крась клетки у центра!</div></div>`;
    return;
  }
  panelBody.innerHTML = "";
  for (const c of list.crates) {
    const div = document.createElement("div");
    div.className = "card";
    const openedHtml = c.opened
      ? `<span class="reward-badge">${c.reward_type} +${c.reward_amount}</span>`
      : `<span class="muted small">Закрыт</span>`;
    div.innerHTML = `
      <div class="row">
        <div class="row-start">
          <div class="crate-icon">${c.opened ? "📂" : "📦"}</div>
          <div class="col">
            <div class="bold small">Ящик #${c.id}</div>
            <div>${openedHtml}</div>
          </div>
        </div>
        <button class="btn${c.opened ? '' : ' btn-accent'} open-btn">${c.opened ? "OK" : "Открыть"}</button>
      </div>
    `;
    const btn = div.querySelector(".open-btn");
    btn.disabled = c.opened;
    btn.onclick = async () => {
      btn.textContent = "..."; btn.disabled = true;
      try {
        const r = await apiPost(`/api/loot/open/${c.id}`, {});
        coins = r.coins; updateStats();
        const rw = r.result;
        div.querySelector(".col div:last-child").innerHTML = `<span class="reward-badge">${rw.reward_type} +${rw.reward_amount}</span>`;
        div.querySelector(".crate-icon").textContent = "📂";
        btn.textContent = "OK";
        showToast(`🎁 ${rw.reward_type} +${rw.reward_amount}`, "loot");
      } catch { btn.textContent = "Ошибка"; }
    };
    panelBody.appendChild(div);
  }
});

// ─── Leaderboard ─────────────────────────
btnTop.onclick = () => openPanel("🏆 Топ игроков", async () => {
  const data = await apiGet("/api/leaderboard");
  panelBody.innerHTML = "";
  if (!data.leaderboard.length) {
    panelBody.innerHTML = `<div class="muted" style="text-align:center;padding:16px">Пока нет игроков</div>`;
    return;
  }
  for (const p of data.leaderboard) {
    const div = document.createElement("div");
    div.className = "card";
    const rankClass = p.rank <= 3 ? `rank-${p.rank}` : "rank-n";
    const isMe = p.user_id === me.id;
    if (isMe) div.style.borderColor = "rgba(76,201,240,0.4)";
    div.innerHTML = `
      <div class="row">
        <div class="row-start">
          <div class="rank-badge ${rankClass}">${p.rank}</div>
          <div class="color-dot" style="background:${p.base_color}"></div>
          <div class="col">
            <div class="bold small">${p.display_name}${isMe ? ' <span style="color:var(--accent);font-size:10px">ВЫ</span>' : ''}</div>
            <div class="muted" style="font-size:11px">Ур. ${p.level} · 🟩 ${p.tiles_painted}</div>
          </div>
        </div>
        <div class="col" style="text-align:right">
          <div class="bold" style="font-size:13px;color:var(--accent)">★ ${p.score}</div>
        </div>
      </div>
    `;
    panelBody.appendChild(div);
  }
});

// ─── Donation Pool ───────────────────────
btnPool.onclick = () => openPanel("💎 Донат-пул", async () => {
  const pool = await apiGet("/api/pool");

  const endsDate = new Date(pool.ends_at + "Z");
  const msLeft = endsDate - Date.now();
  const hoursLeft = Math.max(0, Math.floor(msLeft/3600000));
  const minsLeft = Math.max(0, Math.floor((msLeft%3600000)/60000));

  const contribs = pool.contributors || [];
  const topPlayers = pool.top_players || [];

  panelBody.innerHTML = `
    <div class="pool-hero">
      <div class="pool-total">${pool.total_stars} ⭐</div>
      <div class="pool-label">Общий пул · Осталось ${hoursLeft}ч ${minsLeft}м</div>
    </div>

    <div class="card card-gold" style="margin-bottom:12px">
      <div class="bold small" style="margin-bottom:8px;color:var(--gold)">КАК ЭТО РАБОТАЕТ</div>
      <div class="muted small" style="line-height:1.6">
        Вкладывай Telegram Stars в пул.<br>
        Победитель — игрок с <b style="color:var(--text)">наибольшим счётом</b> к концу раунда — забирает <b style="color:var(--gold)">всё</b>.<br>
        За каждую ⭐ ты получаешь +5 игровых монет.
      </div>
    </div>

    <div class="bold small" style="margin-bottom:8px;color:var(--muted)">ВЛОЖИТЬ В ПУЛ</div>
    <div class="donate-btns" id="donateBtns">
      <button class="donate-amount-btn" data-stars="1">1 ⭐</button>
      <button class="donate-amount-btn" data-stars="5">5 ⭐</button>
      <button class="donate-amount-btn" data-stars="10">10 ⭐</button>
      <button class="donate-amount-btn" data-stars="25">25 ⭐</button>
      <button class="donate-amount-btn" data-stars="50">50 ⭐</button>
      <button class="donate-amount-btn" data-stars="100">100 ⭐</button>
    </div>
    <div id="donateMsg" style="text-align:center;min-height:20px;font-size:12px;color:var(--muted);margin-bottom:12px"></div>

    ${contribs.length ? `
    <div class="bold small" style="margin-bottom:8px;color:var(--muted)">ТОП ВКЛАДЧИКОВ</div>
    <div id="contribs"></div>
    ` : ""}

    ${topPlayers.length ? `
    <div class="bold small" style="margin:10px 0 8px;color:var(--muted)">ТОП ИГРОКОВ (потенциальный победитель)</div>
    <div id="topPlayers"></div>
    ` : ""}
  `;

  // Donate buttons
  panelBody.querySelectorAll(".donate-amount-btn").forEach(btn => {
    btn.onclick = async () => {
      const stars = parseInt(btn.dataset.stars);
      const msgEl = panelBody.querySelector("#donateMsg");
      msgEl.textContent = "Отправляем в бот...";
      try {
        // Direct API donation (for dev/test — in production goes via bot invoice)
        const r = await apiPost("/api/pool/donate", { stars });
        coins = r.coins; updateStats();
        msgEl.innerHTML = `<span style="color:var(--green)">✓ Внесено ${stars} ⭐ · Пул: ${r.result.pool_total} ⭐ · +${r.result.bonus_coins} монет</span>`;
        // Update pool total display
        panelBody.querySelector(".pool-total").textContent = `${r.result.pool_total} ⭐`;
        showToast(`+${stars} ⭐ в пул!`, "loot");
      } catch (e) {
        msgEl.innerHTML = `<span style="color:var(--muted)">Используй /donate_${stars} в боте для оплаты Stars</span>`;
      }
    };
  });

  const cWrap = panelBody.querySelector("#contribs");
  if (cWrap) {
    contribs.forEach((c, i) => {
      const div = document.createElement("div");
      div.className = "card";
      div.innerHTML = `
        <div class="row">
          <div class="row-start">
            <div class="rank-badge ${i<3?`rank-${i+1}`:'rank-n'}">${i+1}</div>
            <div class="bold small">${c.display_name}</div>
          </div>
          <div class="gold bold">${c.stars} ⭐</div>
        </div>
      `;
      cWrap.appendChild(div);
    });
  }

  const tpWrap = panelBody.querySelector("#topPlayers");
  if (tpWrap) {
    topPlayers.forEach((p, i) => {
      const div = document.createElement("div");
      div.className = "card" + (i===0 ? " card-gold" : "");
      div.innerHTML = `
        <div class="row">
          <div class="row-start">
            <div class="rank-badge ${i===0?'rank-1':i===1?'rank-2':i===2?'rank-3':'rank-n'}">${i+1}</div>
            <div class="col">
              <div class="bold small">${p.display_name} ${i===0?'👑':''}</div>
              <div class="muted" style="font-size:11px">Ур. ${p.level} · 🟩 ${p.tiles_painted}</div>
            </div>
          </div>
          <div class="bold" style="color:var(--accent);font-size:13px">★ ${p.score}</div>
        </div>
      `;
      tpWrap.appendChild(div);
    });
  }
});

// ─── Init ────────────────────────────────
async function init() {
  const d = await apiGet("/api/me");
  meData = d;
  coins = d.coins; score = d.score;
  me = { ...d.pos, id: d.id };
  recenter();
  await Promise.all([fetchState(), fetchMinimap()]);
  updateStats();
  render();
  if (loadingEl) loadingEl.style.display = "none";
}

function animate(now) {
  render(now);
  requestAnimationFrame(animate);
}

setInterval(() => { fetchMinimap().catch(()=>{}); }, 2000);

init().catch(e => {
  const msg = (e?.message) || String(e);
  statsEl.textContent = `Ошибка: ${msg}`;
  if (loadingEl) {
    loadingEl.querySelector(".loading-text").textContent = `Ошибка: ${msg}`;
    loadingEl.querySelector(".spinner").style.display = "none";
  }
  console.error(e);
});

requestAnimationFrame(animate);
