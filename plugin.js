// JuanIPTV — Generador automático de cuentas IPTV
// Raspa fuentes públicas, prueba cuentas Xtream Codes activas y las sirve como canales en Kino.
// language: JavaScript ES Module, target: QuickJS (Kino plugin sandbox)

// ─── Fuentes públicas de cuentas Xtream ──────────────────────────────────────
// Cada entrada es una URL raw que devuelve texto plano con bloques Host/User/Pass.
const FUENTES = [
  "https://justpaste.it/dv74u",
  "https://pastebin.com/raw/TxYcDXZa",
  "https://pastebin.com/raw/0B45GFTS",
  "https://pastebin.com/raw/rycBH2CS",
  "https://pastebin.com/raw/nQzdJpDH",
];

// ─── Regex para extraer cuentas del texto ────────────────────────────────────
// Soporta formatos comunes:
//   Host: http://server:port   User: user   Pass: pass
//   http://server:port|user|pass
//   server:port username password   (líneas separadas o en la misma línea)
const RE_BLOQUE = /(?:host|url|server)[:\s]+([^\s\r\n]+)[^\S\r\n]*[\r\n|,;\s]+[^\S\r\n]*(?:user(?:name)?|usr)[:\s]+([^\s\r\n]+)[^\S\r\n]*[\r\n|,;\s]+[^\S\r\n]*(?:pass(?:word)?|pwd)[:\s]+([^\s\r\n]+)/gi;
const RE_PIPE   = /\b(https?:\/\/[^\s|]+)\s*[|,]\s*([^\s|,]+)\s*[|,]\s*([^\s|,\r\n]+)/gi;
const RE_M3U    = /['"](https?:\/\/[^'"]+)\/get\.php\?username=([^&'"]+)&password=([^&'"]+)/gi;
const RE_INLINE = /(?:host|server)[:\s=]+(https?:\/\/[^\s,]+)[,;\s]+(?:user(?:name)?)[:\s=]+([^\s,;]+)[,;\s]+(?:pass(?:word)?)[:\s=]+([^\s,;\r\n]+)/gi;

function parsearCuentas(texto) {
  const cuentas = [];
  const vistas  = new Set();

  function agregar(host, user, pass) {
    host = host.trim().replace(/\/$/, "");
    user = user.trim();
    pass = pass.trim();
    if (!host || !user || !pass) return;
    // normalizar host
    if (!/^https?:\/\//i.test(host)) host = "http://" + host;
    const clave = host + "|" + user + "|" + pass;
    if (vistas.has(clave)) return;
    vistas.add(clave);
    cuentas.push({ host, user, pass });
  }

  let m;

  RE_BLOQUE.lastIndex = 0;
  while ((m = RE_BLOQUE.exec(texto)) !== null) agregar(m[1], m[2], m[3]);

  RE_PIPE.lastIndex = 0;
  while ((m = RE_PIPE.exec(texto)) !== null) agregar(m[1], m[2], m[3]);

  RE_M3U.lastIndex = 0;
  while ((m = RE_M3U.exec(texto)) !== null) agregar(m[1], m[2], m[3]);

  RE_INLINE.lastIndex = 0;
  while ((m = RE_INLINE.exec(texto)) !== null) agregar(m[1], m[2], m[3]);

  return cuentas;
}

// ─── Verificar si una cuenta Xtream está activa ───────────────────────────────
async function probarCuenta(cuenta) {
  await null; // evitar throw antes del primer await (compatibilidad Kino 0.9.49)
  const url = cuenta.host + "/player_api.php?username=" + encodeURIComponent(cuenta.user)
    + "&password=" + encodeURIComponent(cuenta.pass);
  try {
    const r = await kino.fetch(url, { timeoutMs: 8000 });
    if (!r.ok) return false;
    const data = r.json();
    // Respuesta válida de Xtream: tiene user_info y server_info
    return !!(data && data.user_info && data.server_info);
  } catch {
    return false;
  }
}

// ─── Obtener texto de una fuente ──────────────────────────────────────────────
async function fetchTexto(url) {
  await null;
  try {
    const r = await kino.fetch(url, { timeoutMs: 10000 });
    if (!r.ok) return "";
    return r.text();
  } catch {
    return "";
  }
}

// ─── Caché en storage ─────────────────────────────────────────────────────────
const CACHE_KEY = "cuentas_activas";
const CACHE_TTL = 30 * 60 * 1000; // 30 minutos

function cargarCache() {
  try {
    const raw = kino.storage.get(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.ts > CACHE_TTL) return null;
    return obj.cuentas;
  } catch {
    return null;
  }
}

function guardarCache(cuentas) {
  try {
    kino.storage.set(CACHE_KEY, JSON.stringify({ ts: Date.now(), cuentas }));
  } catch {
    // storage lleno: continuar sin caché
  }
}

// ─── Buscar y probar cuentas ──────────────────────────────────────────────────
async function obtenerCuentasActivas() {
  await null;

  // Intentar desde caché
  const cached = cargarCache();
  if (cached && cached.length > 0) return cached;

  const maxStr  = kino.config.get("maxCuentas") || "10";
  const max     = Math.min(parseInt(maxStr, 10) || 10, 20);
  const extra   = kino.config.get("fuenteExtra");

  const fuentes = [...FUENTES];
  if (extra) fuentes.unshift(extra);

  // Recopilar todas las cuentas candidatas
  const candidatas = [];
  for (const fuenteUrl of fuentes) {
    const texto = await fetchTexto(fuenteUrl);
    if (texto) {
      const encontradas = parsearCuentas(texto);
      candidatas.push(...encontradas);
    }
    if (candidatas.length >= max * 3) break; // tenemos suficientes para probar
  }

  if (candidatas.length === 0) {
    throw kino.error("unavailable", "No se encontraron cuentas en las fuentes");
  }

  // Probar de a una hasta llegar al límite de activas
  const activas = [];
  for (const cuenta of candidatas) {
    if (activas.length >= max) break;
    const ok = await probarCuenta(cuenta);
    if (ok) activas.push(cuenta);
  }

  if (activas.length === 0) {
    throw kino.error("unavailable", "Ninguna cuenta activa encontrada, intenta más tarde");
  }

  guardarCache(activas);
  return activas;
}

// ─── Obtener categorías Xtream de una cuenta ─────────────────────────────────
async function getCategorias(cuenta) {
  await null;
  const url = cuenta.host + "/player_api.php?username=" + encodeURIComponent(cuenta.user)
    + "&password=" + encodeURIComponent(cuenta.pass) + "&action=get_live_categories";
  try {
    const r = await kino.fetch(url, { timeoutMs: 10000 });
    if (!r.ok) return [];
    const data = r.json();
    if (!Array.isArray(data)) return [];
    return data; // [{ category_id, category_name }]
  } catch {
    return [];
  }
}

// ─── Obtener canales Xtream de una cuenta + categoría ────────────────────────
async function getCanales(cuenta, categoryId) {
  await null;
  const url = cuenta.host + "/player_api.php?username=" + encodeURIComponent(cuenta.user)
    + "&password=" + encodeURIComponent(cuenta.pass)
    + "&action=get_live_streams&category_id=" + encodeURIComponent(categoryId);
  try {
    const r = await kino.fetch(url, { timeoutMs: 15000 });
    if (!r.ok) return [];
    const data = r.json();
    if (!Array.isArray(data)) return [];
    return data; // [{ stream_id, name, stream_icon, num, epg_channel_id }]
  } catch {
    return [];
  }
}

// ─── Codificar/decodificar ref ────────────────────────────────────────────────
// ref: base64url de JSON { host, user, pass, sid, ext }
function encRef(host, user, pass, sid, ext) {
  const s = JSON.stringify({ h: host, u: user, p: pass, s: sid, e: ext || "ts" });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function decRef(ref) {
  try {
    const b64 = ref.replace(/-/g, "+").replace(/_/g, "/");
    const pad  = (4 - b64.length % 4) % 4;
    const obj  = JSON.parse(atob(b64 + "=".repeat(pad)));
    return { host: obj.h, user: obj.u, pass: obj.p, sid: obj.s, ext: obj.e || "ts" };
  } catch {
    return null;
  }
}

// ─── categoryId encode ────────────────────────────────────────────────────────
// Kino id: ^[A-Za-z0-9._~-]{1,128}$  — usamos base64url también
function encCatId(accountIdx, categoryId) {
  const s = accountIdx + ":" + categoryId;
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function decCatId(id) {
  try {
    const b64 = id.replace(/-/g, "+").replace(/_/g, "/");
    const pad  = (4 - b64.length % 4) % 4;
    const s    = atob(b64 + "=".repeat(pad));
    const i    = s.indexOf(":");
    return { accountIdx: parseInt(s.slice(0, i), 10), categoryId: s.slice(i + 1) };
  } catch {
    return null;
  }
}

// ─── Exports requeridos por Kino ──────────────────────────────────────────────

export async function home() {
  return [];
}

export async function liveCategories() {
  const cuentas = await obtenerCuentasActivas();

  const categorias = [];

  for (let i = 0; i < cuentas.length; i++) {
    const cuenta = cuentas[i];
    const cats   = await getCategorias(cuenta);

    // Si no tiene categorías de la API, una sola "Todos los canales"
    if (cats.length === 0) {
      categorias.push({
        id:    encCatId(i, "all"),
        title: "Servidor " + (i + 1) + " — Todos",
      });
    } else {
      for (const cat of cats.slice(0, 50)) { // max 50 cats por servidor
        categorias.push({
          id:    encCatId(i, cat.category_id),
          title: "S" + (i + 1) + " · " + (cat.category_name || "Sin nombre"),
        });
      }
    }

    if (categorias.length >= 200) break; // límite de Kino
  }

  if (categorias.length === 0) {
    throw kino.error("unavailable", "Sin categorías disponibles");
  }

  return categorias;
}

export async function liveChannels({ categoryId, cursor }) {
  await null;

  const decoded = decCatId(categoryId);
  if (!decoded) throw kino.error("not_found", "Categoría inválida");

  const cuentas = cargarCache();
  if (!cuentas || !cuentas[decoded.accountIdx]) {
    throw kino.error("unavailable", "Recarga la pestaña En vivo para refrescar");
  }

  const cuenta = cuentas[decoded.accountIdx];

  // Paginación simple: cursor es el offset numérico
  const PAGE    = 100;
  const offset  = cursor ? parseInt(cursor, 10) : 0;

  let canales;
  if (decoded.categoryId === "all") {
    // sin category_id → todos los streams
    const url = cuenta.host + "/player_api.php?username=" + encodeURIComponent(cuenta.user)
      + "&password=" + encodeURIComponent(cuenta.pass) + "&action=get_live_streams";
    try {
      const r = await kino.fetch(url, { timeoutMs: 15000 });
      canales  = r.ok ? (r.json() || []) : [];
    } catch {
      canales = [];
    }
  } else {
    canales = await getCanales(cuenta, decoded.categoryId);
  }

  if (!Array.isArray(canales)) canales = [];

  const pagina = canales.slice(offset, offset + PAGE);
  const next   = offset + PAGE < canales.length ? String(offset + PAGE) : undefined;

  const items = pagina.map((ch) => {
    const sid = String(ch.stream_id || "");
    const ext = ch.container_extension || "ts";
    return {
      id:         encRef(cuenta.host, cuenta.user, cuenta.pass, sid, ext).slice(0, 128),
      title:      String(ch.name || "Canal sin nombre").slice(0, 100),
      categoryId,
      ref:        encRef(cuenta.host, cuenta.user, cuenta.pass, sid, ext),
      logo:       ch.stream_icon || undefined,
      number:     ch.num && ch.num >= 1 && ch.num <= 9999 ? ch.num : undefined,
    };
  });

  return { items, next };
}

export async function liveSearch({ query }) {
  await null;

  const cuentas = cargarCache();
  if (!cuentas || cuentas.length === 0) return [];

  const q = query.toLowerCase();
  const results = [];

  for (let i = 0; i < cuentas.length && results.length < 100; i++) {
    const cuenta  = cuentas[i];
    const url     = cuenta.host + "/player_api.php?username=" + encodeURIComponent(cuenta.user)
      + "&password=" + encodeURIComponent(cuenta.pass) + "&action=get_live_streams";
    let canales;
    try {
      const r = await kino.fetch(url, { timeoutMs: 10000 });
      canales  = r.ok ? (r.json() || []) : [];
    } catch {
      canales = [];
    }
    if (!Array.isArray(canales)) continue;

    for (const ch of canales) {
      if (!ch.name) continue;
      if (!ch.name.toLowerCase().includes(q)) continue;
      const sid = String(ch.stream_id || "");
      const ext = ch.container_extension || "ts";
      results.push({
        id:    encRef(cuenta.host, cuenta.user, cuenta.pass, sid, ext).slice(0, 128),
        title: String(ch.name).slice(0, 100),
        ref:   encRef(cuenta.host, cuenta.user, cuenta.pass, sid, ext),
        logo:  ch.stream_icon || undefined,
      });
      if (results.length >= 100) break;
    }
  }

  return results;
}

export async function resolve(ref) {
  await null;

  const d = decRef(ref);
  if (!d) throw kino.error("not_found", "Ref inválido");

  // URL de stream Xtream: /live/user/pass/stream_id.ext
  const url = d.host + "/live/"
    + encodeURIComponent(d.user) + "/"
    + encodeURIComponent(d.pass) + "/"
    + encodeURIComponent(d.sid) + "." + d.ext;

  return {
    url,
    mime: "application/vnd.apple.mpegurl",
  };
}
