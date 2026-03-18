const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const mini = document.getElementById("mini");
const mctx = mini.getContext("2d");

const statsEl = document.getElementById("stats");
const btnRecenter = document.getElementById("btnRecenter");
const btnShop = document.getElementById("btnShop");
const btnLoot = document.getElementById("btnLoot");
const btnProfile = document.getElementById("btnProfile");

// If Telegram/WebView cached old HTML that still had the "Круг" button,
// remove it to keep a fixed circular arena layout.
const btnRoundEl = document.getElementById("btnRound");
if (btnRoundEl) btnRoundEl.remove();

const panel = document.getElementById("panel");
const panelTitle = document.getElementById("panelTitle");
const panelBody = document.getElementById("panelBody");
const btnClose = document.getElementById("btnClose");

btnClose.onclick = () => panel.classList.add("hidden");

const INITDATA = tg?.initData || "";
const headers = INITDATA
  ? { "X-TG-INITDATA": INITDATA }
  : { "X-ADMIN-SECRET": "change_me" }; // dev-only: set same as ADMIN_SECRET in .env

const API_BASE = (
  window.__API_BASE__ ||
  (location.hostname.endsWith("github.io") ? "https://pixel-field-backend.onrender.com" : "") ||
  ""
).replace(/\/$/, "");

let mapW = 2000;
let mapH = 2000;

let me = { x: 0, y: 0 };
let coins = 0;
let score = 0;
let tiles = new Map(); // key "x,y" -> {c,o}
let players = new Map(); // id -> {x,y,style,level,name}

let zoom = 14; // pixels per tile
let offsetX = 0;
let offsetY = 0;
let dragging = false;
let lastMouse = { x: 0, y: 0 };
let roundMask = true;
let t0 = performance.now();
let lastToastAt = 0;
let toast = "";
let dragMoved = false;
let dragStart = { x: 0, y: 0 };
let suppressClickUntil = 0;
let actionInFlight = false;
const ROUND_DIAMETER_TILES = 12;

function arenaRadiusPx() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const rByZoom = (ROUND_DIAMETER_TILES * zoom) / 2;
  return Math.min(rByZoom, Math.min(w, h) / 2);
}

function setToast(msg) {
  toast = msg;
  lastToastAt = performance.now();
}

function inRoundArena(sx, sy) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const r = arenaRadiusPx();
  const dx = sx - w / 2;
  const dy = sy - h / 2;
  return (dx * dx + dy * dy) <= (r * r);
}

btnProfile.onclick = async () => {
  panelTitle.textContent = "Профиль / Инвентарь";
  panel.classList.remove("hidden");
  panelBody.innerHTML = `<div class="muted">Загрузка...</div>`;
  const prof = await apiGet("/api/profile");
  const mep = prof.me;
  const inv = prof.inventory || [];
  const invStyles = inv.filter((x) => x.kind === "style");
  const invColors = inv.filter((x) => x.kind === "color");

  panelBody.innerHTML = `
    <div class="card">
      <div><b>${mep.display_name}</b></div>
      <div class="muted">Уровень: ${mep.level} · XP: ${mep.xp} · Очки: ${mep.score} · Покрашено: ${mep.tiles_painted}</div>
      <div class="muted">Стиль: <b>${mep.paint_style}</b> · Цвет: <b>${mep.base_color}</b></div>
    </div>
    <div class="card">
      <div class="row"><div><b>Стили</b></div><div class="muted">куплено: ${invStyles.length}</div></div>
      <div id="invStyles"></div>
    </div>
    <div class="card">
      <div class="row"><div><b>Цвета</b></div><div class="muted">куплено: ${invColors.length}</div></div>
      <div id="invColors"></div>
    </div>
  `;

  function mkItem(it) {
    const div = document.createElement("div");
    div.className = "card";
    div.style.marginBottom = "8px";
    div.innerHTML = `
      <div class="row">
        <div>
          <div><b>${it.title}</b></div>
          <div class="muted">${it.id}</div>
        </div>
        <button class="btn">Экипировать</button>
      </div>
    `;
    div.querySelector("button").onclick = async () => {
      try {
        await apiPost("/api/cosmetics/equip", { cosmetic_id: it.id });
        div.querySelector(".muted").textContent = "Экипировано!";
        // жёсткий сброс: перезагружаем все тайлы с сервера
        tiles.clear();
        const miniData = await apiGet("/api/game/minimap");
        mapW = miniData.map.w;
        mapH = miniData.map.h;
        for (const t of miniData.tiles) {
          tiles.set(key(t.x, t.y), { c: t.c, o: t.o });
        }
        await fetchState();
        await fetchMinimap();
        render();
      } catch (e) {
        div.querySelector(".muted").textContent = "Ошибка экипировки.";
      }
    };
    return div;
  }

  const sWrap = panelBody.querySelector("#invStyles");
  if (!invStyles.length) sWrap.innerHTML = `<div class="muted">Пока нет. Открой «Магазин» и купи бесплатно.</div>`;
  else invStyles.forEach((it) => sWrap.appendChild(mkItem(it)));

  const cWrap = panelBody.querySelector("#invColors");
  if (!invColors.length) cWrap.innerHTML = `<div class="muted">Пока нет. Открой «Магазин» и купи бесплатно.</div>`;
  else invColors.forEach((it) => cWrap.appendChild(mkItem(it)));
};

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  mini.width = Math.floor(mini.clientWidth * dpr);
  mini.height = Math.floor(mini.clientHeight * dpr);
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();

