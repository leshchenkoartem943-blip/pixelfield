const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); tg.setHeaderColor?.("#060912"); }

const canvas  = document.getElementById("c");
const ctx     = canvas.getContext("2d");
const mini    = document.getElementById("mini");
const mctx    = mini.getContext("2d");
const statsEl = document.getElementById("stats");
const loadingEl = document.getElementById("loading");
const toastEl   = document.getElementById("toast");
const overlay   = document.getElementById("overlay");
const panel     = document.getElementById("panel");
const panelTitle = document.getElementById("panelTitle");
const panelBody  = document.getElementById("panelBody");
const popupEl    = document.getElementById("popup");
const popupTitle = document.getElementById("popupTitle");
const popupBody  = document.getElementById("popupBody");

const INITDATA = tg?.initData || "";
const IS_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const headers  = INITDATA
  ? { "X-TG-INITDATA": INITDATA }
  : IS_LOCAL
    ? { "X-ADMIN-SECRET": "change_me" }
    : {};

const API_BASE = (window.__API_BASE__ || "").replace(/\/$/, "");

let mapW = 150, mapH = 150, arenaR = 74, arenaShape = "circle";
// Zone system (synced from server)
let zoneThresholds = [0.80, 0.55, 0.30, 0.15]; // fraction of arenaR
let zoneHardness   = {1:1, 2:3, 3:5, 4:10, 5:20};
const ZONE_COLORS  = ["#22c55e","#eab308","#f97316","#ef4444","#a855f7"]; // z1..z5
const ZONE_LABELS  = ["×1","×3","×5","×10","×20"];
let me = { x: 75, y: 75, id: 0 };
let meData = {};
let coins = 0, score = 0;
let tiles   = new Map();
let players = new Map();
let borders = {};       // user_id(str) → border_style
let activeEvents = [];
let zoom = 14, offsetX = 0, offsetY = 0;
let dragging = false, dragMoved = false;
let lastMouse = { x:0, y:0 }, dragStart = { x:0, y:0 };
let suppressClickUntil = 0;
let actionInFlight = false;
let t0 = performance.now();

// Pool ticker state
let poolStars = 0;
let lastAlertId = 0;
// Pending empty-tile zone paintings: key → {h, u, z}
let pendingTiles = new Map();

// Confetti particles for jackpot
const confetti = [];
const confettiCanvas = document.getElementById("confettiCanvas");
const cctx = confettiCanvas?.getContext("2d");

// ── Particles ────────────────────────────────────────────────────────────────
const particles = [];

function spawnParticles(sx, sy, color, count = 10) {
  for (let i = 0; i < count; i++) {
    const angle = (Math.random() * Math.PI * 2);
    const speed = 1.5 + Math.random() * 3;
    particles.push({
      x: sx, y: sy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0,
      decay: 0.035 + Math.random() * 0.04,
      r: 2 + Math.random() * 3,
      color,
    });
  }
}

function updateParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy;
    p.vy += 0.06;
    p.life -= p.decay;
    if (p.life <= 0) particles.splice(i, 1);
  }
}

function drawParticles() {
  for (const p of particles) {
    ctx.save();
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color; ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ── Wave ripples ──────────────────────────────────────────────────────────────
const ripples = [];

function spawnRipple(sx, sy, color) {
  ripples.push({ x: sx, y: sy, r: 0, maxR: zoom * 2.5, life: 1.0, color });
}

function updateRipples() {
  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i];
    r.r += 1.8; r.life -= 0.055;
    if (r.life <= 0) ripples.splice(i, 1);
  }
}

