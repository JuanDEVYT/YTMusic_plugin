/// <reference path="./kino.d.ts" />
// YouTube Music para Kino · apiVersion 8 (Kino 0.9.54 o superior)
//
// - Catálogo (buscar, Inicio, álbumes, listas): API interna de music.youtube.com (cliente WEB_REMIX),
//   con la sesión de la persona si pegó sus cookies en Ajustes.
// - Reproducción: la API /player con un cliente que entrega URLs directas de audio, sin descifrar firmas.
//   Es la parte frágil: YouTube cambia estas reglas cada tanto. Todo lo que puede caducar está en CLIENTS.

const API = "https://music.youtube.com/youtubei/v1/";
const ORIGIN = "https://music.youtube.com";
const PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";
const COOKIE_KEYS = ["cookieA", "cookieB", "cookieC"];

// Clientes para /player, en orden de preferencia. El cliente IOS se quitó: sus URLs dan 403 sin el token
// que solo genera el reproductor real. Si este deja de funcionar, resolve() usa el navegador oculto.
const CLIENTS = [
  {
    ua: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
    id: "28",
    client: {
      clientName: "ANDROID_VR",
      clientVersion: "1.65.10",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      osName: "Android",
      osVersion: "12L",
      androidSdkVersion: 32,
    },
  },
];

const T_ALBUM = "MUSIC_PAGE_TYPE_ALBUM";
const T_PLAYLIST = "MUSIC_PAGE_TYPE_PLAYLIST";
const T_ARTISTS = ["MUSIC_PAGE_TYPE_ARTIST", "MUSIC_PAGE_TYPE_USER_CHANNEL"];

// ---------------------------------------------------------------------------------------------
// Sesión: las cookies de la persona (ajuste password, cifrado en el aparato)
// ---------------------------------------------------------------------------------------------

function parseCookie(str) {
  const jar = {};
  for (const part of String(str || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return jar;
}

// Une las partes, quita un "Cookie:" del comienzo y vuelve a armar "a=b; c=d" (un corte que cayó
// justo en un espacio no importa).
function joinCookie(parts) {
  const joined = parts
    .map((v) => v || "")
    .join("")
    .replace(/[\r\n\t]+/g, "")
    .replace(/^\s*cookie:\s*/i, "");
  const jar = parseCookie(joined);
  return Object.keys(jar)
    .map((k) => k + "=" + jar[k])
    .join("; ");
}

function savedCookie() {
  return joinCookie(COOKIE_KEYS.map((k) => kino.config.get(k)));
}

function authHeaders(cookie) {
  if (!cookie) return {};
  const h = { Cookie: cookie, "X-Goog-AuthUser": "0" };
  const jar = parseCookie(cookie);
  const sid = jar.SAPISID || jar["__Secure-3PAPISID"];
  if (sid) {
    const ts = Math.floor(Date.now() / 1000);
    h.Authorization = "SAPISIDHASH " + ts + "_" + kino.crypto.hash("sha1", ts + " " + sid + " " + ORIGIN);
  }
  return h;
}

// ---------------------------------------------------------------------------------------------
// Llamadas a la API interna de YouTube Music
// ---------------------------------------------------------------------------------------------

function locale() {
  const parts = String(kino.lang || "en-US").split(/[-_]/);
  const region = parts[1] || "";
  return { hl: (parts[0] || "en").toLowerCase(), gl: /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : "US" };
}

function webClientVersion() {
  const d = new Date(Date.now() - 2 * 86400000);
  const p = (n) => String(n).padStart(2, "0");
  return "1." + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + ".01.00";
}

async function yt(endpoint, body, opts) {
  await null;
  const cookie = opts && opts.cookie !== undefined ? opts.cookie : savedCookie();
  const { hl, gl } = locale();
  const headers = Object.assign(
    {
      "Content-Type": "application/json",
      "User-Agent": WEB_UA,
      Accept: "*/*",
      Origin: ORIGIN,
      Referer: ORIGIN + "/",
      "X-Origin": ORIGIN,
    },
    authHeaders(cookie),
  );
  const payload = Object.assign(
    { context: { client: { clientName: "WEB_REMIX", clientVersion: webClientVersion(), hl, gl }, user: {} } },
    body || {},
  );
  const r = await kino.fetch(API + endpoint + "?prettyPrint=false", {
    method: "POST",
    headers,
    body: { json: payload },
    cookies: !cookie, // con sesión mandamos nuestra cabecera Cookie tal cual; sin sesión, el tarro normal
    timeoutMs: 20000,
  });
  if (r.status === 401 || (cookie && r.status === 403)) {
    throw kino.error("auth_required", "youtubei " + endpoint + " " + r.status, {
      userMessage: "La sesión de YouTube Music venció. Vuelve a copiar tus cookies en Ajustes.",
    });
  }
  if (r.status === 429) throw kino.error("rate_limited", "youtubei " + endpoint + " 429");
  if (!r.ok) throw kino.error("unavailable", "youtubei " + endpoint + " " + r.status);
  return r.json();
}

// ---------------------------------------------------------------------------------------------
// Lectura de las respuestas (recorren el JSON buscando por nombre: aguantan que YouTube mueva cosas)
// ---------------------------------------------------------------------------------------------

function findAll(root, key) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    if (Array.isArray(n)) {
      for (let i = n.length - 1; i >= 0; i--) stack.push(n[i]);
      continue;
    }
    const keys = Object.keys(n);
    for (let i = keys.length - 1; i >= 0; i--) {
      if (keys[i] === key) out.push(n[key]);
      else stack.push(n[keys[i]]);
    }
  }
  return out;
}