function key(x, y) {
  return `${x},${y}`;
}

function screenToTile(sx, sy) {
  const x = Math.floor((sx - offsetX) / zoom);
  const y = Math.floor((sy - offsetY) / zoom);
  return { x, y };
}

function tileToScreen(x, y) {
  return { sx: x * zoom + offsetX, sy: y * zoom + offsetY };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function recenter() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  offsetX = Math.floor(w / 2 - me.x * zoom - zoom / 2);
  offsetY = Math.floor(h / 2 - me.y * zoom - zoom / 2);
}

btnRecenter.onclick = () => {
  recenter();
  render();
};

async function apiGet(path) {
  const r = await fetch(`${API_BASE}${path}`, { headers });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}
async function apiPost(path, body) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

function viewportTiles() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const pad = 2;
  const x0 = Math.floor((-offsetX) / zoom) - pad;
  const y0 = Math.floor((-offsetY) / zoom) - pad;
  const x1 = Math.floor((w - offsetX) / zoom) + pad;
  const y1 = Math.floor((h - offsetY) / zoom) + pad;
  return { x0: clamp(x0, 0, mapW - 1), y0: clamp(y0, 0, mapH - 1), x1: clamp(x1, 0, mapW - 1), y1: clamp(y1, 0, mapH - 1) };
}

let lastStateFetch = 0;
async function fetchState() {
  const t = Date.now();
  if (t - lastStateFetch < 200) return;
  lastStateFetch = t;

  const { x0, y0, x1, y1 } = viewportTiles();
  const data = await apiGet(`/api/game/state?x0=${x0}&y0=${y0}&x1=${x1}&y1=${y1}`);
  mapW = data.map.w;
  mapH = data.map.h;
  me = { x: data.me.x, y: data.me.y, id: data.me.id };
  for (const it of data.tiles) tiles.set(key(it.x, it.y), { c: it.c, o: it.o });
  players.clear();
  for (const p of (data.players || [])) players.set(p.id, p);
}

function parseStyle(s) {
  // "style:#rrggbb"
  if (!s || typeof s !== "string") return { style: "solid", color: "#44ccff" };
  const parts = s.split(":");
  const raw = parts.length >= 2 ? parts[1] : s;
  let color = raw;
  if (typeof color === "string") {
    if (/^#?[0-9a-fA-F]{3}$/.test(color)) {
      const h = color.replace("#", "");
      color = `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    }
    if (/^[0-9a-fA-F]{6}$/.test(color)) color = `#${color}`;
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = "#44ccff";
    color = color.toLowerCase();
  }
  if (parts.length >= 2) return { style: parts[0], color };
  return { style: "solid", color };
}

function hash2(x, y) {
  // deterministic pseudo random 0..1
  let n = x * 374761393 + y * 668265263;
  n = (n ^ (n >> 13)) * 1274126177;
  n = (n ^ (n >> 16)) >>> 0;
  return n / 4294967295;
}

function shade(hex, f) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const rr = Math.max(0, Math.min(255, Math.round(r * f)));
  const gg = Math.max(0, Math.min(255, Math.round(g * f)));
  const bb = Math.max(0, Math.min(255, Math.round(b * f)));
  return `#${rr.toString(16).padStart(2, "0")}${gg.toString(16).padStart(2, "0")}${bb.toString(16).padStart(2, "0")}`;
}