function drawRipples() {
  for (const r of ripples) {
    ctx.save();
    ctx.globalAlpha = r.life * 0.55;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = 2 * r.life;
    ctx.shadowColor = r.color; ctx.shadowBlur = 8 * r.life;
    ctx.beginPath();
    ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

// ── Explosions ────────────────────────────────────────────────────────────────
const explosions = [];

function spawnExplosion(sx, sy, color, size = 1) {
  explosions.push({ x: sx, y: sy, r: 0, maxR: zoom * 2.2 * size, life: 1.0, color, rings: 2 + Math.floor(size) });
  for (let i = 0; i < 16; i++) {
    const ang = (i / 16) * Math.PI * 2;
    const spd = (2 + Math.random() * 4) * size;
    particles.push({
      x: sx, y: sy,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd,
      life: 1.0,
      decay: 0.04 + Math.random() * 0.03,
      r: 2 + Math.random() * 3,
      color,
    });
  }
}

function updateExplosions() {
  for (let i = explosions.length - 1; i >= 0; i--) {
    const e = explosions[i];
    e.r += (e.maxR - e.r) * 0.18;
    e.life -= 0.06;
    if (e.life <= 0) explosions.splice(i, 1);
  }
}

function drawExplosions() {
  for (const e of explosions) {
    ctx.save();
    ctx.globalAlpha = e.life * 0.7;
    ctx.strokeStyle = e.color;
    ctx.lineWidth = 2.5 * e.life;
    ctx.shadowColor = e.color;
    ctx.shadowBlur = 14 * e.life;
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
    ctx.stroke();
    if (e.rings > 1) {
      ctx.globalAlpha = e.life * 0.4;
      ctx.lineWidth = 1.5 * e.life;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r * 0.55, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

// ── Border overlay ────────────────────────────────────────────────────────────
function drawBorderOverlay(sx, sy, size, borderStyle, timeSec) {
  if (!borderStyle || borderStyle === "none") return;
  const hw = size * 0.07;
  ctx.save();
  ctx.shadowBlur = 0;
  switch (borderStyle) {
    case "border_glow": {
      const pulse = Math.sin(timeSec * 2.5) * 0.5 + 0.5;
      ctx.strokeStyle = `rgba(76,201,240,${0.5 + 0.5 * pulse})`;
      ctx.lineWidth = hw * 1.5;
      ctx.shadowColor = "#4cc9f0"; ctx.shadowBlur = 8 * pulse;
      ctx.strokeRect(sx + hw, sy + hw, size - hw * 2, size - hw * 2);
      break;
    }
    case "border_fire": {
      const p = Math.sin(timeSec * 5 + sx * 0.3) * 0.5 + 0.5;
      const g = ctx.createLinearGradient(sx, sy + size, sx, sy);
      g.addColorStop(0, `rgba(255,45,0,${0.8 + 0.2 * p})`);
      g.addColorStop(0.5, `rgba(255,140,0,${0.7 + 0.2 * p})`);
      g.addColorStop(1, `rgba(255,220,0,${0.5 + 0.3 * p})`);
      ctx.strokeStyle = g;
      ctx.lineWidth = hw * 2;
      ctx.shadowColor = "#ff5000"; ctx.shadowBlur = 10;
      ctx.strokeRect(sx + hw, sy + hw, size - hw * 2, size - hw * 2);
      break;
    }
    case "border_ice": {
      ctx.strokeStyle = "rgba(160,240,255,0.8)";
      ctx.lineWidth = hw * 1.2;
      ctx.shadowColor = "#a0f0ff"; ctx.shadowBlur = 6;
      ctx.strokeRect(sx + hw, sy + hw, size - hw * 2, size - hw * 2);
      // Corner crystals
      if (size >= 12) {
        ctx.fillStyle = "rgba(200,250,255,0.9)";
        [[sx,sy],[sx+size,sy],[sx,sy+size],[sx+size,sy+size]].forEach(([cx2,cy2]) => {
          ctx.beginPath(); ctx.arc(cx2, cy2, hw * 1.5, 0, Math.PI * 2); ctx.fill();
        });
      }
      break;
    }
    case "border_neon": {
      const hue = (timeSec * 60) % 360;
      ctx.strokeStyle = `hsla(${hue},100%,65%,0.9)`;
      ctx.lineWidth = hw * 1.6;
      ctx.shadowColor = `hsl(${hue},100%,65%)`; ctx.shadowBlur = 10;
      ctx.strokeRect(sx + hw, sy + hw, size - hw * 2, size - hw * 2);
      break;
    }
    case "border_gold": {
      const g = ctx.createLinearGradient(sx, sy, sx + size, sy + size);
      g.addColorStop(0, "rgba(255,215,0,0.9)");
      g.addColorStop(0.5, "rgba(255,255,180,0.95)");
      g.addColorStop(1, "rgba(200,160,0,0.9)");
      ctx.strokeStyle = g;
      ctx.lineWidth = hw * 2;
      ctx.shadowColor = "#ffd700"; ctx.shadowBlur = 8;
      ctx.strokeRect(sx + hw, sy + hw, size - hw * 2, size - hw * 2);
      break;
    }
    case "border_plasma": {
      const p = Math.sin(timeSec * 4 + sx * 0.2 + sy * 0.2) * 0.5 + 0.5;
      const g = ctx.createLinearGradient(sx, sy, sx + size, sy + size);
      g.addColorStop(0, `rgba(191,90,242,${0.7 + 0.3 * p})`);
      g.addColorStop(1, `rgba(76,201,240,${0.7 + 0.3 * p})`);
      ctx.strokeStyle = g;
      ctx.lineWidth = hw * 1.8;
      ctx.shadowColor = "#bf5af2"; ctx.shadowBlur = 12 * p;
      ctx.strokeRect(sx + hw, sy + hw, size - hw * 2, size - hw * 2);
      break;
    }
    case "border_void": {
      ctx.strokeStyle = "rgba(20,0,40,0.95)";
      ctx.lineWidth = hw * 3;
      ctx.strokeRect(sx + hw, sy + hw, size - hw * 2, size - hw * 2);
      ctx.strokeStyle = "rgba(80,0,120,0.5)";
      ctx.lineWidth = hw;
      ctx.strokeRect(sx + hw * 2, sy + hw * 2, size - hw * 4, size - hw * 4);
      break;
    }
    case "border_rainbow": {
      const seg = 4;
      const pts = [
        [sx, sy, sx+size, sy],
        [sx+size, sy, sx+size, sy+size],
        [sx+size, sy+size, sx, sy+size],
        [sx, sy+size, sx, sy],
      ];
      pts.forEach(([x1,y1,x2,y2], i) => {
        const h = ((timeSec * 50 + i * 90) % 360);
        ctx.strokeStyle = `hsla(${h},100%,65%,0.9)`;
        ctx.lineWidth = hw * 1.6;
        ctx.shadowColor = `hsl(${h},100%,65%)`; ctx.shadowBlur = 6;
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
      });
      break;
    }
    case "border_circuit": {
      ctx.strokeStyle = "rgba(52,211,153,0.75)";
      ctx.lineWidth = hw;
      ctx.strokeRect(sx + hw, sy + hw, size - hw * 2, size - hw * 2);
      if (size >= 12) {
        ctx.fillStyle = "rgba(52,211,153,0.9)";
        const d = hw * 1.8;
        [[sx+d,sy+hw],[sx+size-d,sy+hw],[sx+hw,sy+d],[sx+hw,sy+size-d]].forEach(([cx2,cy2]) => {
          ctx.fillRect(cx2 - hw * 0.7, cy2 - hw * 0.7, hw * 1.4, hw * 1.4);
        });
      }
      break;
    }
    case "border_diamond": {
      const p = Math.sin(timeSec * 3) * 0.5 + 0.5;
      ctx.strokeStyle = `rgba(150,220,255,${0.7 + 0.3 * p})`;
      ctx.lineWidth = hw * 1.3;
      ctx.shadowColor = "#96dcff"; ctx.shadowBlur = 10 * p;
      ctx.strokeRect(sx + hw, sy + hw, size - hw * 2, size - hw * 2);
      if (size >= 14 && p > 0.8) {
        ctx.fillStyle = "rgba(220,240,255,0.95)";
        const corners = [[sx+hw,sy+hw],[sx+size-hw,sy+hw],[sx+hw,sy+size-hw],[sx+size-hw,sy+size-hw]];
        corners.forEach(([cx2,cy2]) => {
          ctx.beginPath(); ctx.arc(cx2, cy2, hw * 1.2, 0, Math.PI * 2); ctx.fill();
        });
      }
      break;
    }
    case "border_glitch": {
      const segments = 4;
      for (let i = 0; i < segments; i++) {
        const hue = (timeSec * 180 + i * 90) % 360;
        const offset = Math.sin(timeSec * 8 + i * 2) * hw;
        ctx.strokeStyle = `hsla(${hue},100%,60%,0.85)`;
        ctx.lineWidth = hw * 1.2;
        ctx.beginPath();
        if (i === 0) { ctx.moveTo(sx + offset, sy); ctx.lineTo(sx + size + offset, sy); }
        else if (i === 1) { ctx.moveTo(sx+size, sy+offset); ctx.lineTo(sx+size, sy+size+offset); }
        else if (i === 2) { ctx.moveTo(sx+size+offset, sy+size); ctx.lineTo(sx+offset, sy+size); }
        else { ctx.moveTo(sx, sy+size+offset); ctx.lineTo(sx, sy+offset); }
        ctx.stroke();
      }
      break;
    }
    case "border_aurora": {
      const h1 = (timeSec * 20) % 360, h2 = (h1 + 120) % 360;
      const g = ctx.createLinearGradient(sx, sy, sx+size, sy+size);
      g.addColorStop(0, `hsla(${h1},80%,65%,0.85)`);
      g.addColorStop(1, `hsla(${h2},80%,65%,0.85)`);
      ctx.strokeStyle = g;
      ctx.lineWidth = hw * 2;
      ctx.shadowColor = `hsl(${h1},80%,65%)`; ctx.shadowBlur = 12;
      ctx.strokeRect(sx+hw, sy+hw, size-hw*2, size-hw*2);
      break;
    }
    case "border_cosmic": {
      const p = Math.sin(timeSec * 2) * 0.5 + 0.5;
      ctx.strokeStyle = `rgba(129,140,248,${0.7 + 0.3 * p})`;
      ctx.lineWidth = hw * 2;
      ctx.shadowColor = "#818cf8"; ctx.shadowBlur = 14;
      ctx.strokeRect(sx+hw, sy+hw, size-hw*2, size-hw*2);
      if (size >= 14) {
        ctx.fillStyle = `rgba(200,210,255,${p * 0.9})`;
        ctx.beginPath(); ctx.arc(sx + size/2, sy + size/2, hw * 0.8, 0, Math.PI*2); ctx.fill();
      }
      break;
    }
    case "border_inferno": {
      const p = Math.abs(Math.sin(timeSec * 3));
      const g = ctx.createLinearGradient(sx, sy+size, sx, sy);
      g.addColorStop(0, `rgba(255,0,0,${0.8+0.2*p})`);
      g.addColorStop(0.5, `rgba(255,100,0,${0.8+0.2*p})`);
      g.addColorStop(1, `rgba(255,200,0,0.9)`);
      ctx.strokeStyle = g;
      ctx.lineWidth = hw * 2.5;
      ctx.shadowColor = "#ff4400"; ctx.shadowBlur = 16 * p;
      ctx.strokeRect(sx+hw, sy+hw, size-hw*2, size-hw*2);
      break;
    }
    default: break;
  }
  ctx.restore();
}

// ── Toast & Popup ─────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = "", duration = 1800) {
  toastEl.textContent = msg;
  toastEl.className = "show" + (type ? " toast-" + type : "");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ""; }, duration);
}

let popupQueue = [];
let popupShowing = false;

function showPopup(title, body, type = "", duration = 3200) {
  popupQueue.push({ title, body, type, duration });
  if (!popupShowing) _showNextPopup();
}

function _showNextPopup() {
  if (!popupQueue.length) { popupShowing = false; return; }
  popupShowing = true;
  const { title, body, type, duration } = popupQueue.shift();
  popupTitle.textContent = title;
  popupBody.textContent = body;
  popupEl.className = "show" + (type ? " popup-" + type : "");
  setTimeout(() => {
    popupEl.className = "";
    setTimeout(_showNextPopup, 300);
  }, duration);
}

// ── Panel ─────────────────────────────────────────────────────────────────────
function openPanel(title, contentFn) {
  panelTitle.textContent = title;
  panelBody.innerHTML = `<div style="text-align:center;padding:24px 0"><div class="spinner" style="margin:0 auto"></div></div>`;
  panel.classList.remove("hidden");
  overlay.classList.add("show");
  contentFn();
}
function closePanel() { panel.classList.add("hidden"); overlay.classList.remove("show"); }
document.getElementById("btnClose").onclick = closePanel;
overlay.onclick = closePanel;

// ── API ───────────────────────────────────────────────────────────────────────
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

// ── Canvas resize ─────────────────────────────────────────────────────────────
function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.floor(canvas.clientWidth  * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mini.width  = Math.floor(mini.clientWidth  * dpr);
  mini.height = Math.floor(mini.clientHeight * dpr);
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", () => { resize(); render(); });
resize();

// ── Geometry helpers ──────────────────────────────────────────────────────────
const key    = (x, y) => `${x},${y}`;
const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const screen2tile = (sx, sy) => ({ x: Math.floor((sx-offsetX)/zoom), y: Math.floor((sy-offsetY)/zoom) });
const tile2screen = (x, y)   => ({ sx: x*zoom+offsetX, sy: y*zoom+offsetY });

function inArena(x, y) {
  const cx = Math.floor(mapW/2), cy = Math.floor(mapH/2);
  const dx = x-cx, dy = y-cy;
  if (arenaShape === "square") return Math.abs(dx)<=arenaR && Math.abs(dy)<=arenaR;
  if (arenaShape === "star") {
    const dist = Math.sqrt(dx*dx+dy*dy);
    if (dist > arenaR) return false;
    if (dist === 0) return true;
    const angle = Math.atan2(dy, dx);
    const arm = angle % (Math.PI*2/6);
    const factor = Math.cos(Math.PI/6) / Math.max(1e-9, Math.cos(arm - Math.PI/6));
    return dist <= arenaR * factor;
  }
  return dx*dx+dy*dy <= arenaR*arenaR;
}

function viewportTiles() {
  const w = canvas.clientWidth, h = canvas.clientHeight, pad = 2;
  return {
    x0: clamp(Math.floor((-offsetX)/zoom)-pad, 0, mapW-1),
    y0: clamp(Math.floor((-offsetY)/zoom)-pad, 0, mapH-1),
    x1: clamp(Math.floor((w-offsetX)/zoom)+pad, 0, mapW-1),
    y1: clamp(Math.floor((h-offsetY)/zoom)+pad, 0, mapH-1),
  };
}

function recenter() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  offsetX = Math.floor(w/2 - me.x*zoom - zoom/2);
  offsetY = Math.floor(h/2 - me.y*zoom - zoom/2);
}
document.getElementById("btnRecenter").onclick = () => { recenter(); render(); };

// ── Style helpers ─────────────────────────────────────────────────────────────
function parseStyle(s) {
  if (!s || typeof s !== "string") return { style:"solid", color:"#44ccff" };
  const parts = s.split(":");
  let color = parts.length >= 2 ? parts[1] : s;
  if (/^#?[0-9a-fA-F]{3}$/.test(color)) {
    const h = color.replace("#","");
    color = `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(color)) color = `#${color}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = "#44ccff";
  return { style: parts.length>=2 ? parts[0] : "solid", color: color.toLowerCase() };
}

function hash2(x, y) {
  let n = x*374761393 + y*668265263;
  n = (n^(n>>13))*1274126177;
  return ((n^(n>>16))>>>0)/4294967295;
}
function shade(hex, f) {
  const h=hex.replace("#","");
  const r=Math.max(0,Math.min(255,Math.round(parseInt(h.slice(0,2),16)*f)));
  const g=Math.max(0,Math.min(255,Math.round(parseInt(h.slice(2,4),16)*f)));
  const b=Math.max(0,Math.min(255,Math.round(parseInt(h.slice(4,6),16)*f)));
  return `#${r.toString(16).padStart(2,"0")}${g.toString(16).padStart(2,"0")}${b.toString(16).padStart(2,"0")}`;
}
function lerp(a,b,t){return a+(b-a)*t;}
function mix(c1,c2,t){
  const h1=c1.replace("#",""),h2=c2.replace("#","");
  return `#${Math.round(lerp(parseInt(h1.slice(0,2),16),parseInt(h2.slice(0,2),16),t)).toString(16).padStart(2,"0")}${Math.round(lerp(parseInt(h1.slice(2,4),16),parseInt(h2.slice(2,4),16),t)).toString(16).padStart(2,"0")}${Math.round(lerp(parseInt(h1.slice(4,6),16),parseInt(h2.slice(4,6),16),t)).toString(16).padStart(2,"0")}`;
}
function hsvToHex(h,s,v){
  const i=Math.floor(h*6),f=h*6-i,p=v*(1-s),q=v*(1-f*s),t2=v*(1-(1-f)*s);
  let r,g,b;
  switch(i%6){case 0:r=v;g=t2;b=p;break;case 1:r=q;g=v;b=p;break;case 2:r=p;g=v;b=t2;break;
    case 3:r=p;g=q;b=v;break;case 4:r=t2;g=p;b=v;break;default:r=v;g=p;b=q;}
  return `#${Math.max(0,Math.min(255,Math.round(r*255))).toString(16).padStart(2,"0")}${Math.max(0,Math.min(255,Math.round(g*255))).toString(16).padStart(2,"0")}${Math.max(0,Math.min(255,Math.round(b*255))).toString(16).padStart(2,"0")}`;
}

function tileZone(tx, ty) {
  const cx = mapW / 2, cy = mapH / 2;
  const d = Math.hypot(tx - cx, ty - cy);
  const pct = arenaR > 0 ? d / arenaR : 1;
  if (pct > zoneThresholds[0]) return 1;
  if (pct > zoneThresholds[1]) return 2;
  if (pct > zoneThresholds[2]) return 3;
  if (pct > zoneThresholds[3]) return 4;
  return 5;
}

function drawZoneRings() {
  if (arenaShape !== "circle") return;
  const cx = mapW / 2, cy = mapH / 2;
  const { sx: scx, sy: scy } = tile2screen(cx, cy);
  ctx.save();
  ctx.setLineDash([4, 6]);
  ctx.lineWidth = 1;
  // Draw from innermost to outermost (skip zone 1 border = arena edge)
  for (let i = 0; i < zoneThresholds.length; i++) {
    const frac = zoneThresholds[i];
    const pxR = frac * arenaR * zoom;
    ctx.strokeStyle = ZONE_COLORS[i] + "55"; // semi-transparent
    ctx.beginPath();
    ctx.arc(scx + zoom * 0.5, scy + zoom * 0.5, pxR, 0, Math.PI * 2);
    ctx.stroke();
    // Label on the ring
    if (zoom >= 8) {
      ctx.setLineDash([]);
      ctx.font = `bold ${Math.max(9, zoom * 0.55)}px ui-sans-serif,system-ui,sans-serif`;
      ctx.fillStyle = ZONE_COLORS[i] + "cc";
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,0.9)"; ctx.shadowBlur = 4;
      ctx.fillText(ZONE_LABELS[i], scx + zoom * 0.5, scy + zoom * 0.5 - pxR - 4);
      ctx.setLineDash([4, 6]);
    }
  }
  ctx.setLineDash([]);
  ctx.restore();
}

function drawZoneTint(sx, sy, size, tx, ty) {
  const z = tileZone(tx, ty);
  if (z === 1) return;
  const alpha = [0, 0, 0.06, 0.10, 0.14, 0.18][z];
  ctx.fillStyle = ZONE_COLORS[z - 1] + Math.round(alpha * 255).toString(16).padStart(2,"0");
  ctx.fillRect(sx, sy, size, size);
}

function drawStyledTile(sx, sy, size, styleStr, x, y, timeSec) {
  const { style, color } = parseStyle(styleStr);
  switch (style) {
    case "gradient": {
      const g=ctx.createLinearGradient(sx,sy,sx+size,sy+size);
      g.addColorStop(0,color);g.addColorStop(1,shade(color,.55));
      ctx.fillStyle=g;ctx.fillRect(sx,sy,size,size);return;
    }
    case "marble": {
      const n=hash2(x,y),v=Math.abs(Math.sin((x*.9+y*.7)+n*6));
      ctx.fillStyle=shade(color,.55+v*.65);ctx.fillRect(sx,sy,size,size);
      if(size>=10){ctx.strokeStyle="rgba(255,255,255,0.10)";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(sx+n*size,sy);ctx.lineTo(sx+size,sy+n*size);ctx.stroke();}return;
    }
    case "magma":case "magma_sparks": {
      const n=hash2(x,y),pulse=Math.sin(timeSec*1.8+n*4)*.5+.5;
      const g=ctx.createRadialGradient(sx+size*.5,sy+size*.5,size*.1,sx+size*.5,sy+size*.5,size*.75);
      g.addColorStop(0,shade(mix("#ffd44a","#ffffff",.3),.9+.4*pulse));g.addColorStop(1,shade(color,.7));
      ctx.fillStyle=g;ctx.fillRect(sx,sy,size,size);
      if(size>=10){ctx.strokeStyle="rgba(0,0,0,0.35)";ctx.strokeRect(sx+.5,sy+.5,size-1,size-1);}
      if(style==="magma_sparks"&&size>=10&&hash2(x+Math.floor(timeSec*3),y+19)>.99){
        ctx.fillStyle="rgba(255,245,200,0.95)";ctx.fillRect(sx+size*(hash2(x,y)*.7+.15),sy+size*(hash2(y,x)*.7+.15),2,2);}return;
    }
    case "rainbow_shift": {
      ctx.fillStyle=hsvToHex((timeSec*.08+(x*.02)+(y*.015))%1,.9,.95);ctx.fillRect(sx,sy,size,size);return;
    }
    case "neon_pulse": {
      const phase=Math.sin(timeSec*4+(x+y)*.35)*.5+.5;
      ctx.fillStyle=shade(color,.9+.4*phase);ctx.fillRect(sx,sy,size,size);
      if(size>=10){ctx.strokeStyle=`rgba(255,255,255,${.25+.35*phase})`;ctx.lineWidth=1.5;ctx.strokeRect(sx+.5,sy+.5,size-1,size-1);}return;
    }
    case "ice": {
      const g=ctx.createLinearGradient(sx,sy,sx+size,sy+size);
      g.addColorStop(0,mix("#a5f3fc",color,.35));g.addColorStop(1,mix("#60a5fa",color,.55));
      ctx.fillStyle=g;ctx.fillRect(sx,sy,size,size);return;
    }
    case "crystal": {
      const g=ctx.createLinearGradient(sx,sy+size,sx+size,sy);
      g.addColorStop(0,mix(color,"#ffffff",.2));g.addColorStop(1,mix(color,"#22d3ee",.35));
      ctx.fillStyle=g;ctx.fillRect(sx,sy,size,size);
      if(size>=10){const n=hash2(x,y);ctx.fillStyle=`rgba(255,255,255,${.15+.25*n})`;
        ctx.beginPath();ctx.moveTo(sx+size*.15,sy+size*.85);ctx.lineTo(sx+size*.55,sy+size*.25);ctx.lineTo(sx+size*.85,sy+size*.65);ctx.closePath();ctx.fill();}return;
    }
    case "aurora": {
      const n=hash2(x,y);
      const g=ctx.createLinearGradient(sx,sy+size,sx+size,sy);
      g.addColorStop(0,mix(hsvToHex((timeSec*.03+n)%1,.75,.95),color,.35));
      g.addColorStop(1,mix(hsvToHex((timeSec*.03+n+.18)%1,.75,.75),color,.35));
      ctx.fillStyle=g;ctx.fillRect(sx,sy,size,size);return;
    }
    case "galaxy": {
      const n=hash2(x,y);
      ctx.fillStyle=mix("#020617",color,.18);ctx.fillRect(sx,sy,size,size);
      if(size>=10){const s1=hash2(x*7+11,y*13+3);
        if(s1>.97){ctx.fillStyle="rgba(255,255,255,0.95)";ctx.fillRect(sx+size*(hash2(x,y)*.8+.1),sy+size*(hash2(y,x)*.8+.1),1+(s1-.97)*6,1+(s1-.97)*6);}
        const glow=Math.max(0,Math.sin(timeSec*.4+x*.12+y*.07)*.5+.5);
        ctx.fillStyle=`rgba(129,140,248,${.04+.10*glow*n})`;ctx.fillRect(sx,sy,size,size);}return;
    }
    case "glitch": {
      ctx.fillStyle="#020617";ctx.fillRect(sx,sy,size,size);
      if(size>=6){const pal=["rgba(255,45,85,0.9)","rgba(0,122,255,0.9)","rgba(52,199,89,0.9)","rgba(191,90,242,0.9)"];
        for(let i=0;i<4;i++){const r=hash2(x*13+i*7,y*17+i*3);const pw=(.2+r*.6)*size,ph=(.1+hash2(x+i,y+i)*.3)*size;
          ctx.fillStyle=pal[i%4];ctx.fillRect(sx+hash2(x+i*31,y)*(size-pw),sy+hash2(x,y+i*19)*(size-ph),pw,ph);}}return;
    }
    case "carbon": {
      const n=((x+y)&1)?.15:0;ctx.fillStyle=mix("#0b0f17",color,.25+n);ctx.fillRect(sx,sy,size,size);
      if(size>=10){ctx.strokeStyle="rgba(255,255,255,0.06)";ctx.strokeRect(sx+.5,sy+.5,size-1,size-1);}return;
    }
    default: {
      const n=hash2(x,y),f=.90+n*.16;ctx.fillStyle=shade(color,f);ctx.fillRect(sx,sy,size,size);
    }
  }
}

// ── Defense overlay ───────────────────────────────────────────────────────────
function drawDefenseOverlay(sx, sy, size, defense) {
  if (!defense || defense <= 0) return;
  const alpha = 0.12 + defense * 0.1;
  const colors = ["","rgba(251,191,36,1)","rgba(234,179,8,1)","rgba(245,158,11,1)"];
  ctx.save();
  ctx.strokeStyle = colors[defense] || "rgba(251,191,36,1)";
  ctx.globalAlpha = alpha + 0.2;
  ctx.lineWidth = Math.max(1, size * 0.06);
  ctx.strokeRect(sx + ctx.lineWidth/2, sy + ctx.lineWidth/2, size - ctx.lineWidth, size - ctx.lineWidth);
  ctx.restore();
  // Shield icon at high zoom
  if (size >= 16 && defense >= 2) {
    ctx.save();
    ctx.font = `${Math.max(8, size*0.4)}px serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.globalAlpha = 0.7;
    ctx.fillText(defense === 3 ? "🛡" : "🔰", sx + size/2, sy + size/2);
    ctx.restore();
  }
}

// ── Event tiles ───────────────────────────────────────────────────────────────
function drawEventOverlay(sx, sy, size, timeSec) {
  const pulse = Math.sin(timeSec * 4) * 0.5 + 0.5;
  ctx.save();
  ctx.strokeStyle = `rgba(251,191,36,${0.5 + 0.5 * pulse})`;
  ctx.lineWidth = 2;
  ctx.shadowColor = "#fbbf24"; ctx.shadowBlur = 10 * pulse;
  ctx.strokeRect(sx + 1, sy + 1, size - 2, size - 2);
  ctx.restore();
  if (size >= 14) {
    ctx.save();
    ctx.font = `${Math.max(8, size * 0.45)}px serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.globalAlpha = 0.9;
    ctx.fillText("⚡", sx + size/2, sy + size/2);
    ctx.restore();
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(timeNow = performance.now()) {
  const timeSec = (timeNow - t0) / 1000;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#060912"; ctx.fillRect(0, 0, w, h);

  const { x0, y0, x1, y1 } = viewportTiles();
  const cx = Math.floor(mapW/2), cy = Math.floor(mapH/2);
  const { sx: acx, sy: acy } = tile2screen(cx, cy);
  const arPx = arenaR * zoom;

  // Arena bg glow
  const grd = ctx.createRadialGradient(acx, acy, 0, acx, acy, arPx);
  grd.addColorStop(0, "rgba(76,201,240,0.03)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grd;
  ctx.beginPath(); ctx.arc(acx, acy, arPx, 0, Math.PI*2); ctx.fill();

  // Zone rings
  drawZoneRings();

  // Build event set for fast lookup
  const eventSet = new Set(activeEvents.map(e => key(e.x, e.y)));

  // Tiles
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!inArena(x, y)) continue;
      const it = tiles.get(key(x, y));
      const { sx, sy } = tile2screen(x, y);
      if (it) {
        drawStyledTile(sx, sy, zoom, it.c || "#44ccff", x, y, timeSec);
        drawDefenseOverlay(sx, sy, zoom, it.d);
        // Zone-aware attack progress bar
        if (it.h > 0) {
          const z = it.z || tileZone(x, y);
          const zh = zoneHardness[z] || 1;
          const totalNeeded = zh + (it.d || 0);
          const frac = Math.min(1, it.h / totalNeeded);
          const bh = Math.max(2, zoom * 0.14);
          ctx.save();
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = "#1a0000";
          ctx.fillRect(sx, sy + zoom - bh, zoom, bh);
          // Color transitions green→yellow→red based on progress
          const hue = Math.round((1 - frac) * 120);
          ctx.fillStyle = `hsl(${hue},90%,55%)`;
          ctx.fillRect(sx, sy + zoom - bh, zoom * frac, bh);
          // Remaining hits label
          if (zoom >= 14) {
            const left = totalNeeded - it.h;
            ctx.font = `bold ${Math.max(7, zoom * 0.4)}px ui-sans-serif`;
            ctx.fillStyle = "#fff";
            ctx.textAlign = "center";
            ctx.shadowColor = "rgba(0,0,0,0.9)"; ctx.shadowBlur = 3;
            ctx.fillText(`${it.h}/${totalNeeded}`, sx + zoom * 0.5, sy + zoom - bh - 2);
          }
          ctx.restore();
          // Crack lines on heavily hit tiles
          if (zoom >= 10) {
            ctx.save();
            ctx.globalAlpha = 0.15 + frac * 0.4;
            ctx.strokeStyle = "#ff4422";
            ctx.lineWidth = 0.8;
            const cxc = sx + zoom * 0.5, cyc = sy + zoom * 0.5;
            for (let ci = 0; ci < Math.min(it.h, 6); ci++) {
              const ang = (ci / Math.max(1, Math.min(it.h, 6))) * Math.PI + 0.4;
              ctx.beginPath(); ctx.moveTo(cxc, cyc);
              ctx.lineTo(cxc + Math.cos(ang)*zoom*0.55, cyc + Math.sin(ang)*zoom*0.55);
              ctx.stroke();
            }
            ctx.restore();
          }
        }
        // Border
        const brd = borders[String(it.o)];
        if (brd && brd !== "none") drawBorderOverlay(sx, sy, zoom, brd, timeSec);
      } else {
        // Empty tile with zone tint
        ctx.fillStyle = (x+y)%23===0 ? "#0a1422" : "#080d18";
        ctx.fillRect(sx, sy, zoom, zoom);
        drawZoneTint(sx, sy, zoom, x, y);

        // Pending painting progress on this empty tile
        const pend = pendingTiles.get(key(x, y));
        if (pend) {
          const zh = zoneHardness[pend.z || tileZone(x, y)] || 1;
          const frac = pend.h / zh;
          // Semi-transparent fill showing painting progress
          ctx.save();
          ctx.globalAlpha = 0.25 + frac * 0.35;
          ctx.fillStyle = pend.u === me.id ? "#4cc9f0" : "#f97316";
          ctx.fillRect(sx, sy, zoom, zoom);
          ctx.globalAlpha = 1;
          // Progress bar at bottom
          const bh = Math.max(2, zoom * 0.14);
          ctx.fillStyle = "#0a1422";
          ctx.fillRect(sx, sy + zoom - bh, zoom, bh);
          const hue = Math.round((1 - frac) * 120);
          ctx.fillStyle = `hsl(${hue},90%,55%)`;
          ctx.fillRect(sx, sy + zoom - bh, zoom * frac, bh);
          if (zoom >= 14) {
            ctx.font = `bold ${Math.max(7, zoom*0.4)}px ui-sans-serif`;
            ctx.fillStyle = "#fff"; ctx.textAlign = "center";
            ctx.shadowColor = "rgba(0,0,0,0.9)"; ctx.shadowBlur = 3;
            ctx.fillText(`${pend.h}/${zh}`, sx + zoom*0.5, sy + zoom - bh - 2);
          }
          ctx.restore();
        } else if (zoom >= 18) {
          // Zone multiplier label on truly empty tiles when zoomed in
          const z = tileZone(x, y);
          if (z > 1) {
            ctx.save();
            ctx.font = `${Math.round(zoom * 0.35)}px ui-sans-serif`;
            ctx.fillStyle = ZONE_COLORS[z-1] + "88";
            ctx.textAlign = "center";
            ctx.fillText(ZONE_LABELS[z-1], sx + zoom*0.5, sy + zoom*0.62);
            ctx.restore();
          }
        }
      }
      if (eventSet.has(key(x, y))) drawEventOverlay(sx, sy, zoom, timeSec);
    }
  }

  // Grid at high zoom
  if (zoom >= 16) {
    ctx.strokeStyle = "rgba(76,201,240,0.04)"; ctx.lineWidth = 0.5;
    for (let x = x0; x <= x1+1; x++) {
      const { sx } = tile2screen(x, y0);
      ctx.beginPath(); ctx.moveTo(sx, tile2screen(x,y0).sy); ctx.lineTo(sx, tile2screen(x,y1+1).sy); ctx.stroke();
    }
    for (let y = y0; y <= y1+1; y++) {
      const { sy } = tile2screen(x0, y);
      ctx.beginPath(); ctx.moveTo(tile2screen(x0,y).sx, sy); ctx.lineTo(tile2screen(x1+1,y).sx, sy); ctx.stroke();
    }
  }

  // Arena border
  ctx.save();
  if (arenaShape === "circle") {
    ctx.beginPath(); ctx.arc(acx, acy, arPx, 0, Math.PI*2);
  } else if (arenaShape === "square") {
    const { sx: ax0, sy: ay0 } = tile2screen(cx-arenaR, cy-arenaR);
    ctx.beginPath(); ctx.rect(ax0, ay0, arenaR*2*zoom, arenaR*2*zoom);
  } else {
    ctx.beginPath(); ctx.arc(acx, acy, arPx, 0, Math.PI*2);
  }
  ctx.strokeStyle = "rgba(76,201,240,0.3)"; ctx.lineWidth = 2;
  ctx.setLineDash([8,6]); ctx.stroke(); ctx.setLineDash([]);
  ctx.restore();

  // Ripples, particles & explosions
  updateRipples(); drawRipples();
  updateParticles(); drawParticles();
  updateExplosions(); drawExplosions();

  // Other players
  for (const [id, pl] of players.entries()) {
    if (id === me.id) continue;
    const ps = tile2screen(pl.x, pl.y);
    const { color } = parseStyle(pl.style);
    const r = Math.max(4, zoom * 0.3);
    ctx.save();
    // VIP glow
    if (pl.vip >= 3) { ctx.shadowColor = "#ffd700"; ctx.shadowBlur = zoom >= 10 ? 14 : 0; }
    else if (pl.vip >= 1) { ctx.shadowColor = color; ctx.shadowBlur = zoom >= 10 ? 8 : 0; }
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(ps.sx+zoom*.5, ps.sy+zoom*.5, r, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.4)"; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();

    if (zoom >= 14) {
      ctx.save();
      ctx.font = `bold ${Math.max(9, zoom*0.55)}px ui-sans-serif,system-ui,sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,0.8)"; ctx.shadowBlur = 4;
      const vipBadge = pl.vip===3?"👑" : pl.vip===2?"🥈" : pl.vip===1?"🥉":"";
      ctx.fillText((pl.name||"?").slice(0,12) + (vipBadge?" "+vipBadge:""), ps.sx+zoom*.5, ps.sy-4);
      ctx.restore();
    }
  }

  // My player
  const p = tile2screen(me.x, me.y);
  const pulse = Math.sin(timeSec*3.5)*0.3+0.7;
  ctx.save();
  ctx.shadowColor = "#4cc9f0"; ctx.shadowBlur = 16*pulse;
  ctx.strokeStyle = "#4cc9f0"; ctx.lineWidth = 2;
  ctx.strokeRect(p.sx+1, p.sy+1, zoom-2, zoom-2);
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#ffffff";
  const inner = zoom*0.3;
  ctx.fillRect(p.sx+(zoom-inner)*.5, p.sy+(zoom-inner)*.5, inner, inner);
  ctx.restore();
}

// ── Minimap ───────────────────────────────────────────────────────────────────
async function fetchMinimap() {
  const data = await apiGet("/api/game/minimap");
  mapW = data.map.w; mapH = data.map.h;
  const w = mini.clientWidth, h = mini.clientHeight;
  const cw = w/mapW, ch = h/mapH;
  mctx.clearRect(0, 0, w, h);
  mctx.fillStyle = "rgba(6,9,18,0.9)"; mctx.fillRect(0, 0, w, h);
  const mcx = (mapW/2)*cw, mcy = (mapH/2)*ch;
  mctx.strokeStyle = "rgba(76,201,240,0.25)"; mctx.lineWidth = 1;
  mctx.beginPath(); mctx.arc(mcx, mcy, (Math.min(mapW,mapH)/2-1)*cw, 0, Math.PI*2); mctx.stroke();
  for (const t of data.tiles) {
    if (!inArena(t.x, t.y)) continue;
    const { color } = parseStyle(t.c);
    mctx.fillStyle = color;
    mctx.fillRect(t.x*cw, t.y*ch, Math.max(1,cw), Math.max(1,ch));
  }
  for (const p of data.players) {
    if (!inArena(p.x, p.y)) continue;
    const { color } = parseStyle(p.style);
    mctx.fillStyle = color;
    mctx.fillRect(p.x*cw, p.y*ch, Math.max(2,cw), Math.max(2,ch));
  }
  mctx.fillStyle = "#ffffff";
  mctx.fillRect(data.me.x*cw-1, data.me.y*ch-1, Math.max(3,cw)+2, Math.max(3,ch)+2);
  const vp = viewportTiles();
  mctx.strokeStyle = "rgba(76,201,240,0.5)"; mctx.lineWidth = 1;
  mctx.strokeRect(vp.x0*cw, vp.y0*ch, (vp.x1-vp.x0)*cw, (vp.y1-vp.y0)*ch);
}

// ── State ─────────────────────────────────────────────────────────────────────
let lastStateFetch = 0;
async function fetchState() {
  const t = Date.now();
  if (t - lastStateFetch < 200) return;
  lastStateFetch = t;
  const { x0,y0,x1,y1 } = viewportTiles();
  const data = await apiGet(`/api/game/state?x0=${x0}&y0=${y0}&x1=${x1}&y1=${y1}`);
  mapW = data.map.w; mapH = data.map.h;
  arenaR = data.map.r || arenaR;
  arenaShape = data.map.shape || "circle";
  if (data.map.zone_thresholds) zoneThresholds = data.map.zone_thresholds;
  if (data.map.zone_hardness) {
    // JSON converts int keys to strings — normalize back to numbers
    const zh = data.map.zone_hardness;
    zoneHardness = {};
    for (const k of Object.keys(zh)) zoneHardness[Number(k)] = zh[k];
  }
  me = { x: data.me.x, y: data.me.y, id: data.me.id };
  for (const it of data.tiles) tiles.set(key(it.x,it.y), {c:it.c, o:it.o, d:it.d||0, h:it.h||0});
  players.clear();
  for (const pl of (data.players||[])) players.set(pl.id, pl);
  activeEvents = data.events || [];
  if (data.borders) borders = data.borders;
  pendingTiles.clear();
  for (const p of (data.pending || [])) pendingTiles.set(key(p.x, p.y), p);
}

function updateStats(d) {
  if (d) { coins = d.coins; score = d.score; if (d.pos) me = {...d.pos, id: me.id}; }
  const vipLabel = meData.vip_level >= 3 ? " 👑" : meData.vip_level >= 2 ? " 🥈" : meData.vip_level >= 1 ? " 🥉" : "";
  statsEl.innerHTML = `<span style="color:#4cc9f0">⬡ ${coins}</span> &nbsp; <span style="color:#a78bfa">★ ${score}</span>${vipLabel}`;
}

// ── Input: drag ───────────────────────────────────────────────────────────────
canvas.addEventListener("mousedown", e => { dragging=true; dragMoved=false; lastMouse=dragStart={x:e.clientX,y:e.clientY}; });
window.addEventListener("mouseup", () => { dragging=false; if(dragMoved) suppressClickUntil=performance.now()+250; });
window.addEventListener("mousemove", e => {
  if(!dragging) return;
  const dx=e.clientX-lastMouse.x, dy=e.clientY-lastMouse.y; lastMouse={x:e.clientX,y:e.clientY};
  if((e.clientX-dragStart.x)**2+(e.clientY-dragStart.y)**2>36) dragMoved=true;
  offsetX+=dx; offsetY+=dy;
  fetchState().then(render).catch(()=>render());
});
canvas.addEventListener("touchstart", e => {
  if(e.touches.length===1){const t=e.touches[0];dragging=true;dragMoved=false;lastMouse=dragStart={x:t.clientX,y:t.clientY};}
},{passive:true});
window.addEventListener("touchend", ()=>{dragging=false;if(dragMoved)suppressClickUntil=performance.now()+250;});
window.addEventListener("touchmove", e=>{
  if(!dragging||e.touches.length!==1)return;
  const t=e.touches[0];const dx=t.clientX-lastMouse.x,dy=t.clientY-lastMouse.y;lastMouse={x:t.clientX,y:t.clientY};
  if((t.clientX-dragStart.x)**2+(t.clientY-dragStart.y)**2>36)dragMoved=true;
  offsetX+=dx;offsetY+=dy;fetchState().then(render).catch(()=>render());
},{passive:true});
canvas.addEventListener("wheel", e => {
  e.preventDefault(); suppressClickUntil=performance.now()+200;
  const oldZ=zoom; zoom=clamp(zoom+(Math.sign(e.deltaY)>0?-1:1),5,36);
  const rect=canvas.getBoundingClientRect();const mx=e.clientX-rect.left,my=e.clientY-rect.top;
  offsetX=mx-((mx-offsetX)/oldZ)*zoom; offsetY=my-((my-offsetY)/oldZ)*zoom;
  fetchState().then(render).catch(render);
},{passive:false});

// ── Input: click → paint ──────────────────────────────────────────────────────
canvas.addEventListener("click", async e => {
  if(dragging||actionInFlight||performance.now()<suppressClickUntil) return;
  const rect=canvas.getBoundingClientRect();
  const t=screen2tile(e.clientX-rect.left,e.clientY-rect.top);
  if(!inArena(t.x,t.y)){showToast("вне арены","error");return;}
  let sx=clamp(t.x-me.x,-1,1), sy=clamp(t.y-me.y,-1,1);
  if(Math.abs(sx)+Math.abs(sy)===0) return;
  if(Math.abs(sx)+Math.abs(sy)===2){if(Math.abs(t.x-me.x)>=Math.abs(t.y-me.y))sy=0;else sx=0;}
  const nx=clamp(me.x+sx,0,mapW-1), ny=clamp(me.y+sy,0,mapH-1);

  // ── Zone lock: if user has an in-progress painting, restrict movement ──────
  // Find any pending tile owned by this player
  let myPending = null;
  for (const [k, p] of pendingTiles) {
    if (p.u === me.id) { myPending = { ...p, key: k }; break; }
  }
  if (myPending) {
    const [px, py] = myPending.key.split(",").map(Number);
    const targetKey = key(nx, ny);
    const isThePendingTile = (nx === px && ny === py);
    const targetTile = tiles.get(targetKey);
    const isOwnTile = targetTile && targetTile.o === me.id;
    if (!isThePendingTile && !isOwnTile) {
      const zh = zoneHardness[myPending.z || tileZone(px, py)] || 1;
      showToast(`⛔ Заверши закраску ${myPending.h}/${zh}!`, "error");
      tg?.HapticFeedback?.notificationOccurred?.("warning");
      return;
    }
  }
  try {
    actionInFlight=true;
    const resp=await apiPost("/api/game/paint",{x:nx,y:ny,color:"#44ccff"});
    me={...resp.pos, id:me.id};
    coins=resp.coins; score=resp.score;
    const res=resp.result||{};

    // Particle & ripple
    const tileColor=(tiles.get(key(nx,ny))?.c)||"#44ccff";
    const { color: tc }=parseStyle(tileColor);
    const { sx: psx, sy: psy }=tile2screen(nx, ny);
    const cx2=psx+zoom/2, cy2=psy+zoom/2;

    if(res.painting) {
      // Empty tile in hard zone — needs more clicks
      const zh = res.max_defense || res.zone_h || 1;
      const hits = res.attack_hits || 1;
      // Update local pending map immediately (don't wait for fetchState)
      pendingTiles.set(key(nx, ny), { h: hits, u: me.id, z: res.zone || tileZone(nx, ny) });
      tg?.HapticFeedback?.impactOccurred?.("light");
      const zCol = res.zone > 1 ? ["","","🔵","🟡","🟠","🔴"][res.zone]||"🔴" : "⬡";
      showToast(`${zCol} Закраска ${hits}/${zh}`, "");
    } else if(res.new) {
      // Tile fully claimed — clear pending if any
      pendingTiles.delete(key(nx, ny));
      spawnParticles(cx2,cy2,tc,12);
      spawnRipple(cx2,cy2,tc);
      if(res.captured_from) {
        spawnExplosion(cx2, cy2, tc, 1.2);
        tg?.HapticFeedback?.impactOccurred?.("medium");
      }
    } else if(res.defended) {
      spawnParticles(cx2,cy2,"#ff3b30",8);
      spawnExplosion(cx2, cy2, "#ff3b30", 0.7);
      spawnRipple(cx2,cy2,"#fbbf24");
      tg?.HapticFeedback?.impactOccurred?.("light");
      const maxDef = (res.defense_left||0) + 1 + (res.attack_hits||0);
      showToast(`⚔️ Удар! Защита ${res.defense_left}/${maxDef}`,"");
    } else {
      spawnRipple(cx2,cy2,tc);
    }

    if(res.loot) showToast("📦 Лут!","loot");
    if(res.leveled) showToast(`⭐ Уровень ${res.level}!`,"level");
    if(res.zone && res.zone > 1) {
      const zLabel = ["","","×2","×4","×8","×15"][res.zone]||"";
      showToast(`${ZONE_COLORS[res.zone-1]?'':''}⬡ +${res.coins} ${zLabel}зона ${res.zone}`,"loot");
    }
    if(res.event_mult && res.event_mult>1) {
      showToast(`⚡ x${res.event_mult} ИВЕНТ!`,"loot");
      showPopup(`⚡ Мини-событие x${res.event_mult}!`,`+${res.coins} монет!`,"event",2500);
    }
    if(res.streak_popup) {
      tg?.HapticFeedback?.notificationOccurred?.("success");
      showPopup("⚔️ Серия захватов!", res.streak_popup, "streak", 3000);
    } else if(res.streak >= 3) {
      showToast(`⚔️ Серия ×${res.streak}`, "loot");
    }
    if(res.streak_mult > 1) {
      // Update tile color slightly in UI
    }

    // Achievements
    for(const ach of (res.new_achievements||[])) {
      showPopup(`${ach.icon} ${ach.title}`,`${ach.desc} · +${ach.reward_coins} монет`,"ach",3500);
    }
    // Daily quests
    for(const q of (res.completed_quests||[])) {
      showPopup(`📋 Задание!`,`${q.icon} ${q.desc}`,"quest",2800);
    }
    // VIP upgrade
    if(resp.vip_level > (meData.vip_level||0)) {
      const names={1:"🥉 Bronze VIP",2:"🥈 Silver VIP",3:"🥇 Gold VIP"};
      showPopup(`${names[resp.vip_level]}`,`Новые привилегии активированы!`,"vip",4000);
      meData.vip_level=resp.vip_level;
    }

    updateStats();
    await fetchState(); render();
  } catch(err) {
    const msg=(err?.message)||"";
    if(msg.includes("paint_cooldown")){
      try{const m=await apiPost("/api/game/move",{dx:sx,dy:sy});me={...m.pos,id:me.id};updateStats();await fetchState();render();return;}catch{}
    }
    if(msg.includes("move_cooldown")) showToast("⏱ кулдаун","error");
    else if(msg.includes("rate_limited")) showToast("⛔ Слишком быстро!","error");
    else if(msg.includes("out_of_arena")) showToast("за пределами","error");
    else if(msg.includes("too_far")) showToast("далеко","error");
    updateStats();
  } finally { actionInFlight=false; }
});

// ── VIP helpers ────────────────────────────────────────────────────────────────
const VIP_NAMES = {0:"",1:"🥉 Bronze",2:"🥈 Silver",3:"🥇 Gold"};
function vipBadgeHtml(vip) {
  if(!vip) return "";
  return `<span class="vip-badge vip-${vip}">${VIP_NAMES[vip]}</span>`;
}

// ── Profile panel ─────────────────────────────────────────────────────────────
document.getElementById("btnProfile").onclick = () => openPanel("👤 Профиль", async () => {
  const prof = await apiGet("/api/profile");
  const m = prof.me; meData = m;
  const inv = prof.inventory || [];
  const xpPct = Math.min(100, Math.round((m.xp % 25)/25*100));
  const letter = (m.display_name||"P")[0].toUpperCase();
  const avColor = m.base_color || "#44ccff";
  panelBody.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="row">
        <div class="row-start">
          <div class="avatar" style="background:${avColor}22;border-color:${avColor}44;color:${avColor}">${letter}</div>
          <div class="col">
            <div class="bold">${m.display_name} ${vipBadgeHtml(m.vip_level)}</div>
            <div class="muted">Уровень ${m.level} · ${m.xp} XP</div>
            <div class="level-bar-wrap" style="width:120px"><div class="level-bar-fill" style="width:${xpPct}%"></div></div>
          </div>
        </div>
        <div class="col" style="text-align:right">
          <div class="gold bold">⬡ ${m.coins}</div>
          <div class="muted">★ ${m.score}</div>
          <div class="muted">🟩 ${m.tiles_painted}</div>
          ${m.total_donated_stars ? `<div class="muted">⭐ ${m.total_donated_stars} донат</div>`:""}
        </div>
      </div>
      <div class="sep"></div>
      <div class="row">
        <div class="muted small">Стиль: <span style="color:#e8eefc">${m.paint_style}</span></div>
        <div class="row-start"><div class="color-dot" style="background:${m.base_color}"></div><div class="muted small">${m.base_color}</div></div>
      </div>
      <div class="sep"></div>
      <button id="btnRespawn" class="btn" style="width:100%;padding:10px;background:rgba(76,201,240,0.12);color:#4cc9f0;border:1px solid rgba(76,201,240,0.3);border-radius:10px;font-size:13px">🔄 Сменить позицию спауна</button>
    </div>
    ${inv.length ? `<div class="bold small" style="margin-bottom:8px;color:var(--muted)">ИНВЕНТАРЬ</div><div id="invItems"></div>`
      : `<div class="card"><div class="muted" style="text-align:center;padding:8px 0">Инвентарь пуст.</div></div>`}
  `;
  panelBody.querySelector("#btnRespawn")?.addEventListener("click", async () => {
    const btn = panelBody.querySelector("#btnRespawn");
    btn.disabled = true; btn.textContent = "Перемещение...";
    try {
      const r = await apiPost("/api/game/respawn", {});
      me = { ...r.pos, id: me.id };
      recenter();
      await fetchState(); render();
      closePanel();
      showToast("🔄 Перемещён в новую точку!", "loot");
    } catch(e) {
      btn.disabled = false; btn.textContent = "🔄 Сменить позицию спауна";
      showToast("Ошибка перемещения", "error");
    }
  });

  const wrap = panelBody.querySelector("#invItems");
  if (wrap) {
    inv.forEach(it => {
      const div = document.createElement("div");
      div.className = "card";
      const isColor = it.kind === "color";
      div.innerHTML = `
        <div class="row">
          <div class="row-start">
            ${isColor ? `<div class="color-swatch" style="background:${it.payload}"></div>`
              : `<div class="style-preview" style="background:linear-gradient(135deg,#0c1220,#1a2840);font-size:9px;display:flex;align-items:center;justify-content:center;color:var(--muted)">${it.payload}</div>`}
            <div class="col"><div class="bold small">${it.title}</div></div>
          </div>
          <button class="btn btn-accent small equip-btn">Одеть</button>
        </div>`;
      div.querySelector(".equip-btn").onclick = async () => {
        try { await apiPost("/api/cosmetics/equip",{cosmetic_id:it.id}); showToast("Экипировано!"); tiles.clear(); await fetchState(); await fetchMinimap(); render(); }
        catch { showToast("Ошибка","error"); }
      };
      wrap.appendChild(div);
    });
  }
});

// ── Achievements panel ────────────────────────────────────────────────────────
document.getElementById("btnAch").onclick = () => openPanel("🏅 Достижения", async () => {
  const data = await apiGet("/api/achievements");
  const achs = data.achievements || [];
  const done = achs.filter(a=>a.completed).length;
  panelBody.innerHTML = `<div class="muted small" style="text-align:center;margin-bottom:12px">${done}/${achs.length} выполнено</div>`;
  for (const a of achs) {
    const div = document.createElement("div");
    div.className = "card";
    const pct = Math.min(100, Math.round(Math.min(a.current, a.threshold) / a.threshold * 100));
    const barColor = a.completed ? "gold" : "";
    div.innerHTML = `
      <div class="row-start">
        <div class="ach-icon ${a.completed?"ach-done":"ach-locked"}">${a.icon}</div>
        <div class="col" style="flex:1">
          <div class="row">
            <div class="bold small">${a.title}</div>
            ${a.completed ? `<span class="reward-badge">+${a.reward_coins} ⬡</span>`:`<span class="muted small">+${a.reward_coins} ⬡</span>`}
          </div>
          <div class="muted" style="font-size:11px">${a.desc}</div>
          <div class="progress-bar-wrap"><div class="progress-bar-fill ${barColor}" style="width:${pct}%"></div></div>
          <div class="muted" style="font-size:10px;margin-top:3px">${Math.min(a.current,a.threshold)} / ${a.threshold}</div>
        </div>
      </div>`;
    panelBody.appendChild(div);
  }
});

// ── Daily quests panel ────────────────────────────────────────────────────────
document.getElementById("btnDaily").onclick = () => openPanel("📋 Задания дня", async () => {
  const data = await apiGet("/api/daily");
  const quests = data.quests || [];
  panelBody.innerHTML = `<div class="muted small" style="text-align:center;margin-bottom:12px">Обновляются каждый день в 00:00 UTC</div>`;
  for (const q of quests) {
    const div = document.createElement("div");
    div.className = "quest-card" + (q.completed?" completed":"");
    const pct = Math.min(100, Math.round(q.progress / q.target * 100));
    div.innerHTML = `
      <div class="row">
        <div class="row-start" style="flex:1">
          <div style="font-size:20px">${q.icon}</div>
          <div class="col" style="flex:1">
            <div class="bold small">${q.desc}</div>
            <div class="progress-bar-wrap"><div class="progress-bar-fill${q.completed?" gold":""}" style="width:${pct}%"></div></div>
            <div class="muted" style="font-size:11px;margin-top:3px">${q.progress}/${q.target}</div>
          </div>
        </div>
        ${q.completed && !q.reward_claimed
          ? `<button class="btn btn-gold claim-btn" data-id="${q.id}">+${q.reward_coins} ⬡</button>`
          : q.reward_claimed
            ? `<span class="muted small">Получено</span>`
            : `<span class="muted small">${q.reward_coins} ⬡</span>`}
      </div>`;
    const claimBtn = div.querySelector(".claim-btn");
    if (claimBtn) claimBtn.onclick = async () => {
      try {
        const r = await apiPost("/api/daily/claim",{quest_id:q.id});
        coins = r.coins; updateStats();
        showToast(`+${q.reward_coins} монет!`,"loot");
        claimBtn.outerHTML = `<span class="muted small">Получено</span>`;
      } catch { showToast("Ошибка","error"); }
    };
    panelBody.appendChild(div);
  }
});

// ── Shop panel ────────────────────────────────────────────────────────────────
const SHOP_TABS = [{id:"boost",label:"⚡ Бусты"},{id:"style",label:"✨ Стили"},{id:"color",label:"🎨 Цвета"},{id:"border",label:"🖼 Рамки"}];

document.getElementById("btnShop").onclick = () => openPanel("🛒 Магазин", async () => {
  const cat = await apiGet("/api/shop/catalog");
  const allItems = cat.items;
  let currentTab = "boost";
  const tabsHtml = SHOP_TABS.map(c => `<button class="tab-btn${c.id===currentTab?" active":""}" data-tab="${c.id}">${c.label}</button>`).join("");
  panelBody.innerHTML = `<div class="shop-tabs">${tabsHtml}</div><div id="shopGrid"></div>`;
  function renderTab(tabId) {
    const grid = panelBody.querySelector("#shopGrid"); if(!grid) return;
    grid.innerHTML = "";
    const items = allItems.filter(i => i.kind === tabId);
    if(!items.length){grid.innerHTML=`<div class="muted" style="text-align:center;padding:16px">Пусто</div>`;return;}
    items.forEach(it => {
      const div = document.createElement("div");
      div.className = "card";
      const vipReq = it.vip_required || 0;
      const vipLabel = vipReq ? `<span class="vip-badge vip-${vipReq}">${VIP_NAMES[vipReq]}</span> ` : "";
      const priceStr = it.price===0 ? `<span class="green bold">Бесплатно</span>` : `<span class="gold">${it.price} ⬡</span>`;
      const preview = it.kind==="color"
        ? `<div class="color-swatch" style="background:${it.payload}"></div>`
        : it.kind==="style"
          ? `<div class="style-preview" style="font-size:9px;display:flex;align-items:center;justify-content:center;color:var(--muted);background:#0c1220">${it.payload}</div>`
          : it.kind==="border"
            ? `<div class="border-preview brd-${it.payload}"></div>`
            : "";
      div.innerHTML = `
        <div class="row">
          <div class="row-start">${preview}<div class="col"><div class="bold small">${vipLabel}${it.title}</div><div>${priceStr}</div></div></div>
          <button class="btn btn-accent small buy-btn">Купить</button>
        </div>`;
      div.querySelector(".buy-btn").onclick = async (ev) => {
        const btn=ev.currentTarget; btn.textContent="..."; btn.disabled=true;
        try {
          const r=await apiPost("/api/shop/buy",{item_id:it.id});
          coins=r.coins; updateStats(); btn.textContent="✓"; btn.style.color="var(--green)";
          showToast(`Куплено: ${it.title}`);
        } catch(err) {
          const msg=(err?.message)||"";
          btn.textContent="✕"; btn.style.color="var(--red)";
          if(msg.includes("vip_required")) showToast("Требуется VIP статус","error");
          else if(msg.includes("no_money")) showToast("Не хватает монет","error");
          else showToast("Ошибка","error");
          setTimeout(()=>{btn.textContent="Купить";btn.style.color="";btn.disabled=false;},1500);
        }
      };
      grid.appendChild(div);
    });
  }
  panelBody.querySelectorAll(".tab-btn").forEach(btn=>{btn.onclick=()=>{panelBody.querySelectorAll(".tab-btn").forEach(b=>b.classList.remove("active"));btn.classList.add("active");renderTab(btn.dataset.tab);}; });
  renderTab(currentTab);
});

// ── Loot panel ────────────────────────────────────────────────────────────────
document.getElementById("btnLoot").onclick = () => openPanel("📦 Лутбоксы", async () => {
  const list = await apiGet("/api/loot/list");
  if(!list.crates.length){panelBody.innerHTML=`<div class="card"><div class="muted" style="text-align:center;padding:12px 0">Ящиков нет. Крась клетки у центра!</div></div>`;return;}
  panelBody.innerHTML="";
  for(const c of list.crates){
    const div=document.createElement("div"); div.className="card";
    div.innerHTML=`<div class="row"><div class="row-start"><div class="crate-icon">${c.opened?"📂":"📦"}</div><div class="col"><div class="bold small">Ящик #${c.id}</div><div>${c.opened?`<span class="reward-badge">${c.reward_type} +${c.reward_amount}</span>`:`<span class="muted small">Закрыт</span>`}</div></div></div><button class="btn${c.opened?"":" btn-accent"} open-btn">${c.opened?"OK":"Открыть"}</button></div>`;
    const btn=div.querySelector(".open-btn"); btn.disabled=c.opened;
    btn.onclick=async()=>{btn.textContent="...";btn.disabled=true;try{const r=await apiPost(`/api/loot/open/${c.id}`,{});coins=r.coins;updateStats();const rw=r.result;div.querySelector(".col div:last-child").innerHTML=`<span class="reward-badge">${rw.reward_type} +${rw.reward_amount}</span>`;div.querySelector(".crate-icon").textContent="📂";btn.textContent="OK";showToast(`🎁 ${rw.reward_type} +${rw.reward_amount}`,"loot");}catch{btn.textContent="Ошибка";}};
    panelBody.appendChild(div);
  }
});

// ── Leaderboard panel ─────────────────────────────────────────────────────────
document.getElementById("btnTop").onclick = () => openPanel("🏆 Топ игроков", async () => {
  const data = await apiGet("/api/leaderboard");
  panelBody.innerHTML="";
  if(!data.leaderboard.length){panelBody.innerHTML=`<div class="muted" style="text-align:center;padding:16px">Пока нет игроков</div>`;return;}
  for(const p of data.leaderboard){
    const div=document.createElement("div"); div.className="card";
    const rc=p.rank<=3?`rank-${p.rank}`:"rank-n";
    const isMe=p.user_id===me.id;
    if(isMe) div.style.borderColor="rgba(76,201,240,0.4)";
    div.innerHTML=`<div class="row"><div class="row-start"><div class="rank-badge ${rc}">${p.rank}</div><div class="color-dot" style="background:${p.base_color}"></div><div class="col"><div class="bold small">${p.display_name}${isMe?" <span style='color:var(--accent);font-size:10px'>ВЫ</span>":""} ${vipBadgeHtml(p.vip_level)}</div><div class="muted" style="font-size:11px">Ур.${p.level} · 🟩${p.tiles_painted}</div></div></div><div class="bold" style="font-size:13px;color:var(--accent)">★ ${p.score}</div></div>`;
    panelBody.appendChild(div);
  }
});

// ── Donation Pool panel ───────────────────────────────────────────────────────
document.getElementById("btnPool").onclick = () => openPanel("💎 Донат-пул", async () => {
  const [pool, hist, meInfo] = await Promise.all([
    apiGet("/api/pool"),
    apiGet("/api/pool/history"),
    apiGet("/api/me"),
  ]);
  const endsDate = new Date(pool.ends_at + "Z");
  const msLeft = Math.max(0, endsDate - Date.now());
  const daysLeft = Math.floor(msLeft / 86400000);
  const h = Math.floor((msLeft % 86400000) / 3600000);
  const m2 = Math.floor((msLeft % 3600000) / 60000);
  const timeStr = daysLeft > 0 ? `${daysLeft}д ${h}ч` : `${h}ч ${m2}м`;
  const contribs = pool.contributors||[], topPl = pool.top_players||[];
  const history = hist.history||[];
  const myVip = meInfo.vip_level || 0;
  const myDonated = meInfo.total_donated_stars || 0;
  const jackpotInfo = meInfo.jackpot;

  // VIP status of current user
  const vipTier = myVip >= 3 ? "gold" : myVip >= 2 ? "silver" : myVip >= 1 ? "bronze" : "none";
  const vipLabel = {none:"",bronze:"🥉 Bronze",silver:"🥈 Silver",gold:"🥇 Gold"}[vipTier];
  const nextThreshold = myDonated < 5 ? 5 : myDonated < 25 ? 25 : myDonated < 100 ? 100 : null;
  const nextToVip = nextThreshold ? `${nextThreshold - myDonated} ⭐ до следующего VIP` : "Максимальный VIP!";

  panelBody.innerHTML = `
    <div class="pool-hero">
      <div class="pool-total" id="poolTotalEl">${pool.total_stars} ⭐</div>
      <div class="pool-label">Сезонный пул · Осталось ${timeStr}</div>
      ${vipLabel ? `<div class="pool-vip-badge vip-badge vip-${myVip}" style="margin-top:8px;display:inline-flex">${vipLabel}</div>` : ""}
    </div>
    ${jackpotInfo ? `<button id="btnClaimJackpot" class="btn btn-gold" style="width:100%;margin-bottom:12px;padding:12px;font-size:14px">🏆 Получить приз (${jackpotInfo.total_stars} ⭐)</button>` : ""}
    <div class="pool-tabs">
      <button class="tab-btn active" data-ptab="donate">💎 Донат</button>
      <button class="tab-btn" data-ptab="vip">👑 VIP</button>
      <button class="tab-btn" data-ptab="top">🏆 Топ</button>
      <button class="tab-btn" data-ptab="history">📜 История</button>
    </div>
    <div id="ptabContent"></div>`;

  // Jackpot claim button
  panelBody.querySelector("#btnClaimJackpot")?.addEventListener("click", async () => {
    try {
      const r = await apiPost("/api/pool/withdrawal", {});
      if (r.already_requested) {
        showPopup("⏳ Заявка уже подана", "Ожидайте — администратор обработает выплату.", "vip", 4000);
      } else {
        showPopup("✅ Заявка подана!", "Администратор получил уведомление и скоро переведёт Stars.", "vip", 5000);
        tg?.HapticFeedback?.notificationOccurred?.("success");
      }
    } catch(err) {
      const msg = (err?.message)||"";
      if (msg.includes("not_winner")) showToast("Ты не победитель этого раунда", "error");
      else showToast("Ошибка", "error");
    }
  });

  function renderPoolTab(tab) {
    const wrap = panelBody.querySelector("#ptabContent");
    if (!wrap) return;
    panelBody.querySelectorAll(".pool-tabs .tab-btn").forEach(b => b.classList.toggle("active", b.dataset.ptab === tab));

    if (tab === "donate") {
      wrap.innerHTML = `
        <div class="vip-progress-card">
          <div class="row" style="margin-bottom:6px">
            <div class="bold small">Мои взносы: <span class="gold">${myDonated} ⭐</span></div>
            <div class="muted small">${nextToVip}</div>
          </div>
          <div class="progress-bar-wrap">
            <div class="progress-bar-fill gold" style="width:${Math.min(100, myDonated/100*100)}%"></div>
          </div>
        </div>
        <div class="bold small" style="margin-bottom:8px;color:var(--muted)">БЫСТРЫЙ ВЗНОС В ПУЛ</div>
        <div class="donate-btns">
          ${[1,5,10,25,50,100].map(s=>`<button class="donate-amount-btn" data-stars="${s}">${s} ⭐</button>`).join("")}
        </div>
        <div id="donateMsg" style="text-align:center;min-height:18px;font-size:12px;color:var(--muted);margin-bottom:12px"></div>
        <div class="muted small" style="text-align:center;margin-bottom:14px;line-height:1.6">
          Победитель (🥇 топ-1 по очкам) забирает <b>весь пул</b>.<br>
          Чем больше взнос — тем выше VIP статус и бонусы в игре.
        </div>
        ${contribs.length ? `<div class="bold small" style="margin-bottom:8px;color:var(--muted)">ТОП ВКЛАДЧИКОВ</div><div id="contribs"></div>` : ""}`;

      wrap.querySelectorAll(".donate-amount-btn").forEach(btn => {
        btn.onclick = async () => {
          const stars = parseInt(btn.dataset.stars);
          const msgEl = wrap.querySelector("#donateMsg");
          msgEl.textContent = "Создаём счёт...";
          try {
            if (tg?.openInvoice) {
              const inv = await apiGet(`/api/pool/create_invoice?stars=${stars}`);
              msgEl.textContent = "Ожидаем оплату...";
              tg.openInvoice(inv.invoice_link, (status) => {
                if (status === "paid") {
                  msgEl.innerHTML = `<span style="color:var(--green)">✓ ${stars} ⭐ зачислено! Спасибо!</span>`;
                  setTimeout(fetchPoolTicker, 3000);
                  showToast(`+${stars} ⭐ в пул!`, "loot");
                  tg?.HapticFeedback?.notificationOccurred?.("success");
                } else {
                  msgEl.innerHTML = `<span style="color:var(--muted)">Отменено</span>`;
                }
              });
            } else {
              msgEl.innerHTML = `<span style="color:var(--muted)">Используй <b>/donate_${stars}</b> в боте</span>`;
            }
          } catch {
            msgEl.innerHTML = `<span style="color:var(--muted)">Используй <b>/donate_${stars}</b> в боте</span>`;
          }
        };
      });

      const cWrap = wrap.querySelector("#contribs");
      if (cWrap) {
        contribs.forEach((c,i) => {
          const isMe = c.user_id === meInfo.id;
          const d = document.createElement("div");
          d.className = "card" + (isMe ? " card-me" : "");
          d.innerHTML=`<div class="row"><div class="row-start"><div class="rank-badge ${i<3?`rank-${i+1}`:"rank-n"}">${i+1}</div><div class="bold small">${c.display_name}${isMe?" <span style='color:var(--accent);font-size:10px'>ВЫ</span>":""}</div></div><div class="col" style="text-align:right"><div class="gold bold">${c.stars} ⭐</div><div class="muted" style="font-size:10px">${c.pct||0}% пула</div></div></div>`;
          cWrap.appendChild(d);
        });
      }

    } else if (tab === "vip") {
      const vipData = [
        { level: 0, name: "Обычный",   icon: "👤", stars: "0",    coinMult: "×1",   range: 1, extra: "—",                         color: "var(--muted)" },
        { level: 1, name: "Bronze",    icon: "🥉", stars: "5+",   coinMult: "×1.5", range: 2, extra: "+8 монет/⭐",               color: "#cd7f32" },
        { level: 2, name: "Silver",    icon: "🥈", stars: "25+",  coinMult: "×2",   range: 2, extra: "+12 монет/⭐, VIP-стили",   color: "#c0c0c0" },
        { level: 3, name: "Gold",      icon: "🥇", stars: "100+", coinMult: "×3",   range: 3, extra: "+20 монет/⭐, VIP-рамки, спавн у центра, бейдж 👑", color: "#ffd700" },
      ];
      wrap.innerHTML = `
        <div class="muted small" style="text-align:center;margin-bottom:12px">
          Твои взносы за всё время: <b style="color:var(--gold)">${myDonated} ⭐</b>
        </div>`;
      vipData.forEach(v => {
        const isCurrent = v.level === myVip;
        const d = document.createElement("div");
        d.className = "card" + (isCurrent ? "" : "");
        d.style.cssText = isCurrent
          ? `border-color:${v.color};background:${v.color}18;`
          : "opacity:0.7;";
        d.innerHTML = `
          <div class="row">
            <div class="row-start">
              <div style="font-size:22px;width:36px;text-align:center">${v.icon}</div>
              <div class="col">
                <div class="bold small" style="color:${v.color}">${v.name} ${isCurrent?"<span style='font-size:10px;color:var(--accent)'>← ВЫ</span>":""}</div>
                <div class="muted" style="font-size:10px">${v.stars} ⭐ суммарно</div>
              </div>
            </div>
            <div class="col" style="text-align:right;gap:2px">
              <div class="bold small" style="color:${v.color}">${v.coinMult} монеты</div>
              <div class="muted" style="font-size:10px">дальность ${v.range}</div>
            </div>
          </div>
          <div style="margin-top:6px;font-size:11px;color:var(--muted)">${v.extra}</div>`;
        wrap.appendChild(d);
      });

    } else if (tab === "top") {
      wrap.innerHTML = "";
      if (!topPl.length) { wrap.innerHTML=`<div class="muted" style="text-align:center;padding:16px">Нет игроков</div>`; return; }
      topPl.forEach((p,i) => {
        const d=document.createElement("div"); d.className="card"+(i===0?" card-gold":"");
        const isMe = p.user_id === meInfo.id;
        if (isMe) d.style.borderColor="rgba(76,201,240,0.4)";
        // Score gap to leader
        const leader = topPl[0];
        const gap = i === 0 ? "" : `<div class="muted" style="font-size:10px">−${leader.score - p.score} от лидера</div>`;
        d.innerHTML=`<div class="row"><div class="row-start"><div class="rank-badge ${i===0?"rank-1":i===1?"rank-2":i===2?"rank-3":"rank-n"}">${i+1}</div><div class="col"><div class="bold small">${p.display_name}${i===0?" 👑":""} ${vipBadgeHtml(p.vip_level)}</div><div class="muted" style="font-size:11px">Ур.${p.level}</div>${gap}</div></div><div class="bold" style="color:var(--accent);font-size:13px">★ ${p.score}</div></div>`;
        wrap.appendChild(d);
      });
    } else if (tab === "history") {
      wrap.innerHTML = "";
      if (!history.length) { wrap.innerHTML=`<div class="muted" style="text-align:center;padding:16px">Нет завершённых раундов</div>`; return; }
      for (const r of history) {
        const d = document.createElement("div"); d.className = "card";
        const payStatus = r.payout_status === "paid"
          ? `<span class="reward-badge">✅ Выплачено</span>`
          : r.payout_status === "pending"
            ? `<span style="color:var(--gold);font-size:11px">⏳ Ожидает</span>`
            : `<span class="muted small">—</span>`;
        const ended = r.ended_at ? new Date(r.ended_at).toLocaleDateString("ru") : "—";
        d.innerHTML = `
          <div class="row">
            <div class="col">
              <div class="bold small">Раунд #${r.round_id}</div>
              <div class="muted" style="font-size:11px">${ended} · 🏆 ${r.winner_name||"нет победителя"}</div>
            </div>
            <div class="col" style="text-align:right">
              <div class="gold bold">${r.total_stars} ⭐</div>
              ${payStatus}
            </div>
          </div>`;
        wrap.appendChild(d);
      }
    }
  }

  panelBody.querySelectorAll(".pool-tabs .tab-btn").forEach(btn => {
    btn.onclick = () => renderPoolTab(btn.dataset.ptab);
  });
  renderPoolTab("donate");
});

// ── Pool Ticker ───────────────────────────────────────────────────────────────
const poolTickerEl = document.getElementById("poolTicker");
const poolTickerValEl = document.getElementById("poolTickerVal");

async function fetchPoolTicker() {
  try {
    const data = await apiGet("/api/pool");
    const newStars = data.total_stars || 0;
    if (newStars !== poolStars) {
      poolStars = newStars;
      if (poolTickerValEl) poolTickerValEl.textContent = poolStars;
      if (poolTickerEl) {
        poolTickerEl.classList.remove("hidden");
        poolTickerEl.classList.add("pulse");
        setTimeout(() => poolTickerEl.classList.remove("pulse"), 1200);
      }
    }
  } catch {}
}

// ── Alerts ────────────────────────────────────────────────────────────────────
async function fetchAlerts() {
  try {
    const data = await apiGet("/api/game/my_alerts");
    for (const a of (data.alerts || [])) {
      if (a.id <= lastAlertId) continue;
      lastAlertId = a.id;
      if (a.result === "captured") {
        showToast(`⚠️ ${a.attacker} захватил (${a.x},${a.y})!`, "error", 3000);
        tg?.HapticFeedback?.notificationOccurred?.("warning");
      } else {
        showToast(`🛡 Атака на (${a.x},${a.y}) отбита`, "", 2200);
      }
    }
  } catch {}
}

// ── Confetti ──────────────────────────────────────────────────────────────────
function spawnConfetti() {
  if (!confettiCanvas) return;
  confettiCanvas.width  = window.innerWidth;
  confettiCanvas.height = window.innerHeight;
  confetti.length = 0;
  const cols = ["#ffd700","#ff3b30","#34d399","#4cc9f0","#a78bfa","#fbbf24","#ff9500"];
  for (let i = 0; i < 120; i++) {
    confetti.push({
      x: Math.random() * confettiCanvas.width,
      y: -20 - Math.random() * 200,
      vx: (Math.random() - 0.5) * 4,
      vy: 2 + Math.random() * 4,
      rot: Math.random() * Math.PI * 2,
      rotV: (Math.random() - 0.5) * 0.2,
      w: 6 + Math.random() * 8,
      h: 3 + Math.random() * 5,
      color: cols[Math.floor(Math.random() * cols.length)],
      life: 1.0,
    });
  }
  let frame = 0;
  function animConf() {
    if (!cctx || frame++ > 200) { cctx?.clearRect(0,0,confettiCanvas.width,confettiCanvas.height); return; }
    cctx.clearRect(0,0,confettiCanvas.width,confettiCanvas.height);
    for (const c of confetti) {
      c.x += c.vx; c.y += c.vy; c.rot += c.rotV; c.life -= 0.005;
      if (c.y > confettiCanvas.height) { c.y = -10; c.x = Math.random()*confettiCanvas.width; }
      cctx.save();
      cctx.translate(c.x, c.y);
      cctx.rotate(c.rot);
      cctx.globalAlpha = Math.max(0, c.life);
      cctx.fillStyle = c.color;
      cctx.fillRect(-c.w/2, -c.h/2, c.w, c.h);
      cctx.restore();
    }
    requestAnimationFrame(animConf);
  }
  animConf();
}

function showJackpot(roundId, stars) {
  const overlay = document.getElementById("jackpotOverlay");
  const sub = document.getElementById("jackpotSub");
  if (!overlay) return;
  if (sub) sub.textContent = `Раунд #${roundId} · ${stars} ⭐`;
  overlay.classList.remove("hidden");
  spawnConfetti();
  tg?.HapticFeedback?.notificationOccurred?.("success");

  document.getElementById("btnJackpotClose")?.addEventListener("click", () => {
    overlay.classList.add("hidden");
  }, { once: true });
  document.getElementById("btnJackpotClaim")?.addEventListener("click", async () => {
    try {
      await apiPost("/api/pool/withdrawal", {});
      overlay.classList.add("hidden");
      showPopup("🏆 Заявка подана!", "Свяжитесь с администратором для получения выплаты.", "vip", 5000);
    } catch (err) {
      const msg = (err?.message) || "";
      if (msg.includes("already_requested") || msg.includes("not_winner")) {
        overlay.classList.add("hidden");
      } else {
        showToast("Ошибка заявки", "error");
      }
    }
  }, { once: true });
}

// ── War Feed panel ────────────────────────────────────────────────────────────
document.getElementById("btnWar")?.addEventListener("click", () => openPanel("⚔️ Лента войны", async () => {
  const data = await apiGet("/api/warfeed");
  const feed = data.feed || [];
  panelBody.innerHTML = "";
  if (!feed.length) {
    panelBody.innerHTML = `<div class="muted" style="text-align:center;padding:16px">Пока тихо... Начни атаковать!</div>`;
    return;
  }
  for (const e of feed) {
    const div = document.createElement("div");
    div.className = `war-feed-item ${e.result === "captured" ? "war-captured" : "war-defended"}`;
    div.innerHTML = `
      <div class="war-feed-text">${e.text}</div>
      <div class="war-feed-ago">${e.ago}</div>`;
    div.addEventListener("click", () => {
      closePanel();
      // Navigate to tile
      offsetX = Math.floor(canvas.clientWidth/2 - e.x*zoom - zoom/2);
      offsetY = Math.floor(canvas.clientHeight/2 - e.y*zoom - zoom/2);
      fetchState().then(render).catch(()=>render());
    });
    panelBody.appendChild(div);
  }
}));

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const d = await apiGet("/api/me");
  meData = d; coins = d.coins; score = d.score;
  me = { ...d.pos, id: d.id };
  recenter();
  await Promise.all([fetchState(), fetchMinimap()]);
  updateStats();
  render();
  if(loadingEl) loadingEl.style.display = "none";

  // Show jackpot overlay if user won a round
  if (d.jackpot) {
    setTimeout(() => showJackpot(d.jackpot.round_id, d.jackpot.total_stars), 800);
  }

  // Start pool ticker
  await fetchPoolTicker();
}

function animate(now) { render(now); requestAnimationFrame(animate); }

setInterval(() => { fetchState().catch(()=>{}); }, 1500);
setInterval(() => { fetchMinimap().catch(()=>{}); }, 4000);
setInterval(() => { fetchAlerts().catch(()=>{}); }, 8000);
setInterval(() => { fetchPoolTicker().catch(()=>{}); }, 10000);

init().catch(e => {
  const raw=(e?.message)||String(e);
  const isMissingInit = raw.includes("missing_initdata") || raw.includes("401");
  const msg = isMissingInit
    ? "Открой игру через кнопку 🎮 Играть в боте"
    : `Ошибка: ${raw}`;
  statsEl.textContent = msg;
  if(loadingEl){
    const lt=loadingEl.querySelector(".loading-text");
    if(lt) lt.textContent = msg;
    const sp=loadingEl.querySelector(".spinner");
    if(sp) sp.style.display="none";
    // Show retry hint
    if(isMissingInit){
      const hint=document.createElement("div");
      hint.style.cssText="margin-top:16px;font-size:13px;opacity:0.6;text-align:center;padding:0 20px;";
      hint.textContent="Нажми /start в боте и кнопку 🎮 Играть";
      loadingEl.appendChild(hint);
    }
  }
  console.error(e);
});

requestAnimationFrame(animate);