const txt = (t) => (t && (t.simpleText || (t.runs || []).map((r) => r.text).join(""))) || "";
const pageTypeOf = (ep) =>
  ep &&
  ep.browseEndpoint &&
  ep.browseEndpoint.browseEndpointContextSupportedConfigs &&
  ep.browseEndpoint.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig &&
  ep.browseEndpoint.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig.pageType;

function bigThumb(renderer) {
  const arr = (renderer && renderer.thumbnail && renderer.thumbnail.thumbnails) || [];
  let u = arr.length ? arr[arr.length - 1].url : "";
  if (!u) return undefined;
  if (u.startsWith("//")) u = "https:" + u;
  if (!/^https?:\/\//.test(u)) return undefined;
  return u.replace(/=w\d+-h\d+/, "=w544-h544").slice(0, 2048);
}

function seconds(s) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  return m ? (Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3]) : 0;
}

function artistsOf(runs) {
  return runs
    .filter((x) => T_ARTISTS.includes(pageTypeOf(x.navigationEndpoint)))
    .map((x) => x.text)
    .join(", ");
}

function yearOf(runs) {
  const y = runs.find((x) => /^(19|20)\d{2}$/.test(String(x.text).trim()));
  return y ? String(y.text).trim() : undefined;
}

// Una fila de lista (resultados de búsqueda, pistas de un álbum o de una lista).
function parseList(r) {
  const cols = (r.flexColumns || []).map(
    (c) => c.musicResponsiveListItemFlexColumnRenderer && c.musicResponsiveListItemFlexColumnRenderer.text,
  );
  const title = txt(cols[0]).trim();
  if (!title) return null;
  const sub = (cols[1] && cols[1].runs) || [];
  const fixed = r.fixedColumns && r.fixedColumns[0] && r.fixedColumns[0].musicResponsiveListItemFixedColumnRenderer;
  const secs = seconds(txt(fixed && fixed.text)) || seconds(sub.length ? sub[sub.length - 1].text : "");
  const base = {
    title,
    artist: artistsOf(sub),
    year: yearOf(sub),
    poster: bigThumb(r.thumbnail && r.thumbnail.musicThumbnailRenderer),
    minutes: secs ? Math.max(1, Math.round(secs / 60)) : undefined,
  };
  const browse = r.navigationEndpoint && r.navigationEndpoint.browseEndpoint;
  if (browse && browse.browseId) {
    const pt = pageTypeOf(r.navigationEndpoint);
    if (pt !== T_ALBUM && pt !== T_PLAYLIST) return null; // artistas, podcasts…: fuera de esta versión
    return Object.assign(base, { type: "browse", id: browse.browseId });
  }
  const overlay =
    r.overlay &&
    r.overlay.musicItemThumbnailOverlayRenderer &&
    r.overlay.musicItemThumbnailOverlayRenderer.content &&
    r.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer;
  const firstRun = (cols[0] && cols[0].runs && cols[0].runs[0]) || {};
  const videoId =
    (r.playlistItemData && r.playlistItemData.videoId) ||
    (overlay && overlay.playNavigationEndpoint && overlay.playNavigationEndpoint.watchEndpoint && overlay.playNavigationEndpoint.watchEndpoint.videoId) ||
    (firstRun.navigationEndpoint && firstRun.navigationEndpoint.watchEndpoint && firstRun.navigationEndpoint.watchEndpoint.videoId);
  if (!videoId) return null;
  return Object.assign(base, { type: "track", id: videoId });
}