function lerp(a, b, t) { return a + (b - a) * t; }

function mix(c1, c2, t) {
  const h1 = c1.replace("#", "");
  const h2 = c2.replace("#", "");
  const r1 = parseInt(h1.slice(0, 2), 16), g1 = parseInt(h1.slice(2, 4), 16), b1 = parseInt(h1.slice(4, 6), 16);
  const r2 = parseInt(h2.slice(0, 2), 16), g2 = parseInt(h2.slice(2, 4), 16), b2 = parseInt(h2.slice(4, 6), 16);
  const r = Math.round(lerp(r1, r2, t));
  const g = Math.round(lerp(g1, g2, t));
  const b = Math.round(lerp(b1, b2, t));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function hsvToHex(h, s, v) {
  // h,s,v in [0..1]
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  const rr = Math.max(0, Math.min(255, Math.round(r * 255)));
  const gg = Math.max(0, Math.min(255, Math.round(g * 255)));
  const bb = Math.max(0, Math.min(255, Math.round(b * 255)));
  return `#${rr.toString(16).padStart(2, "0")}${gg.toString(16).padStart(2, "0")}${bb.toString(16).padStart(2, "0")}`;
}

function drawStyledTile(sx, sy, size, styleStr, x, y, timeSec) {
  const { style, color } = parseStyle(styleStr);
  if (style === "solid") {
    // subtle texture so solids look less "flat"
    const n = hash2(x, y);
    const f = 0.92 + n * 0.12;
    ctx.fillStyle = shade(color, f);
    ctx.fillRect(sx, sy, size, size);
    return;
  }
  if (style === "gradient") {
    const t = (x + y) / Math.max(1, (mapW + mapH));
    const c1 = color;
    const c2 = shade(color, 0.6);
    const g = ctx.createLinearGradient(sx, sy, sx + size, sy + size);
    g.addColorStop(0, c1);
    g.addColorStop(1, c2);
    ctx.fillStyle = g;
    ctx.fillRect(sx, sy, size, size);
    return;
  }
  if (style === "marble") {
    // simple marble veins
    const n = hash2(x, y);
    const veins = Math.abs(Math.sin((x * 0.9 + y * 0.7) + n * 6.0));
    const f = 0.55 + veins * 0.65;
    ctx.fillStyle = shade(color, f);
    ctx.fillRect(sx, sy, size, size);
    if (size >= 10) {
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx + (n * size), sy);
      ctx.lineTo(sx + size, sy + (n * size));
      ctx.stroke();
    }
    return;
  }
  if (style === "magma" || style === "magma_sparks") {
    const n = hash2(x, y);
    const pulse = Math.sin(timeSec * 1.8 + n * 4.0) * 0.5 + 0.5; // 0..1
    const base = shade(color, 0.7);
    const hotInner = mix("#ffd44a", "#ffffff", 0.3);
    const g = ctx.createRadialGradient(
      sx + size * 0.5,
      sy + size * 0.5,
      size * 0.1,
      sx + size * 0.5,
      sy + size * 0.5,
      size * 0.75
    );
    g.addColorStop(0, shade(hotInner, 0.9 + 0.4 * pulse));
    g.addColorStop(1, base);
    ctx.fillStyle = g;
    ctx.fillRect(sx, sy, size, size);
    if (size >= 10) {
      // тёмная корка
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.strokeRect(sx + 0.5, sy + 0.5, size - 1, size - 1);
    }
    if (style === "magma_sparks" && size >= 10) {
      // редкие искры
      const p = hash2(x + Math.floor(timeSec * 3), y + 19);
      if (p > 0.99) {
        ctx.fillStyle = "rgba(255,245,200,0.95)";
        ctx.fillRect(
          sx + size * (hash2(x, y) * 0.7 + 0.15),
          sy + size * (hash2(y, x) * 0.7 + 0.15),
          2,
          2
        );
      }
      // трещины
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.beginPath();
      ctx.moveTo(sx + size * 0.1, sy + size * 0.2);
      ctx.lineTo(sx + size * 0.9, sy + size * 0.8);
      ctx.moveTo(sx + size * 0.3, sy + size * 0.1);
      ctx.lineTo(sx + size * 0.7, sy + size * 0.9);
      ctx.stroke();
    }
    return;
  }
  if (style === "rainbow_shift") {
    const h = (timeSec * 0.08 + (x * 0.02) + (y * 0.015)) % 1;
    const c = hsvToHex(h, 0.9, 0.95);
    ctx.fillStyle = c;
    ctx.fillRect(sx, sy, size, size);
    return;
  }
  if (style === "neon_pulse") {
    const phase = Math.sin(timeSec * 4.0 + (x + y) * 0.35) * 0.5 + 0.5; // 0..1
    const core = shade(color, 0.9 + 0.4 * phase);
    ctx.fillStyle = core;
    ctx.fillRect(sx, sy, size, size);
    if (size >= 10) {
      // неоновый ореол
      ctx.strokeStyle = `rgba(255,255,255,${0.25 + 0.35 * phase})`;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx + 0.5, sy + 0.5, size - 1, size - 1);
    }
    return;
  }
  if (style === "ice") {
    const n = hash2(x, y);
    const c1 = mix("#a5f3fc", color, 0.35);
    const c2 = mix("#60a5fa", color, 0.55);
    const g = ctx.createLinearGradient(sx, sy, sx + size, sy + size);
    g.addColorStop(0, c1);
    g.addColorStop(1, c2);
    ctx.fillStyle = g;
    ctx.fillRect(sx, sy, size, size);
    if (size >= 10) {
      ctx.strokeStyle = `rgba(255,255,255,${0.08 + n * 0.18})`;
      ctx.beginPath();
      ctx.moveTo(sx + size * 0.2, sy + size * 0.1);
      ctx.lineTo(sx + size * 0.9, sy + size * 0.8);
      ctx.stroke();
    }
    return;
  }
  if (style === "crystal") {
    const n = hash2(x, y);
    const g = ctx.createLinearGradient(sx, sy + size, sx + size, sy);
    g.addColorStop(0, mix(color, "#ffffff", 0.2));
    g.addColorStop(1, mix(color, "#22d3ee", 0.35));
    ctx.fillStyle = g;
    ctx.fillRect(sx, sy, size, size);
    if (size >= 10) {
      // одна большая грань
      ctx.fillStyle = `rgba(255,255,255,${0.15 + 0.25 * n})`;
      ctx.beginPath();
      ctx.moveTo(sx + size * 0.15, sy + size * 0.85);
      ctx.lineTo(sx + size * 0.55, sy + size * 0.25);
      ctx.lineTo(sx + size * 0.85, sy + size * 0.65);
      ctx.closePath();
      ctx.fill();
    }
    return;
  }
  if (style === "aurora") {
    const n = hash2(x, y);
    const cA = hsvToHex((timeSec * 0.03 + n) % 1, 0.75, 0.95);
    const cB = hsvToHex((timeSec * 0.03 + n + 0.18) % 1, 0.75, 0.75);
    const g = ctx.createLinearGradient(sx, sy + size, sx + size, sy);
    g.addColorStop(0, mix(cA, color, 0.35));
    g.addColorStop(1, mix(cB, color, 0.35));
    ctx.fillStyle = g;
    ctx.fillRect(sx, sy, size, size);
    return;
  }
  if (style === "galaxy") {
    const n = hash2(x, y);
    // глубокий космос
    const base = mix("#020617", color, 0.18);
    ctx.fillStyle = base;
    ctx.fillRect(sx, sy, size, size);
    if (size >= 10) {
      // редкие звезды
      const s1 = hash2(x * 7 + 11, y * 13 + 3);
      if (s1 > 0.97) {
        const starSize = 1 + (s1 - 0.97) * 6;
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.fillRect(
          sx + size * (hash2(x, y) * 0.8 + 0.1),
          sy + size * (hash2(y, x) * 0.8 + 0.1),
          starSize,
          starSize
        );
      }
      // небольшая цветная туманность
      const glow = Math.max(0, Math.sin(timeSec * 0.4 + x * 0.12 + y * 0.07) * 0.5 + 0.5);
      ctx.fillStyle = `rgba(129,140,248,${0.04 + 0.10 * glow * n})`;
      ctx.fillRect(sx, sy, size, size);
      ctx.fillStyle = `rgba(45,212,191,${0.03 + 0.08 * (1 - glow) * n})`;
      ctx.fillRect(sx, sy, size, size);
    }
    return;
  }
  if (style === "glitch") {
    // чёрный фон
    ctx.fillStyle = "#020617";
    ctx.fillRect(sx, sy, size, size);
    if (size >= 6) {
      const pieces = 4;
      for (let i = 0; i < pieces; i++) {
        const r = hash2(x * 13 + i * 7, y * 17 + i * 3);
        const pw = (0.2 + r * 0.6) * size;
        const ph = (0.1 + hash2(x + i, y + i) * 0.3) * size;
        const px = sx + hash2(x + i * 31, y) * (size - pw);
        const py = sy + hash2(x, y + i * 19) * (size - ph);
        const palette = [
          "rgba(255,45,85,0.9)",  // red
          "rgba(0,122,255,0.9)",  // blue
          "rgba(52,199,89,0.9)",  // green
          "rgba(191,90,242,0.9)", // purple
        ];
        ctx.fillStyle = palette[i % palette.length];
        ctx.fillRect(px, py, pw, ph);
      }
      // редкие горизонтальные обрывы
      const n = hash2(x * 5 + 7, y * 11 + 23);
      if (n > 0.92) {
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        const hh = size * 0.18;
        const yy = sy + size * (0.2 + hash2(x + 9, y + 13) * 0.6);
        ctx.fillRect(sx, yy, size, hh);
      }
    }
    return;
  }
  if (style === "carbon") {
    const n = ((x + y) & 1) ? 0.15 : 0.0;
    ctx.fillStyle = mix("#0b0f17", color, 0.25 + n);
    ctx.fillRect(sx, sy, size, size);
    if (size >= 10) {
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.strokeRect(sx + 0.5, sy + 0.5, size - 1, size - 1);
    }
    return;
  }
  // fallback
  ctx.fillStyle = color;
  ctx.fillRect(sx, sy, size, size);
}

