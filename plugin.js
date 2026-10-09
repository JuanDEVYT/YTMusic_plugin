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
const VERSION = "0.5.0";
// Cada ajuste "password" admite 500 caracteres como máximo (límite de Kino): por eso 4 partes = 2000.
const COOKIE_KEYS = ["cookieA", "cookieB", "cookieC", "cookieD"];

// Clientes para /player, en orden de preferencia. VISIONOS entrega URLs directas de audio que googlevideo
// sirve completas y por rangos abiertos sin PO token (el que usa yt-dlp); IOS y ANDROID_VR piden ese token para
// las URLs https: sin él solo dejan pasar un rango acotado de ~1 MB y el reproductor, que pide `bytes=0-`,
// recibe 403. De IOS se usa el manifiesto HLS. Lo que caduca está aquí.
const CLIENTS = [
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    id: "101",
    client: {
      clientName: "VISIONOS",
      clientVersion: "1.02",
      deviceMake: "Apple",
      deviceModel: "RealityDevice17,1",
      osName: "visionOS",
      osVersion: "26.5.23O471",
    },
  },
  {
    ua: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    id: "5",
    hls: true,
    client: {
      clientName: "IOS",
      clientVersion: "20.10.4",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82",
    },
  },
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
// Filtros de búsqueda de YouTube Music (el parámetro `params` de /search).
const SEARCH_SONGS = "EgWKAQIIAWoMEA4QChADEAQQCRAF";
const SEARCH_ALBUMS = "EgWKAQIYAWoMEA4QChADEAQQCRAF";
const SEARCH_LISTS = "EgeKAQQoADgBagwQDhAKEAMQBBAJEAU%3D";
const SEARCH_ARTISTS = "EgWKAQIgAWoMEA4QChADEAQQCRAF";
const T_ARTIST = "MUSIC_PAGE_TYPE_ARTIST";
const ARTIST_TYPES = [T_ARTIST, "MUSIC_PAGE_TYPE_LIBRARY_ARTIST"];
const T_ARTISTS = [T_ARTIST, "MUSIC_PAGE_TYPE_USER_CHANNEL"];
const GREY_OUT = "MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT";

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

// Continuaciones (siguiente página): el token va en el cuerpo y también en la dirección, como hace la web.
function contParams(token) {
  const t = String(token);
  const e = /^[A-Za-z0-9%_.~=-]+$/.test(t) ? t : encodeURIComponent(t);
  return "&ctoken=" + e + "&continuation=" + e;
}

const authErr = (endpoint, status) =>
  kino.error("auth_required", "youtubei " + endpoint + " " + status, {
    userMessage: "La sesión de YouTube Music venció. Vuelve a copiar tus cookies en Ajustes.",
  });

// opts: { cookie, timeoutMs (15 s por defecto), params (texto extra para la dirección) }
async function yt(endpoint, body, opts) {
  await null;
  const o = opts || {};
  const cookie = o.cookie !== undefined ? o.cookie : savedCookie();
  const { hl, gl } = locale();
  const payload = Object.assign(
    { context: { client: { clientName: "WEB_REMIX", clientVersion: webClientVersion(), hl, gl }, user: {} } },
    body || {},
  );
  const call = (ck) =>
    kino.fetch(API + endpoint + "?prettyPrint=false" + (o.params || ""), {
      method: "POST",
      headers: Object.assign(
        {
          "Content-Type": "application/json",
          "User-Agent": WEB_UA,
          Accept: "*/*",
          Origin: ORIGIN,
          Referer: ORIGIN + "/",
          "X-Origin": ORIGIN,
        },
        authHeaders(ck),
      ),
      body: { json: payload },
      cookies: !ck, // con sesión mandamos nuestra cabecera Cookie tal cual; sin sesión, el tarro normal
      timeoutMs: o.timeoutMs || 15000,
    });
  const r = await call(cookie);
  if (r.status === 401) throw authErr(endpoint, r.status);
  if (cookie && r.status === 403) {
    // Un 403 con sesión puede ser la sesión o puede ser YouTube. La misma petición como invitado lo aclara.
    let guestOk = false;
    try {
      guestOk = (await call("")).ok;
    } catch (e) {}
    if (guestOk) throw authErr(endpoint, r.status);
    throw kino.error("unavailable", "youtubei " + endpoint + " 403", {
      userMessage: "YouTube rechazó la petición por ahora. Prueba de nuevo en unos minutos.",
    });
  }
  if (r.status === 429) throw kino.error("rate_limited", "youtubei " + endpoint + " 429");
  if (!r.ok) throw kino.error("unavailable", "youtubei " + endpoint + " " + r.status);
  return r.json();
}