// Un mosaico (Inicio, "Ver más", biblioteca).
function parseTwoRow(t) {
  const title = txt(t.title).trim();
  if (!title) return null;
  const sub = (t.subtitle && t.subtitle.runs) || [];
  const nav = t.navigationEndpoint || {};
  const base = {
    title,
    artist: artistsOf(sub),
    year: yearOf(sub),
    poster: bigThumb(t.thumbnailRenderer && t.thumbnailRenderer.musicThumbnailRenderer),
  };
  if (nav.watchEndpoint && nav.watchEndpoint.videoId) return Object.assign(base, { type: "track", id: nav.watchEndpoint.videoId });
  if (nav.browseEndpoint && nav.browseEndpoint.browseId) {
    const pt = pageTypeOf(nav);
    if (pt !== T_ALBUM && pt !== T_PLAYLIST) return null;
    return Object.assign(base, { type: "browse", id: nav.browseEndpoint.browseId });
  }
  return null;
}

const ITEM_PARSERS = { musicResponsiveListItemRenderer: parseList, musicTwoRowItemRenderer: parseTwoRow };

// Todas las pistas/álbumes/listas de un trozo de respuesta, en el orden en que aparecen.
function collectItems(root) {
  const out = [];
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    if (n.__yt) {
      const x = ITEM_PARSERS[n.__yt](n.v);
      if (x && !seen.has(x.type + x.id)) {
        seen.add(x.type + x.id);
        out.push(x);
      }
      continue;
    }
    if (Array.isArray(n)) {
      for (let i = n.length - 1; i >= 0; i--) stack.push(n[i]);
      continue;
    }
    const keys = Object.keys(n);
    for (let i = keys.length - 1; i >= 0; i--) {
      const v = n[keys[i]];
      stack.push(ITEM_PARSERS[keys[i]] ? { __yt: keys[i], v } : v);
    }
  }
  return out;
}

// La lista principal de una página (así no se cuelan las "sugerencias" del final de una lista).
function shelfOf(data) {
  for (const k of ["musicPlaylistShelfRenderer", "musicShelfRenderer", "musicPlaylistShelfContinuation", "musicShelfContinuation", "appendContinuationItemsAction"]) {
    const found = findAll(data, k)[0];
    if (found) return found;
  }
  return data;
}

function nextToken(root, fallback) {
  for (const scope of [root, fallback]) {
    if (!scope) continue;
    const a = findAll(scope, "nextContinuationData")[0];
    if (a && a.continuation) return a.continuation;
    const b = findAll(scope, "continuationCommand")[0];
    if (b && b.token) return b.token;
  }
  return null;
}

function headerOf(data) {
  const h = findAll(data, "musicResponsiveHeaderRenderer")[0] || findAll(data, "musicDetailHeaderRenderer")[0] || findAll(data, "musicImmersiveHeaderRenderer")[0];
  if (!h) return {};
  return { title: txt(h.title).trim() || undefined, poster: bigThumb(h.thumbnail && (h.thumbnail.musicThumbnailRenderer || h.thumbnail.croppedSquareThumbnailRenderer)) };
}