function render(timeNow = performance.now()) {
  const timeSec = (timeNow - t0) / 1000;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  // background grid
  ctx.fillStyle = "#070a10";
  ctx.fillRect(0, 0, w, h);

  const { x0, y0, x1, y1 } = viewportTiles();

  if (roundMask) {
    // clip to circle
    ctx.save();
    const r = arenaRadiusPx();
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2);
    ctx.clip();
  }

  // draw tiles
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const it = tiles.get(key(x, y));
      const { sx, sy } = tileToScreen(x, y);
      if (it) {
        drawStyledTile(sx, sy, zoom, it.c || "#44ccff", x, y, timeSec);
      } else {
        // small noise for "pixel field" vibe
        ctx.fillStyle = (x + y) % 17 === 0 ? "#0a1020" : "#080d18";
        ctx.fillRect(sx, sy, zoom, zoom);
      }
    }
  }

  // grid lines (only if zoom is large)
  if (zoom >= 12) {
    ctx.strokeStyle = "rgba(154,176,208,0.08)";
    ctx.lineWidth = 1;
    for (let x = x0; x <= x1; x++) {
      const { sx } = tileToScreen(x, y0);
      ctx.beginPath();
      ctx.moveTo(sx, tileToScreen(x, y0).sy);
      ctx.lineTo(sx, tileToScreen(x, y1 + 1).sy);
      ctx.stroke();
    }
    for (let y = y0; y <= y1; y++) {
      const { sy } = tileToScreen(x0, y);
      ctx.beginPath();
      ctx.moveTo(tileToScreen(x0, y).sx, sy);
      ctx.lineTo(tileToScreen(x1 + 1, y).sx, sy);
      ctx.stroke();
    }
  }

  // player
  const p = tileToScreen(me.x, me.y);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(p.sx + zoom * 0.25, p.sy + zoom * 0.25, zoom * 0.5, zoom * 0.5);
  ctx.strokeStyle = "#4cc9f0";
  ctx.lineWidth = 2;
  ctx.strokeRect(p.sx + 1, p.sy + 1, zoom - 2, zoom - 2);

  // other players
  for (const [id, pl] of players.entries()) {
    if (id === me.id) continue;
    const ps = tileToScreen(pl.x, pl.y);
    const { color } = parseStyle(pl.style);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(ps.sx + zoom * 0.5, ps.sy + zoom * 0.5, Math.max(3, zoom * 0.22), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.stroke();
  }

  if (roundMask) {
    // darken outside circle
    ctx.restore();
    const r = arenaRadiusPx();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2, true);
    ctx.fill("evenodd");
    ctx.strokeStyle = "rgba(154,176,208,0.18)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

async function fetchMinimap() {
  const data = await apiGet("/api/game/minimap");
  // draw full map (100x100)
  const w = mini.clientWidth;
  const h = mini.clientHeight;
  mctx.clearRect(0, 0, w, h);
  mctx.fillStyle = "rgba(10,16,32,0.8)";
  mctx.fillRect(0, 0, w, h);

  const cw = w / data.map.w;
  const ch = h / data.map.h;

  for (const t of data.tiles) {
    const { color } = parseStyle(t.c);
    mctx.fillStyle = color;
    mctx.fillRect(t.x * cw, t.y * ch, Math.max(1, cw), Math.max(1, ch));
  }

  for (const p of data.players) {
    const { color } = parseStyle(p.style);
    mctx.fillStyle = color;
    mctx.fillRect(p.x * cw, p.y * ch, Math.max(2, cw), Math.max(2, ch));
  }

  // me
  mctx.fillStyle = "#ffffff";
  mctx.fillRect(data.me.x * cw, data.me.y * ch, Math.max(3, cw), Math.max(3, ch));
  mctx.strokeStyle = "rgba(76,201,240,0.85)";
  mctx.lineWidth = 1;
  mctx.strokeRect(data.me.x * cw, data.me.y * ch, Math.max(3, cw), Math.max(3, ch));

  // current viewport rectangle
  const vp = viewportTiles();
  mctx.strokeStyle = "rgba(255,255,255,0.35)";
  mctx.strokeRect(vp.x0 * cw, vp.y0 * ch, (vp.x1 - vp.x0) * cw, (vp.y1 - vp.y0) * ch);
}

function updateStats(meResp) {
  if (meResp) {
    coins = meResp.coins;
    score = meResp.score;
    me = meResp.pos;
  }
  const extra = (toast && (performance.now() - lastToastAt) < 1500) ? ` · ${toast}` : "";
  statsEl.textContent = `Монеты: ${coins} · Очки: ${score} · Позиция: (${me.x},${me.y})${extra}`;
}

async function init() {
  const meResp = await apiGet("/api/me");
  coins = meResp.coins;
  score = meResp.score;
  me = { ...meResp.pos, id: meResp.id };
  recenter();
  await fetchState();
  await fetchMinimap();
  updateStats();
  render();
}

function animate(now) {
  render(now);
  requestAnimationFrame(animate);
}

canvas.addEventListener("mousedown", (e) => {
  dragging = true;
  lastMouse = { x: e.clientX, y: e.clientY };
  dragStart = { x: e.clientX, y: e.clientY };
  dragMoved = false;
});
window.addEventListener("mouseup", () => {
  dragging = false;
  if (dragMoved) suppressClickUntil = performance.now() + 250;
});
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastMouse.x;
  const dy = e.clientY - lastMouse.y;
  lastMouse = { x: e.clientX, y: e.clientY };
  if (!dragMoved) {
    const ddx = e.clientX - dragStart.x;
    const ddy = e.clientY - dragStart.y;
    if ((ddx * ddx + ddy * ddy) > (6 * 6)) dragMoved = true;
  }
  offsetX += dx;
  offsetY += dy;
  fetchState().then(render).catch(() => render());
});

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  suppressClickUntil = performance.now() + 200;
  const oldZoom = zoom;
  const delta = Math.sign(e.deltaY);
  zoom = clamp(zoom + (delta > 0 ? -1 : 1), 6, 32);
  // zoom around cursor
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const tx = (mx - offsetX) / oldZoom;
  const ty = (my - offsetY) / oldZoom;
  offsetX = mx - tx * zoom;
  offsetY = my - ty * zoom;
  fetchState().then(render).catch(render);
}, { passive: false });