// La página siguiente de algo que ya se pidió (token de continuación).
function ytCont(endpoint, token, opts) {
  return yt(endpoint, { continuation: token }, Object.assign({}, opts, { params: contParams(token) }));
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

const explicitOf = (badges) =>
  (badges || []).some((b) => {
    const i = b && b.musicInlineBadgeRenderer && b.musicInlineBadgeRenderer.icon;
    return !!i && i.iconType === "MUSIC_EXPLICIT_BADGE";
  });

// "Álbum", "Sencillo" o "EP": lo dice la primera palabra del subtítulo (si no, el rótulo por defecto).
function kindLabel(sub, fallback) {
  const f = String((sub[0] && sub[0].text) || "").trim();
  if (!/^(sencillo|single|ep|[áa]lbum)$/i.test(f)) return fallback;
  return f.toLowerCase() === "ep" ? "EP" : f.charAt(0).toUpperCase() + f.slice(1).toLowerCase();
}

// Un clip o video musical (no la versión de estudio): se rotula "Video".
function isVideoWatch(we) {
  const c = we && we.watchEndpointMusicSupportedConfigs && we.watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig;
  return !!c && /OMV|UGC|OFFICIAL_SOURCE/.test(String(c.musicVideoType || ""));
}

// Una fila de lista (resultados de búsqueda, pistas de un álbum o de una lista).
function parseList(r) {
  if (r.musicItemRendererDisplayPolicy === GREY_OUT) return null; // no disponible: sale gris y no suena
  const cols = (r.flexColumns || []).map(
    (c) => c.musicResponsiveListItemFlexColumnRenderer && c.musicResponsiveListItemFlexColumnRenderer.text,
  );
  const title = txt(cols[0]).trim();
  if (!title) return null;
  const sub = (cols[1] && cols[1].runs) || [];
  const fixed = r.fixedColumns && r.fixedColumns[0] && r.fixedColumns[0].musicResponsiveListItemFixedColumnRenderer;
  const secs = seconds(txt(fixed && fixed.text)) || seconds(sub.length ? sub[sub.length - 1].text : "");
  const albumRun = sub.find((x) => pageTypeOf(x.navigationEndpoint) === T_ALBUM);
  const base = {
    title,
    artist: artistsOf(sub),
    year: yearOf(sub),
    poster: bigThumb(r.thumbnail && r.thumbnail.musicThumbnailRenderer),
    minutes: secs ? Math.max(1, Math.round(secs / 60)) : undefined,
    explicit: explicitOf(r.badges),
    album: albumRun ? String(albumRun.text).trim() : undefined,
  };
  const browse = r.navigationEndpoint && r.navigationEndpoint.browseEndpoint;
  if (browse && browse.browseId) {
    const pt = pageTypeOf(r.navigationEndpoint);
    if (ARTIST_TYPES.includes(pt)) {
      return Object.assign(base, { type: "artist", id: browse.browseId, artist: "", year: undefined, minutes: undefined, label: "Artista" });
    }
    if (pt !== T_ALBUM && pt !== T_PLAYLIST) return null; // podcasts, perfiles…: fuera de esta versión
    return Object.assign(base, { type: "browse", id: browse.browseId, pt, label: pt === T_ALBUM ? kindLabel(sub, "Álbum") : "Lista" });
  }
  const overlay =
    r.overlay &&
    r.overlay.musicItemThumbnailOverlayRenderer &&
    r.overlay.musicItemThumbnailOverlayRenderer.content &&
    r.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer;
  const we = overlay && overlay.playNavigationEndpoint && overlay.playNavigationEndpoint.watchEndpoint;
  const firstRun = (cols[0] && cols[0].runs && cols[0].runs[0]) || {};
  const videoId =
    (r.playlistItemData && r.playlistItemData.videoId) ||
    (we && we.videoId) ||
    (firstRun.navigationEndpoint && firstRun.navigationEndpoint.watchEndpoint && firstRun.navigationEndpoint.watchEndpoint.videoId);
  if (!videoId) return null;
  return Object.assign(base, { type: "track", id: videoId, video: isVideoWatch(we) });
}

// Un mosaico (Inicio, "Ver más", biblioteca, página de un artista).
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
    explicit: explicitOf(t.subtitleBadges),
  };
  if (nav.watchEndpoint && nav.watchEndpoint.videoId) {
    return Object.assign(base, { type: "track", id: nav.watchEndpoint.videoId, video: isVideoWatch(nav.watchEndpoint) });
  }
  if (nav.browseEndpoint && nav.browseEndpoint.browseId) {
    const pt = pageTypeOf(nav);
    if (ARTIST_TYPES.includes(pt)) {
      return Object.assign(base, { type: "artist", id: nav.browseEndpoint.browseId, artist: "", year: undefined, label: "Artista" });
    }
    if (pt !== T_ALBUM && pt !== T_PLAYLIST) return null;
    return Object.assign(base, { type: "browse", id: nav.browseEndpoint.browseId, pt, label: pt === T_ALBUM ? kindLabel(sub, "Álbum") : "Lista" });
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

// Cabecera de un álbum, lista o artista: título, portada, año y descripción.
function headerOf(data) {
  const h =
    findAll(data, "musicResponsiveHeaderRenderer")[0] ||
    findAll(data, "musicDetailHeaderRenderer")[0] ||
    findAll(data, "musicImmersiveHeaderRenderer")[0];
  if (!h) return {};
  let d = h.description;
  if (d && d.musicDescriptionShelfRenderer) d = d.musicDescriptionShelfRenderer.description;
  let overview = txt(d).trim();
  if (!overview) {
    overview = [txt(h.subtitle), txt(h.secondSubtitle)].map((s) => s.trim()).filter(Boolean).join(" · ");
  }
  const sub = (h.subtitle && h.subtitle.runs) || [];
  return {
    title: txt(h.title).trim() || undefined,
    poster: bigThumb(h.thumbnail && (h.thumbnail.musicThumbnailRenderer || h.thumbnail.croppedSquareThumbnailRenderer)),
    year: yearOf(sub),
    overview: overview ? overview.slice(0, 2000) : undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Items y refs
//   ref de una pista:   "t:<videoId>|<título>"   (el título solo sirve para rotular el capítulo)
//   ref de álbum/lista: "b:<browseId>"  (o "b:<browseId>@<params>" para los estados de ánimo y géneros)
//   ref de artista:     "a:<browseId>"
// ---------------------------------------------------------------------------------------------

function trackRef(id, title) {
  return "t:" + id + (title ? "|" + encodeURIComponent(String(title).slice(0, 80)) : "");
}

function parseRef(ref) {
  const m = /^([tba]):([^|@]+)(?:@([^|]*))?(?:\|(.*))?$/.exec(String(ref || ""));
  if (!m) return null;
  let title = "";
  try {
    title = decodeURIComponent(m[4] || "");
  } catch (e) {
    title = "";
  }
  return { type: m[1], id: m[2], params: m[3] || "", title };
}

function toItem(x) {
  const it = { title: x.title.slice(0, 200), kind: "music" };
  const badges = [];
  if (x.type === "track") {
    it.id = "t." + x.id;
    it.ref = trackRef(x.id, x.title);
    badges.push(x.video ? "Video" : "Canción");
  } else if (x.type === "artist") {
    it.id = "a." + x.id;
    it.ref = "a:" + x.id;
    badges.push("Artista");
  } else {
    it.id = "b." + x.id;
    it.ref = "b:" + x.id;
    if (x.label) badges.push(x.label);
  }
  if (x.explicit) badges.push("Explícito");
  it.badges = badges.slice(0, 3);
  if (x.artist) it.artist = x.artist.slice(0, 200);
  if (x.poster) it.poster = x.poster;
  if (x.year) it.year = x.year;
  if (x.minutes) it.runtimeMinutes = x.minutes;
  if (x.type === "track" && x.album) it.overview = ("Álbum: " + x.album).slice(0, 2000);
  return it;
}

// Ajuste "Ocultar contenido explícito".
function hideExplicit() {
  return kino.config.get("hideExplicit") === true;
}

// Se queda lo que tiene un id válido y, si la persona lo pidió, no es explícito.
const keep = (x) => /^[A-Za-z0-9._~-]{1,120}$/.test(x.id) && !(x.explicit && hideExplicit());

// ---------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------
// Capacidades
// ---------------------------------------------------------------------------------------------

// Una página de YouTube Music vista como filas (las repisas "carrusel" de Inicio, Explorar, Tendencias…).
function rowsFromShelves(data, prefix, max, fallbackTitle, start) {
  const rows = [];
  const base = start || 0;
  for (const shelf of findAll(data, "musicCarouselShelfRenderer")) {
    if (rows.length >= max) break;
    const header = shelf.header && shelf.header.musicCarouselShelfBasicHeaderRenderer;
    const title = txt(header && header.title).trim();
    if (!title) continue;
    const items = collectItems(shelf.contents).filter(keep).slice(0, 60).map(toItem);
    if (!items.length) continue;
    const row = { id: (prefix + (base + rows.length)).slice(0, 60), title: title.slice(0, 200), items, genre: "musica" };
    const more =
      header.moreContentButton &&
      header.moreContentButton.buttonRenderer &&
      header.moreContentButton.buttonRenderer.navigationEndpoint &&
      header.moreContentButton.buttonRenderer.navigationEndpoint.browseEndpoint;
    if (more && more.browseId) {
      const ref = "b:" + more.browseId + (more.params ? "@" + more.params : "");
      if (ref.length <= 4000) row.ref = ref;
    }
    rows.push(row);
  }
  // Páginas en cuadrícula (p. ej. "Nuevos álbumes"): una sola fila con todo lo que haya.
  if (!rows.length && fallbackTitle) {
    const items = collectItems(data).filter(keep).slice(0, 60).map(toItem);
    if (items.length) rows.push({ id: prefix + "0", title: fallbackTitle, items, genre: "musica" });
  }
  return rows;
}

// El token para pedir más filas de una página de secciones (Inicio, Explorar…).
function sectionToken(data) {
  const sl = findAll(data, "sectionListContinuation")[0] || findAll(data, "sectionListRenderer")[0];
  return sl ? nextToken(sl) : null;
}

// Una llamada que puede fallar sin tumbar al resto (se anota en el Registro, nunca con datos personales).
async function safe(label, fn, fallback) {
  try {
    return await fn();
  } catch (e) {
    kino.log(label + ":", (e && e.code) || "error");
    return fallback;
  }
}

// Filas de una página de secciones. La primera respuesta de YouTube Music trae pocas repisas; el resto
// llega por continuación (como mucho 2 peticiones más y sin pasar del plazo).
async function loadRows(browseId, prefix, max, fallbackTitle, deadline) {
  let data = await yt("browse", { browseId });
  let rows = rowsFromShelves(data, prefix, max, fallbackTitle);
  for (let i = 0; i < 2 && rows.length < max && Date.now() < deadline; i++) {
    const tok = sectionToken(data);
    if (!tok) break;
    const more = await safe("rows continuation", () => ytCont("browse", tok, { timeoutMs: 8000 }), null);
    if (!more) break;
    data = more;
    rows = rows.concat(rowsFromShelves(more, prefix, max - rows.length, "", rows.length));
  }
  return rows;
}

const norm = (s) => {
  let t = String(s || "");
  try {
    t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  } catch (e) {}
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
};

// -- Búsqueda ----------------------------------------------------------------------------------
// Pide a la vez las búsquedas filtradas (canciones, álbumes, listas, artistas) y la general, y las junta
// sin repetir: canciones, álbumes, listas y artistas (un artista que se llama igual que la búsqueda va
// primero). "Ver más resultados" sigue con las siguientes canciones (cursor "s:<token>").
// Cada petición espera como mucho 10 s: Kino corta la búsqueda a los 15.
export async function search(query) {
  const q = String((query && query.q) || "").trim();
  if (!q) return [];
  // Dentro de una página de "Ver más": que Kino filtre los títulos ya cargados.
  if (query && query.within) return null;
  if (query && query.cursor) return searchMore(String(query.cursor));
  const run = (label, params) =>
    safe(label, () => yt("search", params ? { query: q, params } : { query: q }, { timeoutMs: 10000 }), null);
  const [songs, albums, lists, artists, general] = await Promise.all([
    run("search songs", SEARCH_SONGS),
    run("search albums", SEARCH_ALBUMS),
    run("search lists", SEARCH_LISTS),
    run("search artists", SEARCH_ARTISTS),
    run("search general", ""),
  ]);
  if (!songs && !albums && !lists && !artists && !general) throw kino.error("unavailable", "search sin respuesta");
  const pick = (d, n) => (d ? collectItems(d).filter(keep).slice(0, n) : []);
  const artistList = pick(artists, 6);
  const exact = artistList.length > 0 && norm(artistList[0].title) === norm(q);
  const out = [];
  const seen = new Set();
  const all = [].concat(
    exact ? artistList.slice(0, 1) : [],
    pick(songs, 25),
    pick(albums, 15),
    pick(lists, 10),
    exact ? artistList.slice(1) : artistList,
    pick(general, 60),
  );
  for (const x of all) {
    const k = x.type + x.id;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
    if (out.length >= 100) break;
  }
  const items = out.map(toItem);
  const tok = songs ? nextToken(shelfOf(songs), songs) : null;
  return tok && tok.length + 2 <= 2048 ? { items, next: "s:" + tok } : items;
}

async function searchMore(cursor) {
  const m = /^s:(.+)$/.exec(cursor);
  if (!m) return { items: [] };
  const data = await ytCont("search", m[1], { timeoutMs: 10000 });
  const shelf = shelfOf(data);
  const items = collectItems(shelf).filter(keep).slice(0, 100).map(toItem);
  const tok = nextToken(shelf, data);
  return tok && tok.length + 2 <= 2048 ? { items, next: "s:" + tok } : { items };
}

// -- Biblioteca (con sesión) ---------------------------------------------------------------------
async function libraryRows() {
  const rows = [];
  const [likedData, listsData, historyData] = await Promise.all([
    safe("library liked", () => yt("browse", { browseId: "VLLM" }), null),
    safe("library lists", () => yt("browse", { browseId: "FEmusic_liked_playlists" }), null),
    safe("library history", () => yt("browse", { browseId: "FEmusic_history" }), null),
  ]);
  if (likedData) {
    const items = collectItems(shelfOf(likedData)).filter((x) => x.type === "track" && keep(x)).slice(0, 60).map(toItem);
    if (items.length) rows.push({ id: "yt-liked", title: "Canciones que te gustan", items, ref: "b:VLLM", genre: "musica" });
  }
  if (listsData) {
    const items = collectItems(listsData).filter((x) => x.type === "browse" && x.id !== "VLLM" && keep(x)).slice(0, 60).map(toItem);
    if (items.length) rows.push({ id: "yt-lists", title: "Tus listas", items, ref: "b:FEmusic_liked_playlists", genre: "musica" });
  }
  if (historyData) {
    const items = collectItems(historyData).filter((x) => x.type === "track" && keep(x)).slice(0, 40).map(toItem);
    if (items.length) rows.push({ id: "yt-history", title: "Escuchado hace poco", items, ref: "b:FEmusic_history", genre: "musica" });
  }
  return rows;
}

// Tu biblioteca y las filas de YouTube Music se piden a la vez. Si solo falla la segunda, queda la biblioteca.
export async function home() {
  const deadline = Date.now() + 14000;
  let mainErr = null;
  const [lib, main] = await Promise.all([
    savedCookie() ? libraryRows() : Promise.resolve([]),
    loadRows("FEmusic_home", "yt", 20, "", deadline).catch((e) => {
      mainErr = e;
      return [];
    }),
  ]);
  const rows = lib.concat(main.slice(0, 20 - lib.length));
  if (!rows.length && mainErr) throw mainErr;
  return rows;
}

// -- Sección propia de YouTube Music (pestañas, destacado y filas) ---------------------------------
const TAB_HOME = "inicio";
const TAB_EXPLORE = "explorar";
const TAB_CHARTS = "tendencias";
const TAB_LIBRARY = "biblioteca";

function sectionTabs() {
  const tabs = [
    { id: TAB_HOME, label: "Para ti" },
    { id: TAB_EXPLORE, label: "Explorar" },
    { id: TAB_CHARTS, label: "Tendencias" },
  ];
  if (savedCookie()) tabs.push({ id: TAB_LIBRARY, label: "Biblioteca" });
  return tabs;
}

// El destacado del día: una pista, álbum o lista con portada, que cambia cada 24 h.
function heroOf(rows) {
  const pool = [];
  for (const r of rows) for (const it of r.items) if (it.poster) pool.push(it);
  if (!pool.length) return null;
  const it = pool[Math.floor(Date.now() / 86400000) % Math.min(pool.length, 12)];
  const hero = { title: it.title.slice(0, 200), image: it.poster };
  hero.text = (it.artist ? "De " + it.artist + ". " : "") + "Tu selección de hoy en YouTube Music.";
  hero.text = hero.text.slice(0, 300);
  return hero;
}

export async function section(arg) {
  const tabs = sectionTabs();
  const wanted = arg && arg.tab;
  const tab = tabs.some((t) => t.id === wanted) ? wanted : TAB_HOME;
  const deadline = Date.now() + 14000;
  let rows = [];
  if (tab === TAB_HOME) {
    rows = await loadRows("FEmusic_home", "inicio", 14, "", deadline);
  } else if (tab === TAB_EXPLORE) {
    const [explore, releases] = await Promise.all([
      loadRows("FEmusic_explore", "explorar", 12, "", deadline),
      safe("explore releases", () => yt("browse", { browseId: "FEmusic_new_releases_albums" }), null),
    ]);
    rows = releases ? rowsFromShelves(releases, "nuevos", 1, "Nuevos álbumes") : [];
    rows = rows.concat(explore);
  } else if (tab === TAB_CHARTS) {
    rows = await loadRows("FEmusic_charts", "tendencias", 10, "", deadline);
  } else if (tab === TAB_LIBRARY) {
    rows = await libraryRows();
  }
  const answer = { tabs, tab, rows: rows.slice(0, 20) };
  const hero = tab === TAB_LIBRARY ? null : heroOf(answer.rows);
  if (hero) answer.hero = hero;
  return answer;
}

// -- Categorías: los "estados de ánimo y géneros" de YouTube Music -------------------------------
export async function categories() {
  const data = await safe("categories", () => yt("browse", { browseId: "FEmusic_moods_and_genres" }), null);
  if (!data) return [];
  const out = [];
  const seen = new Set();
  for (const b of findAll(data, "musicNavigationButtonRenderer")) {
    const title = txt(b.buttonText).trim();
    const ep = b.clickCommand && b.clickCommand.browseEndpoint;
    if (!title || !ep || !ep.browseId || seen.has(title)) continue;
    seen.add(title);
    const ref = "b:" + ep.browseId + (ep.params ? "@" + ep.params : "");
    if (ref.length > 4000) continue;
    out.push({ id: "m" + kino.crypto.hash("md5", ref).slice(0, 12), title: title.slice(0, 40), ref });
    if (out.length >= 24) break;
  }
  return out;
}

export async function browse(ref, cursor) {
  const p = parseRef(ref);
  if (!p || p.type !== "b") return { items: [] };
  const data = cursor
    ? await ytCont("browse", cursor)
    : await yt("browse", p.params ? { browseId: p.id, params: p.params } : { browseId: p.id });
  const shelf = shelfOf(data);
  const items = collectItems(shelf).filter(keep).slice(0, 100).map(toItem);
  const next = nextToken(shelf, data);
  return next && next.length <= 2048 ? { items, next } : { items };
}

// Las pistas de una página (álbum, lista o "todas las canciones" de un artista), con sus páginas siguientes.
async function trackPages(data, maxPages, deadline) {
  const tracks = [];
  const seen = new Set();
  for (let page = 0; page < maxPages; page++) {
    const shelf = shelfOf(data);
    for (const x of collectItems(shelf)) {
      if (x.type === "track" && keep(x) && !seen.has(x.id)) {
        seen.add(x.id);
        tracks.push(x);
      }
    }
    const next = nextToken(shelf, data);
    if (!next || tracks.length >= 500 || page === maxPages - 1 || Date.now() > deadline) break;
    data = await ytCont("browse", next, { timeoutMs: 8000 });
  }
  return tracks;
}

const episodeOf = (x, i, head) => ({
  season: 1,
  number: i + 1,
  ref: trackRef(x.id, x.title),
  title: x.title.slice(0, 200),
  still: x.poster || head.poster,
  runtimeMinutes: x.minutes,
  overview: x.album ? ("Álbum: " + x.album).slice(0, 2000) : undefined,
});

// La página de un artista: sus canciones como pistas y sus álbumes y sencillos como "temporadas"
// (cada una se abre como su propio álbum).
async function artistEpisodes(id, deadline) {
  const data = await yt("browse", { browseId: id });
  const head = headerOf(data);
  const shelf = findAll(data, "musicShelfRenderer")[0];
  let tracks = await trackPages(data, 1, deadline);
  const bottom = shelf && shelf.bottomEndpoint && shelf.bottomEndpoint.browseEndpoint;
  if (bottom && bottom.browseId && Date.now() < deadline) {
    const all = await safe(
      "artist songs",
      () => yt("browse", bottom.params ? { browseId: bottom.browseId, params: bottom.params } : { browseId: bottom.browseId }, { timeoutMs: 8000 }),
      null,
    );
    if (all) {
      const full = await trackPages(all, 3, deadline);
      if (full.length > tracks.length) tracks = full;
    }
  }
  // Álbumes y sencillos: los de la página y los de sus botones "Ver todo".
  const albums = [];
  const seenAlbum = new Set();
  const addAlbums = (root) => {
    for (const x of collectItems(root)) {
      if (albums.length >= 49) break;
      if (x.type !== "browse" || x.pt !== T_ALBUM || !keep(x) || seenAlbum.has(x.id)) continue;
      seenAlbum.add(x.id);
      albums.push(x);
    }
  };
  addAlbums(data);
  const more = [];
  for (const sh of findAll(data, "musicCarouselShelfRenderer")) {
    const hdr = sh.header && sh.header.musicCarouselShelfBasicHeaderRenderer;
    const ep =
      hdr &&
      hdr.moreContentButton &&
      hdr.moreContentButton.buttonRenderer &&
      hdr.moreContentButton.buttonRenderer.navigationEndpoint &&
      hdr.moreContentButton.buttonRenderer.navigationEndpoint.browseEndpoint;
    if (ep && ep.browseId && collectItems(sh.contents).some((x) => x.type === "browse" && x.pt === T_ALBUM)) more.push(ep);
  }
  if (more.length && Date.now() < deadline) {
    const pages = await Promise.all(
      more.slice(0, 2).map((ep) =>
        safe("artist albums", () => yt("browse", ep.params ? { browseId: ep.browseId, params: ep.params } : { browseId: ep.browseId }, { timeoutMs: 8000 }), null),
      ),
    );
    for (const pg of pages) if (pg) addAlbums(pg);
  }
  if (!tracks.length && albums.length) {
    const d = await safe("artist first album", () => yt("browse", { browseId: albums[0].id }, { timeoutMs: 8000 }), null);
    if (d) tracks = await trackPages(d, 1, deadline);
  }
  if (!tracks.length) throw kino.error("not_found", "artista sin pistas", { userMessage: "No se encontraron canciones de este artista." });
  const out = {
    series: { title: head.title, poster: head.poster, backdrop: head.poster, overview: head.overview },
    episodes: tracks.slice(0, 500).map((x, i) => episodeOf(x, i, head)),
  };
  if (albums.length) {
    out.seasons = [{ id: "a." + id, ref: "a:" + id, title: "Canciones", current: true }].concat(
      albums.map((a) => ({ id: "b." + a.id, ref: "b:" + a.id, title: a.title.slice(0, 200) })),
    );
  }
  return out;
}

export async function episodes(ref) {
  const p = parseRef(ref);
  if (!p) throw kino.error("not_found", "ref no válido");
  // Una pista suelta es un álbum de una sola pista.
  if (p.type === "t") return { episodes: [{ season: 1, number: 1, ref: String(ref), title: p.title || undefined }] };
  const deadline = Date.now() + 14000;
  if (p.type === "a") return artistEpisodes(p.id, deadline);

  const data = await yt("browse", { browseId: p.id });
  const head = headerOf(data);
  const tracks = await trackPages(data, 6, deadline);
  if (!tracks.length) throw kino.error("not_found", "sin pistas", { userMessage: "No se encontraron canciones en esta lista." });
  return {
    series: { title: head.title, poster: head.poster, backdrop: head.poster, overview: head.overview, year: head.year },
    episodes: tracks.slice(0, 5000).map((x, i) => episodeOf(x, i, head)),
  };
}

// ---------------------------------------------------------------------------------------------
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

// Identificador de visitante (lo piden los clientes móviles para no parecer un robot). Se guarda 6 h.
async function visitorData() {
  try {
    const cached = kino.storage.get("visitorData");
    if (cached) return cached;
    const data = await yt("visitor_id", {}, { cookie: "" });
    const v = findAll(data, "visitorData")[0];
    if (typeof v === "string" && v.length > 5 && v.length < 600) {
      kino.storage.set("visitorData", v, { ttlMs: 6 * 3600 * 1000 });
      return v;
    }
  } catch (e) {
    kino.log("visitorData:", e.code || "error");
  }
  return "";
}

// Prueba una URL de audio (o el manifiesto HLS) desde el propio plugin: 2 bytes, mismos encabezados que usará el reproductor.
async function probeUrl(url, ua, isHls, clen) {
  // Un rango de 2 bytes al principio pasa siempre: lo que googlevideo rechaza sin PO token es lo que está
  // más allá de ~1 MB. Se prueba pasado ese punto, que es lo que hará el reproductor.
  const at = Number.isFinite(clen) && clen > 1200000 ? Math.min(1500000, clen - 2) : 0;
  try {
    const r = await kino.fetch(url, {
      headers: Object.assign({ "User-Agent": ua }, isHls ? {} : { Range: "bytes=" + at + "-" + (at + 1) }),
      cookies: false,
      timeoutMs: 8000,
    });
    return r.status;
  } catch (e) {
    return String(e.code || "error");
  }
}

// Último estado de reproducción que dio YouTube en esta llamada (para decidir sin leer textos traducidos).
let lastPlayability = null;

// Aviso al tablero de errores de Kino (solo si el plugin declara telemetría y esta versión de Kino lo trae).
function report(area, detail) {
  try {
    if (kino.log && typeof kino.log.report === "function") kino.log.report(area, detail || "");
  } catch (e) {}
}

async function playerFor(videoId) {
  lastPlayability = null;
  const { hl, gl } = locale();
  const vd = await visitorData();
  let lastStatus = null;
  let fallback = null;
  for (const c of CLIENTS) {
    let r;
    try {
      const headers = {
        "Content-Type": "application/json",
        "User-Agent": c.ua,
        "X-YouTube-Client-Name": c.id,
        "X-YouTube-Client-Version": c.client.clientVersion,
        Origin: "https://www.youtube.com",
      };
      if (vd) headers["X-Goog-Visitor-Id"] = vd;
      r = await kino.fetch(PLAYER_URL, {
        method: "POST",
        headers,
        body: {
          json: {
            videoId,
            context: { client: Object.assign({}, c.client, { hl, gl }, vd ? { visitorData: vd } : {}) },
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
      lastPlayability = { status: String(status.status || "") };
      const sub = JSON.stringify(status.errorScreen || {}).match(/"text":"([^"]{1,120})"/);
      kino.log("player", c.client.clientName, String(status.status), "reason=" + String(status.reason || "").slice(0, 120), sub ? "sub=" + sub[1] : "");
      continue;
    }
    const sd = d.streamingData || {};
    const ordered = orderFormats(sd.adaptiveFormats, kino.config.get("quality"));
    const hlsUrl = c.hls && typeof sd.hlsManifestUrl === "string" && /^https:\/\//.test(sd.hlsManifestUrl) ? sd.hlsManifestUrl : "";
    if (!ordered.length && !hlsUrl) {
      kino.log("player", c.client.clientName, "sin audio utilizable");
      continue;
    }
    kino.log("player", c.client.clientName, "OK", hlsUrl ? "hls" : "", ordered.length + " formatos de audio");
    const found = { client: c, sd, ordered, hlsUrl };
    // Diagnóstico sin datos personales: a qué familia de IP está atada la URL (v4/v6), el cliente y los nombres de los parámetros.
    const sample = (ordered[0] && ordered[0].url) || "";
    const ipParam = queryParam(sample, "ip");
    kino.log(
      "url:",
      "ip=" + (ipParam ? (ipParam.indexOf(":") >= 0 ? "v6" : "v4") : "?"),
      "c=" + queryParam(sample, "c"),
      "ratebypass=" + (queryParam(sample, "ratebypass") ? "si" : "no"),
      "pot=" + (queryParam(sample, "pot") ? "si" : "no"),
      "keys=" + (sample.indexOf("?") < 0 ? "" : sample.slice(sample.indexOf("?") + 1).split("&").map((x) => x.split("=")[0]).join(",")).slice(0, 300),
    );
    // ¿Sirve de verdad? Se prueba la primera URL; si googlevideo la rechaza, se sigue con el cliente siguiente.
    const st = await probeUrl(hlsUrl || ordered[0].url, c.ua, !!hlsUrl, Number(ordered[0] && ordered[0].contentLength));
    kino.log("probe", c.client.clientName, hlsUrl ? "hls" : "itag " + ordered[0].itag, "->", st);
    if (st === 200 || st === 206) return found;
    if (!fallback) fallback = found;
  }
  if (fallback) {
    report("player_degraded", "sin prueba valida");
    return fallback; // ninguna pasó la prueba: se entrega la primera por si el reproductor sí la acepta
  }
  const reason = String((lastStatus && lastStatus.reason) || "");
  report("player_failed", String((lastStatus && lastStatus.status) || "sin_estado"));
  if (/country|region|pa[ií]s|regi[oó]n|regi[aã]o|pays|paese|land/i.test(reason)) throw kino.error("geo_blocked", reason.slice(0, 150));
  if (lastStatus && lastStatus.status && lastStatus.status !== "LOGIN_REQUIRED" && lastStatus.status !== "ERROR") {
    const why = String(lastStatus.reason || "").slice(0, 120);
    throw kino.error("not_found", String(lastStatus.status) + (why ? ": " + why : ""), {
      userMessage: "Esta canción no se puede reproducir" + (why ? " (" + why.replace(/\.$/, "") + ")." : "."),
    });
  }
  throw kino.error("unavailable", "player sin audio", {
    userMessage: "YouTube no entregó esta canción por ahora. Prueba de nuevo en unos minutos.",
  });
}

// --- Camino 1: URL directa pedida a /player (rápido, pero YouTube lo bloquea a veces) ---------

// Misma URL con el rango dentro del propio enlace (googlevideo lo acepta como parámetro `range`), para no
// depender del encabezado Range que mande el reproductor.
function withRange(url, end) {
  return url + (url.indexOf("?") < 0 ? "?" : "&") + "range=0-" + end;
}

async function resolveDirect(videoId) {
  const { client, sd, ordered, hlsUrl } = await playerFor(videoId);
  const ua = client.ua;
  const headers = { "User-Agent": ua };
  const exp = Number(sd.expiresInSeconds);
  const expires = Number.isFinite(exp) && exp > 0 ? Math.max(30, Math.min(86400, Math.round(exp) - 300)) : undefined;
  const plain = (f) => ({ url: f.url, mime: mimeOf(f), headers, label: describe(f) });
  let stream;
  if (hlsUrl) {
    stream = { url: hlsUrl, mime: "application/vnd.apple.mpegurl", headers, label: "HLS" };
    if (ordered.length) stream.alternatives = ordered.slice(0, 2).map(plain);
  } else {
    // ¿Funciona el rango dentro del enlace, sin encabezado Range? (una sola petición de prueba)
    const f0 = ordered[0];
    const len = Number(f0.contentLength);
    let rangedOk = false;
    if (Number.isFinite(len) && len > 1) {
      const probe = withRange(f0.url, 1);
      const withUa = await probeUrl(probe, ua, true);
      rangedOk = withUa === 200 || withUa === 206;
      kino.log("probe rango-en-url ->", withUa);
    } else {
      kino.log("probe rango-en-url: sin contentLength");
    }
    // Primero el enlace con el rango incluido (todo el archivo en una petición), luego los normales.
    const list = [];
    for (const f of ordered.slice(0, 3)) {
      const l = Number(f.contentLength);
      if (rangedOk && Number.isFinite(l) && l > 1) list.push(Object.assign(plain(f), { url: withRange(f.url, l - 1) }));
    }
    for (const f of ordered.slice(0, 3)) list.push(plain(f));
    stream = list[0];
    const ms = Number(f0.approxDurationMs);
    if (Number.isFinite(ms) && ms > 0) stream.durationMs = Math.round(ms);
    if (list.length > 1) stream.alternatives = list.slice(1, 6);
  }
  if (expires) stream.expiresInSeconds = expires;
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

const AD_FREE_MATCH = "^(?!.*[?&]ctier=).*videoplayback";

async function resolveViaBrowser(videoId, timeoutMs) {
  let page;
  try {
    page = await kino.browser.capture("https://music.youtube.com/watch?v=" + videoId, {
      // Solo cuenta lo que no lleva ctier: esas URLs son los anuncios que YouTube pone a una sesión de
      // invitado. Los anuncios pasan de largo (la página los reproduce en silencio) y la captura espera
      // a que empiece la canción de verdad.
      match: AD_FREE_MATCH,
      timeoutMs: timeoutMs || 25000,
    });
  } catch (e) {
    kino.log("browser capture:", e.code || "error");
    report("browser_failed", String(e.code || "error"));
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
      "ctier=" + queryParam(m.url, "ctier"),
      "clen=" + queryParam(m.url, "clen"),
      "keys=" + keys.join(",").slice(0, 300),
    );
  }
  // Quitamos lo propio del reproductor web: trozos (range, rn, rbuf) y el envoltorio UMP (ump, srfvp).
  const clean = (u) => stripParams(u, ["range", "rn", "rbuf", "ump", "srfvp"]);
  const seen = new Set();
  const variants = [];
  const add = (u, headers) => {
    if (!seen.has(u)) {
      seen.add(u);
      variants.push({ url: u, headers: headers || {} });
    }
  };
  for (const m of all) {
    if (!m || !/^audio\//.test(queryParam(m.url, "mime")) || queryParam(m.url, "ctier")) continue; // nunca anuncios
    const plain = clean(m.url);
    add(plain, m.headers); // variante A: sin rango (el reproductor pide con su propio Range)
    const clen = Number(queryParam(plain, "clen"));
    if (Number.isFinite(clen) && clen > 1) add(plain + (plain.indexOf("?") < 0 ? "?" : "&") + "range=0-" + (clen - 1), m.headers); // B: todo el archivo como un solo rango
  }
  if (!variants.length) {
    kino.log("browser capture: sin audio de la canción entre", all.length, "peticiones");
    throw kino.error("unavailable", "capture sin audio", { userMessage: "YouTube no entregó esta canción por ahora. Prueba de nuevo en unos minutos." });
  }
  const describeCap = (m) => ({ url: m.url, mime: queryParam(m.url, "mime"), headers: m.headers, label: "YouTube Music" });
  const stream = describeCap(variants[0]);
  const dur = Number(queryParam(stream.url, "dur"));
  if (Number.isFinite(dur) && dur > 0) stream.durationMs = Math.round(dur * 1000);
  const expire = Number(queryParam(stream.url, "expire"));
  if (Number.isFinite(expire) && expire > 0) {
    stream.expiresInSeconds = Math.max(30, Math.min(86400, Math.round(expire - Date.now() / 1000) - 300));
  }
  if (variants.length > 1) stream.alternatives = variants.slice(1, 5).map(describeCap);
  kino.log("captured: variantes sin anuncios =", variants.length);
  return stream;
}

// --- Caché de streams ya resueltos ---------------------------------------------------------------
// Va por calidad (si cambias de AAC a Opus no se sirve el formato viejo) y con tope de tamaño: kino.storage
// guarda 256 KB en total, así que se llevan las cuentas en un índice y salen primero las más viejas.
const CACHE_IDX = "streamIdx";
const CACHE_MAX_BYTES = 150000;
const CACHE_MAX_ENTRIES = 16;

const cacheKey = (id) => "stream:" + (kino.config.get("quality") === "opus" ? "opus" : "aac") + ":" + id;

function cacheGet(key) {
  try {
    const raw = kino.storage.get(key);
    if (!raw) return null;
    const e = JSON.parse(raw);
    if (!e || !e.s || !e.exp) return null;
    const left = Math.round((e.exp - Date.now()) / 1000);
    if (left < 120) {
      kino.storage.remove(key);
      return null;
    }
    // Lo que de verdad le queda a la URL (no el plazo con el que se guardó): así Kino la renueva a tiempo.
    e.s.expiresInSeconds = Math.max(30, Math.min(86400, left - 30));
    return e.s;
  } catch (err) {
    return null;
  }
}

function cachePut(key, stream, ttlMs) {
  try {
    const slim = Object.assign({}, stream);
    const alts = slim.alternatives || [];
    if (alts.length > 3) slim.alternatives = alts.slice(0, 2).concat(alts.slice(-1)); // las dos mejores y la perezosa
    const raw = JSON.stringify({ s: slim, exp: Date.now() + ttlMs });
    if (raw.length > 40000) return;
    let idx = [];
    try {
      idx = JSON.parse(kino.storage.get(CACHE_IDX) || "[]");
    } catch (e) {
      idx = [];
    }
    const now = Date.now();
    idx = idx.filter((x) => x && x[0] !== key && x[2] > now);
    idx.push([key, raw.length, now + ttlMs]);
    let total = idx.reduce((a, x) => a + x[1], 0);
    while (idx.length > 1 && (total > CACHE_MAX_BYTES || idx.length > CACHE_MAX_ENTRIES)) {
      const old = idx.shift();
      total -= old[1];
      try {
        kino.storage.remove(old[0]);
      } catch (e) {}
    }
    kino.storage.set(key, raw, { ttlMs });
    kino.storage.set(CACHE_IDX, JSON.stringify(idx), { ttlMs: 6 * 3600 * 1000 });
  } catch (e) {}
}

// El navegador oculto como copia perezosa: solo se abre si la persona la elige en "Servidor" o si las otras fallan.
function withBrowserCopy(stream, id) {
  const alts = (stream.alternatives || []).filter((a) => !a.ref).slice(0, 7);
  alts.push({ label: "Navegador oculto", ref: "tb:" + id });
  stream.alternatives = alts;
}

export async function resolve(ref, options) {
  kino.log("ytmusic v" + VERSION + " resolve");
  const canBrowse = !!(kino.browser && typeof kino.browser.capture === "function");
  // Copia perezosa del navegador oculto (Kino la pide con su propio ref; si la pide el cambio automático tiene 20 s).
  const lazy = /^tb:([A-Za-z0-9_-]{11})$/.exec(String(ref || ""));
  if (lazy) {
    if (!canBrowse) throw kino.error("unavailable", "sin navegador oculto");
    return resolveViaBrowser(lazy[1], 18000);
  }
  const p = parseRef(ref);
  if (!p || p.type !== "t" || !/^[A-Za-z0-9_-]{11}$/.test(p.id)) throw kino.error("not_found", "ref de pista no válido");
  if (kino.config.get("method") === "browser" && canBrowse) {
    try {
      return await resolveViaBrowser(p.id);
    } catch (e) {
      if (e.code !== "not_allowed" && e.code !== "browser_unavailable") throw e;
    }
  }
  const key = cacheKey(p.id);
  if (options && options.retry) {
    // Kino vuelve a pedir porque el servidor rechazó la URL: la guardada ya no sirve.
    try {
      kino.storage.remove(key);
    } catch (e) {}
  } else {
    const hit = cacheGet(key);
    if (hit) {
      kino.log("cache hit");
      return hit;
    }
  }
  let stream;
  let viaDirect = true;
  try {
    stream = await resolveDirect(p.id);
  } catch (e) {
    // Ningún cliente entregó audio. Si YouTube dice que la pista no se puede reproducir (UNPLAYABLE), el navegador
    // oculto tampoco la va a conseguir: se falla en el acto con el motivo real. Solo se prueba el navegador
    // en los demás casos, y si él también falla se devuelve el error ORIGINAL (no el del bot-check).
    const definitive = !!lastPlayability && lastPlayability.status === "UNPLAYABLE";
    if (e.code !== "not_found" || !canBrowse || definitive) throw e;
    kino.log("resolveDirect not_found -> navegador oculto");
    try {
      stream = await resolveViaBrowser(p.id);
      viaDirect = false;
    } catch (e2) {
      kino.log("navegador oculto tampoco:", e2.code || "error");
      throw e;
    }
  }
  if (viaDirect && canBrowse) withBrowserCopy(stream, p.id);
  const ttl = Number(stream.expiresInSeconds) > 60 ? (Number(stream.expiresInSeconds) - 30) * 1000 : 0;
  if (ttl) cachePut(key, stream, ttl);
  return stream;
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

// ---------------------------------------------------------------------------------------------
// Pasar lo guardado (capacidad "migrate"). Sin peticiones: solo reconoce enlaces de YouTube que la persona
// tenía guardados con otra forma (direcciones web, ids de listas y de álbumes) y los vuelve refs de este plugin.
// Solo reclama lo que es inconfundiblemente de YouTube, para no quitarle nada a otros plugins.
// ---------------------------------------------------------------------------------------------
function browseKind(id) {
  if (/^UC[A-Za-z0-9_-]{22}$/.test(id) || /^MPLAUC/.test(id)) return { type: "a", id };
  if (/^OLAK5uy_/.test(id)) return { type: "b", id: "VL" + id };
  return { type: "b", id };
}

function legacyRef(raw) {
  const s = String(raw || "").trim();
  if (!s || s.length > 2000) return null;
  const web = /(?:^|\/\/|\.)(?:music\.youtube\.com|youtube\.com|youtu\.be)(?:\/|$)/i.test(s);
  let m;
  if (web) {
    if ((m = /(?:youtu\.be\/|[?&]v=)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(s))) return { type: "t", id: m[1] };
    if ((m = /[?&]list=([A-Za-z0-9_-]{10,60})/.exec(s))) return { type: "b", id: /^VL/.test(m[1]) ? m[1] : "VL" + m[1] };
    if ((m = /\/(?:browse|channel)\/([A-Za-z0-9_-]{8,120})/.exec(s))) return browseKind(m[1]);
    return null;
  }
  if (/^(MPREb_|OLAK5uy_)[A-Za-z0-9_-]+$/.test(s) || /^VL(PL|RD|OLAK5uy_)[A-Za-z0-9_-]+$/.test(s) || /^UC[A-Za-z0-9_-]{22}$/.test(s)) return browseKind(s);
  return null;
}

export async function migrate(input) {
  await null;
  if (!input || typeof input !== "object") return null;
  const r = legacyRef(input.ref);
  if (!r) return null;
  if (input.kind === "title") {
    if (r.type === "t") return { kind: "music", id: "t." + r.id, ref: trackRef(r.id) };
    return { kind: "music", id: r.type + "." + r.id, ref: r.type + ":" + r.id };
  }
  if (input.kind === "chapter") {
    if (r.type !== "t") return null;
    const n = Math.floor(Number(input.episode));
    return { kind: "episode", ref: trackRef(r.id), season: 1, number: n > 0 ? n : 1 };
  }
  return null;
}