// ---------------------------------------------------------------------------------------------
// Items y refs
//   ref de una pista:   "t:<videoId>|<título>"   (el título solo sirve para rotular el capítulo)
//   ref de álbum/lista: "b:<browseId>"
// ---------------------------------------------------------------------------------------------

function trackRef(id, title) {
  return "t:" + id + (title ? "|" + encodeURIComponent(String(title).slice(0, 80)) : "");
}

function parseRef(ref) {
  const m = /^([tb]):([^|]+)(?:\|(.*))?$/.exec(String(ref || ""));
  if (!m) return null;
  let title = "";
  try {
    title = decodeURIComponent(m[3] || "");
  } catch (e) {
    title = "";
  }
  return { type: m[1], id: m[2], title };
}

function toItem(x) {
  const it = { title: x.title.slice(0, 200), kind: "music" };
  if (x.type === "track") {
    it.id = "t." + x.id;
    it.ref = trackRef(x.id, x.title);
  } else {
    it.id = "b." + x.id;
    it.ref = "b:" + x.id;
  }
  if (x.artist) it.artist = x.artist.slice(0, 200);
  if (x.poster) it.poster = x.poster;
  if (x.year) it.year = x.year;
  if (x.minutes) it.runtimeMinutes = x.minutes;
  return it;
}

const validId = (x) => /^[A-Za-z0-9._~-]{1,120}$/.test(x.id);

// ---------------------------------------------------------------------------------------------
// Capacidades
// ---------------------------------------------------------------------------------------------

export async function search(query) {
  const q = String((query && query.q) || "").trim();
  if (!q) return [];
  const data = await yt("search", { query: q });
  return collectItems(data).filter(validId).slice(0, 100).map(toItem);
}

async function libraryRows() {
  const rows = [];
  try {
    const liked = shelfOf(await yt("browse", { browseId: "VLLM" }));
    const items = collectItems(liked).filter((x) => x.type === "track" && validId(x)).slice(0, 60).map(toItem);
    if (items.length) rows.push({ id: "yt-liked", title: "Canciones que te gustan", items, ref: "b:VLLM", genre: "musica" });
  } catch (e) {
    kino.log("library liked:", e.code || "error");
  }
  try {
    const lists = collectItems(await yt("browse", { browseId: "FEmusic_liked_playlists" }))
      .filter((x) => x.type === "browse" && x.id !== "VLLM" && validId(x))
      .slice(0, 60)
      .map(toItem);
    if (lists.length) rows.push({ id: "yt-lists", title: "Tus listas", items: lists, ref: "b:FEmusic_liked_playlists", genre: "musica" });
  } catch (e) {
    kino.log("library lists:", e.code || "error");
  }
  return rows;
}

export async function home() {
  const rows = savedCookie() ? await libraryRows() : [];
  const data = await yt("browse", { browseId: "FEmusic_home" });
  for (const shelf of findAll(data, "musicCarouselShelfRenderer")) {
    if (rows.length >= 20) break;
    const header = shelf.header && shelf.header.musicCarouselShelfBasicHeaderRenderer;
    const title = txt(header && header.title).trim();
    if (!title) continue;
    const items = collectItems(shelf.contents).filter(validId).slice(0, 60).map(toItem);
    if (!items.length) continue;
    const row = { id: "yt" + rows.length, title: title.slice(0, 200), items, genre: "musica" };
    const more =
      header.moreContentButton &&
      header.moreContentButton.buttonRenderer &&
      header.moreContentButton.buttonRenderer.navigationEndpoint &&
      header.moreContentButton.buttonRenderer.navigationEndpoint.browseEndpoint;
    if (more && more.browseId) row.ref = "b:" + more.browseId;
    rows.push(row);
  }
  return rows;
}

export async function browse(ref, cursor) {
  const p = parseRef(ref);
  if (!p || p.type !== "b") return { items: [] };
  const data = cursor ? await yt("browse", { continuation: cursor }) : await yt("browse", { browseId: p.id });
  const shelf = shelfOf(data);
  const items = collectItems(shelf).filter(validId).slice(0, 100).map(toItem);
  const next = nextToken(shelf, data);
  return next && next.length <= 2048 ? { items, next } : { items };
}