canvas.addEventListener("click", async (e) => {
  if (dragging) return;
  if (actionInFlight) return;
  if (performance.now() < suppressClickUntil) return;
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  if (roundMask && !inRoundArena(sx, sy)) return;
  const t = screenToTile(sx, sy);
  // New behavior:
  // - if near (manhattan=1) -> paint clicked
  // - if far -> step 1 toward target and paint that step tile
  const dx = clamp(t.x - me.x, -1, 1);
  const dy = clamp(t.y - me.y, -1, 1);
  if (Math.abs(dx) + Math.abs(dy) === 0) return;
  // choose axis if diagonal
  let sx1 = dx, sy1 = dy;
  if (Math.abs(dx) + Math.abs(dy) === 2) {
    if (Math.abs(t.x - me.x) >= Math.abs(t.y - me.y)) sy1 = 0;
    else sx1 = 0;
  }
  const nx = me.x + sx1;
  const ny = me.y + sy1;
  const nxC = clamp(nx, 0, mapW - 1);
  const nyC = clamp(ny, 0, mapH - 1);
  try {
    actionInFlight = true;
    const resp = await apiPost("/api/game/paint", { x: nxC, y: nyC, color: "#44ccff" });
    me = { ...resp.pos, id: me.id };
    coins = resp.coins;
    score = resp.score;
    updateStats();
    await fetchState();
    render();
  } catch (err) {
    const msg = (err && err.message) ? err.message : "";
    // If paint cooldown, at least move.
    if (msg.includes("paint_cooldown")) {
      try {
        const m = await apiPost("/api/game/move", { dx: sx1, dy: sy1 });
        me = { ...m.pos, id: me.id };
        setToast("кулдаун покраски");
        updateStats();
        await fetchState();
        render();
        return;
      } catch (e2) {
        // ignore
      }
    }
    if (msg.includes("move_cooldown")) setToast("кулдаун движения");
    else if (msg.includes("too_far")) setToast("слишком далеко");
    else setToast("ошибка");
    updateStats();
  } finally {
    actionInFlight = false;
  }
});

btnShop.onclick = async () => {
  panelTitle.textContent = "Магазин";
  panel.classList.remove("hidden");
  const cat = await apiGet("/api/shop/catalog");
  panelBody.innerHTML = "";
  for (const it of cat.items) {
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML = `
      <div class="row">
        <div>
          <div><b>${it.title}</b></div>
          <div class="muted">Цена: ${it.price} монет</div>
        </div>
        <button class="btn">Купить</button>
      </div>
    `;
    div.querySelector("button").onclick = async () => {
      try {
        const r = await apiPost("/api/shop/buy", { item_id: it.id });
        coins = r.coins;
        updateStats();
        div.querySelector(".muted").textContent = `Куплено! (-${r.result.spent})`;
      } catch (e) {
        div.querySelector(".muted").textContent = "Не хватает монет или ошибка.";
      }
    };
    panelBody.appendChild(div);
  }
};

btnLoot.onclick = async () => {
  panelTitle.textContent = "Лут";
  panel.classList.remove("hidden");
  const list = await apiGet("/api/loot/list");
  panelBody.innerHTML = "";
  if (!list.crates.length) {
    panelBody.innerHTML = `<div class="muted">Пока нет ящиков. Крась клетки (в центре шанс выше).</div>`;
    return;
  }
  for (const c of list.crates) {
    const div = document.createElement("div");
    div.className = "card";
    const status = c.opened ? `Открыт: ${c.reward_type} (${c.reward_amount})` : "Закрыт";
    div.innerHTML = `
      <div class="row">
        <div>
          <div><b>Ящик #${c.id}</b></div>
          <div class="muted">${status}</div>
        </div>
        <button class="btn">${c.opened ? "OK" : "Открыть"}</button>
      </div>
    `;
    const btn = div.querySelector("button");
    btn.disabled = c.opened;
    btn.onclick = async () => {
      const r = await apiPost(`/api/loot/open/${c.id}`, {});
      coins = r.coins;
      updateStats();
      div.querySelector(".muted").textContent = `Открыт: ${r.result.reward_type} (${r.result.reward_amount})`;
      btn.disabled = true;
      btn.textContent = "OK";
    };
    panelBody.appendChild(div);
  }
};

setInterval(() => {
  fetchMinimap().catch(() => {});
}, 1500);

init().catch((e) => {
  const msg = (e && typeof e === "object" && "message" in e) ? e.message : String(e);
  const hasTg = Boolean(tg);
  const initLen = (tg?.initData || "").length;
  statsEl.textContent = `Ошибка инициализации: ${msg} · tg=${hasTg} · initDataLen=${initLen}`;
  console.error(e);
});

requestAnimationFrame(animate);