export async function episodes(ref) {
  const p = parseRef(ref);
  if (!p) throw kino.error("not_found", "ref no válido");
  // Una pista suelta es un álbum de una sola pista.
  if (p.type === "t") return { episodes: [{ season: 1, number: 1, ref: String(ref), title: p.title || undefined }] };

  let data = await yt("browse", { browseId: p.id });
  const head = headerOf(data);
  const tracks = [];
  const seen = new Set();
  for (let page = 0; page < 6; page++) {
    const shelf = shelfOf(data);
    for (const x of collectItems(shelf)) {
      if (x.type === "track" && validId(x) && !seen.has(x.id)) {
        seen.add(x.id);
        tracks.push(x);
      }
    }
    const next = nextToken(shelf, data);
    if (!next || tracks.length >= 500 || page === 5) break;
    data = await yt("browse", { continuation: next });
  }
  if (!tracks.length) throw kino.error("not_found", "sin pistas", { userMessage: "No se encontraron canciones en esta lista." });
  return {
    series: { title: head.title, poster: head.poster },
    episodes: tracks.slice(0, 5000).map((x, i) => ({
      season: 1,
      number: i + 1,
      ref: trackRef(x.id, x.title),
      title: x.title.slice(0, 200),
      still: x.poster || head.poster,
      runtimeMinutes: x.minutes,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Reproducción
// ---------------------------------------------------------------------------------------------

const mimeOf = (f) => String(f.mimeType || "").split(";")[0].trim();

function describe(f) {
  const codec = /mp4a/.test(f.mimeType || "") ? "AAC" : /opus/.test(f.mimeType || "") ? "Opus" : "Audio";
  return (codec + " " + Math.round((f.bitrate || 0) / 1000) + " kbps").slice(0, 48);
}

function orderFormats(formats, pref) {
  const audio = (formats || []).filter(
    (f) => f && f.url && /^audio\//.test(f.mimeType || "") && !f.isDrc && (!f.audioTrack || f.audioTrack.audioIsDefault),
  );
  const byRate = (a, b) => (b.bitrate || 0) - (a.bitrate || 0);
  const aac = audio.filter((f) => /^audio\/mp4/.test(f.mimeType)).sort(byRate);
  const opus = audio.filter((f) => !/^audio\/mp4/.test(f.mimeType)).sort(byRate);
  return pref === "opus" ? opus.concat(aac) : aac.concat(opus);
}

async function playerFor(videoId) {
  const { hl, gl } = locale();
  let lastStatus = null;
  for (const c of CLIENTS) {
    let r;
    try {
      r = await kino.fetch(PLAYER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": c.ua,
          "X-YouTube-Client-Name": c.id,
          "X-YouTube-Client-Version": c.client.clientVersion,
          Origin: "https://www.youtube.com",
        },
        body: {
          json: {
            videoId,
            context: { client: Object.assign({}, c.client, { hl, gl }) },
            contentCheckOk: true,
            racyCheckOk: true,
          },
        },
        cookies: false,
        timeoutMs: 15000,
      });
    } catch (e) {
      kino.log("player", c.client.clientName, e.code || "error");
      if (e.code === "host_not_allowed") throw e;
      continue;
    }
    if (!r.ok) {
      kino.log("player", c.client.clientName, "http", r.status);
      continue;
    }
    const d = r.json();
    const status = d.playabilityStatus || {};
    if (status.status !== "OK") {
      lastStatus = status;
      kino.log("player", c.client.clientName, String(status.status));
      continue;
    }
    const sd = d.streamingData || {};
    const ordered = orderFormats(sd.adaptiveFormats, kino.config.get("quality"));
    if (!ordered.length) {
      kino.log("player", c.client.clientName, "sin formatos de audio con URL directa");
      continue;
    }
    return { client: c, sd, ordered };
  }
  const reason = String((lastStatus && lastStatus.reason) || "");
  if (/country|region|pa[ií]s|regi[oó]n/i.test(reason)) throw kino.error("geo_blocked", reason.slice(0, 150));
  if (lastStatus && lastStatus.status && lastStatus.status !== "LOGIN_REQUIRED" && lastStatus.status !== "ERROR") {
    throw kino.error("not_found", String(lastStatus.status), { userMessage: "Esta canción no se puede reproducir." });
  }
  throw kino.error("unavailable", "player sin audio", {
    userMessage: "YouTube no entregó esta canción por ahora. Prueba de nuevo en unos minutos.",
  });
}

// --- Camino 1: URL directa pedida a /player (rápido, pero YouTube lo bloquea a veces) ---------

async function resolveDirect(videoId) {
  const { client, sd, ordered } = await playerFor(videoId);
  const headers = { "User-Agent": client.ua };
  const first = ordered[0];
  const stream = { url: first.url, mime: mimeOf(first), headers, label: describe(first) };
  const ms = Number(first.approxDurationMs);
  if (Number.isFinite(ms) && ms > 0) stream.durationMs = Math.round(ms);
  const exp = Number(sd.expiresInSeconds);
  if (Number.isFinite(exp) && exp > 0) stream.expiresInSeconds = Math.max(30, Math.min(86400, Math.round(exp) - 300));
  const others = ordered.slice(1, 3).map((f) => ({ url: f.url, mime: mimeOf(f), headers, label: describe(f) }));
  if (others.length) stream.alternatives = others;
  return stream;
}

// --- Camino 2: el reproductor real de YouTube Music en el navegador oculto de Kino ------------
// La página genera la URL con todos sus tokens; Kino no la gasta y nos la entrega con los
// encabezados que la página usó. Hay que quitarle los parámetros de rango/trozo del reproductor web.

function queryParam(url, name) {
  const q = url.indexOf("?") < 0 ? "" : url.slice(url.indexOf("?") + 1);
  for (const part of q.split("&")) {
    const i = part.indexOf("=");
    if ((i < 0 ? part : part.slice(0, i)) === name) {
      try {
        return decodeURIComponent(i < 0 ? "" : part.slice(i + 1));
      } catch (e) {
        return "";
      }
    }
  }
  return "";
}

function stripParams(url, names) {
  const i = url.indexOf("?");
  if (i < 0) return url;
  const kept = url
    .slice(i + 1)
    .split("&")
    .filter((part) => !names.includes(part.split("=")[0]));
  return url.slice(0, i) + (kept.length ? "?" + kept.join("&") : "");
}

async function resolveViaBrowser(videoId) {
  let page;
  try {
    page = await kino.browser.capture("https://music.youtube.com/watch?v=" + videoId, {
      match: "videoplayback",
      timeoutMs: 22000,
    });
  } catch (e) {
    kino.log("browser capture:", e.code || "error");
    if (e.code === "blocked") {
      throw kino.error("unavailable", "capture blocked", { userMessage: "YouTube pidió verificar que eres una persona. Prueba de nuevo más tarde." });
    }
    if (e.code === "timeout" || e.code === "busy") {
      throw kino.error("unavailable", "capture " + e.code, { userMessage: "YouTube no respondió a tiempo. Prueba de nuevo." });
    }
    throw e;
  }
  const all = page.media || [];
  // Diagnóstico seguro: solo nombres de parámetros y valores que no identifican a nadie.
  for (const m of all.slice(0, 4)) {
    const keys = (m.url.indexOf("?") < 0 ? "" : m.url.slice(m.url.indexOf("?") + 1)).split("&").map((x) => x.split("=")[0]);
    kino.log(
      "captured:",
      "mime=" + queryParam(m.url, "mime"),
      "itag=" + queryParam(m.url, "itag"),
      "c=" + queryParam(m.url, "c"),
      "ump=" + queryParam(m.url, "ump"),
      "sabr=" + queryParam(m.url, "sabr"),
      "keys=" + keys.join(",").slice(0, 300),
    );
  }
  // Quitamos lo propio del reproductor web: trozos (range, rn, rbuf) y el envoltorio UMP (ump, srfvp).
  const clean = (u) => stripParams(u, ["range", "rn", "rbuf", "ump", "srfvp"]);
  const seen = new Set();
  const audio = all
    .filter((m) => m && /^audio\//.test(queryParam(m.url, "mime")))
    .map((m) => ({ url: clean(m.url), headers: m.headers || {} }))
    .filter((m) => (seen.has(m.url) ? false : (seen.add(m.url), true)));
  if (!audio.length) {
    kino.log("browser capture: sin audio entre", all.length, "peticiones");
    throw kino.error("unavailable", "capture sin audio", { userMessage: "YouTube no entregó esta canción por ahora. Prueba de nuevo en unos minutos." });
  }
  const describeCap = (m) => ({ url: m.url, mime: queryParam(m.url, "mime"), headers: m.headers, label: "YouTube Music" });
  const stream = describeCap(audio[0]);
  const dur = Number(queryParam(stream.url, "dur"));
  if (Number.isFinite(dur) && dur > 0) stream.durationMs = Math.round(dur * 1000);
  const expire = Number(queryParam(stream.url, "expire"));
  if (Number.isFinite(expire) && expire > 0) {
    stream.expiresInSeconds = Math.max(30, Math.min(86400, Math.round(expire - Date.now() / 1000) - 300));
  }
  if (audio.length > 1) stream.alternatives = audio.slice(1, 4).map(describeCap);
  return stream;
}

export async function resolve(ref) {
  const p = parseRef(ref);
  if (!p || p.type !== "t" || !/^[A-Za-z0-9_-]{11}$/.test(p.id)) throw kino.error("not_found", "ref de pista no válido");
  const canBrowse = !!(kino.browser && typeof kino.browser.capture === "function");
  const mode = kino.config.get("method") || "auto";
  let directError = null;
  if (mode !== "browser" || !canBrowse) {
    try {
      return await resolveDirect(p.id);
    } catch (e) {
      if (e.code === "host_not_allowed" || e.code === "not_found" || e.code === "geo_blocked" || !canBrowse) throw e;
      directError = e;
      kino.log("directo falló, uso el navegador oculto:", e.code || "error");
    }
  }
  try {
    return await resolveViaBrowser(p.id);
  } catch (e) {
    // Sin permiso o sin WebView en este aparato: mejor el error del camino directo.
    if (directError && (e.code === "not_allowed" || e.code === "browser_unavailable")) throw directError;
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Formulario de ajustes: estado de la sesión, cerrar sesión y validar al guardar
// ---------------------------------------------------------------------------------------------

async function accountName(cookie) {
  let data;
  try {
    data = await yt("account/account_menu", {}, { cookie });
  } catch (e) {
    if (e.code === "auth_required") return null;
    throw e;
  }
  const t = findAll(data, "accountName")[0];
  return t ? txt(t).trim().slice(0, 60) || null : null;
}

export async function settingsStatus() {
  const cookie = savedCookie();
  if (!cookie) return { linked: "Sin sesión: usas YouTube Music como invitado" };
  try {
    const name = await accountName(cookie);
    return { linked: name ? "Sesión iniciada como " + name : "Google no reconoce esta sesión: copia las cookies otra vez" };
  } catch (e) {
    return { linked: "No se pudo comprobar la sesión ahora" };
  }
}

export async function action(key) {
  await null;
  if (key !== "logout") return null;
  return { message: "Sesión cerrada", clearSettings: COOKIE_KEYS.slice() };
}

export async function validateSettings(values) {
  await null;
  const cookie = joinCookie(COOKIE_KEYS.map((k) => values[k]));
  if (!cookie) return null; // sin cookies: invitado
  const jar = parseCookie(cookie);
  if (!jar.SAPISID && !jar["__Secure-3PAPISID"]) {
    return { cookieA: "Falta la cookie SAPISID (o __Secure-3PAPISID). Revisa el README." };
  }
  const name = await accountName(cookie); // un fallo de red lanza: la persona puede "Guardar sin comprobar"
  if (!name) return { cookieA: "Google no reconoce esta sesión. Copia las cookies de nuevo." };
  return null;
}
