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
const VERSION = "0.5.2";
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

// Whether the screen shows an active account. Kino writes or clears the cookie settings only after the call that asked, so the
// screen's own state (linkedNow / sessionOff, set by link_account and logout_session) decides in between.
function sessionActive(s) {
  if (s && s.sessionOff === true) return false;
  return !!savedCookie() || (s && s.linkedNow === true);
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
  const stats = txt(h.secondSubtitle).trim();
  let overview = txt(d).trim();
  if (!overview) overview = txt(h.subtitle).trim();
  // Descripción (o subtítulo) y, detrás, las cifras de la cabecera: oyentes, canciones, duración.
  const full = [overview, stats].filter(Boolean).join(" · ");
  const sub = (h.subtitle && h.subtitle.runs) || [];
  return {
    title: txt(h.title).trim() || undefined,
    poster: bigThumb(h.thumbnail && (h.thumbnail.musicThumbnailRenderer || h.thumbnail.croppedSquareThumbnailRenderer)),
    year: yearOf(sub),
    stats: stats || undefined,
    overview: full ? full.slice(0, 2000) : undefined,
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
    // Kino 0.9.81 (apiVersion 19): the video id, so a lyrics plugin finds the exact recording. Older Kinos ignore it.
    it.ids = { youtube: String(x.id).slice(0, 64) };
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

// Plugins that add to this one. Each becomes a tile in Ajustes; pressing it opens Kino's own "Agregar un plugin" with the repo
// filled in (go.installPlugin, apiVersion 19), where the person confirms the install. Add an entry to offer another.
const RECOMMENDED_PLUGINS = [
  {
    key: "lyrics_ytmusic",
    title: "Letras de YouTube Music",
    subtitle: "Instala las letras de YouTube Music: aparece un botón Letra en el reproductor",
    repo: "kinotvapp/kino-plugin-lyrics-ytmusic"
  },
  {
    key: "lyrics_lrclib",
    title: "Letras de LRCLIB",
    subtitle: "Instala las letras de LRCLIB, con la letra sincronizada línea a línea",
    repo: "kinotvapp/kino-plugin-lyrics-lrclib"
  }
];

// Kino tells every call which of the manifest's "recommends" are installed now ({ "owner/name": true|false }, apiVersion 19).
let lastInstalled = {};

// Pressing search: at once (no plugin call) show the spinner card and move the focus onto it, which drops the keyboard; then search.
const SEARCH_ACTION = { ui: [{ show: "search_loading_card" }, { focus: "search_loading_card" }], event: "do_search" };

// Two ways to link the account, in one accordion: the web window Kino opens (kino.visualBrowser, Kino 0.9.81+) and, as the
// original plugin always offered, pasting the cookies by hand following the guide. Without the window only the guide shows.
function accountOptionsNode() {
  const canBrowser = !!(kino.visualBrowser && kino.visualBrowser.available);
  const manual = {
    key: "opt_manual",
    title: "Pegando las cookies (manual)",
    titleEn: "Pasting the cookies (manual)",
    open: !canBrowser,
    children: [
      {
        type: "Text",
        key: "opt_manual_txt",
        text: "Copia las cookies de tu sesión de YouTube Music y pégalas en Mi Música, siguiendo la guía paso a paso.",
        textEn: "Copy the cookies of your YouTube Music session and paste them in My Music, following the step-by-step guide.",
        color: "muted"
      },
      {
        type: "ElevatedButton",
        key: "btn_go_login_guide",
        labelText: "Abrir guía de inicio de sesión",
        labelTextEn: "Open the sign-in guide",
        icon: "info",
        onPressed: "switch_screen_tab_library"
      }
    ]
  };
  if (!canBrowser) return { type: "ExpansionTile", key: "acc_options", items: [manual] };
  return {
    type: "ExpansionTile",
    key: "acc_options",
    items: [
      {
        key: "opt_browser",
        title: "Con el navegador (recomendado)",
        titleEn: "With the browser (recommended)",
        open: true,
        children: [
          {
            type: "Text",
            key: "opt_browser_txt",
            text: "Inicias sesión con Google en una ventana de Kino. Kino guarda las cookies por el plugin: no tienes que copiar nada.",
            textEn: "You sign in with Google in a Kino window. Kino keeps the cookies for the plugin: you copy nothing.",
            color: "muted"
          },
          {
            type: "ElevatedButton",
            key: "btn_link_browser",
            labelText: "Vincular cuenta YT Music",
            labelTextEn: "Link YT Music account",
            icon: "person",
            onPressed: "link_account"
          }
        ]
      },
      manual
    ]
  };
}

// The cookies YouTube Music needs to treat the person as themselves (not a guest): the session ones plus LOGIN_INFO and the
// visitor ones. Kino writes them as one header cut across cookieA..cookieD (500 characters each), which joinCookie() joins again.
const LINK_COOKIES = [
  "SID", "HSID", "SSID", "APISID", "SAPISID",
  "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PAPISID", "__Secure-3PAPISID",
  "__Secure-1PSIDTS", "__Secure-3PSIDTS", "LOGIN_INFO", "VISITOR_INFO1_LIVE", "YSC"
];

// Asks YouTube Music who the saved cookies are: a session it does not recognise answers 200 with guest content, so the 200 alone
// proves nothing. Logs only the cookie NAMES (never a value) and keeps the result for the account card.
async function checkSession(s) {
  const cookie = savedCookie();
  if (!cookie) {
    s.accountChecked = false;
    s.accountName = "";
    return;
  }
  kino.log("ytmusic account: cookie names", Object.keys(parseCookie(cookie)).join(","));
  try {
    const name = await accountName(cookie);
    s.accountName = name || "";
    s.accountChecked = true;
    kino.log("ytmusic account: " + (name ? "recognised" : "NOT recognised"));
  } catch (e) {
    s.accountChecked = false;
    kino.log("ytmusic account: check failed", (e && e.code) || "error");
  }
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
  const [likedData, listsData, ownedListsData, libraryData, historyData] = await Promise.all([
    safe("library liked", () => yt("browse", { browseId: "VLLM" }), null),
    safe("library lists", () => yt("browse", { browseId: "FEmusic_liked_playlists" }), null),
    // Estos dos browseId no son compatibles con el cliente WEB_REMIX y devuelven unavailable.
    Promise.resolve(null),
    Promise.resolve(null),
    safe("library history", () => yt("browse", { browseId: "FEmusic_history" }), null),
  ]);
  if (likedData) {
    const items = collectItems(shelfOf(likedData)).filter((x) => x.type === "track" && keep(x)).slice(0, 60).map(toItem);
    if (items.length) rows.push({ id: "yt-liked", title: "Canciones que te gustan", items, ref: "b:VLLM", genre: "musica" });
  }
  const playlistItems = [];
  const seenPlaylistIds = new Set();
  for (const data of [ownedListsData, listsData, libraryData]) {
    if (!data) continue;
    for (const item of collectItems(data)) {
      if (item.type !== "browse" || !keep(item) || seenPlaylistIds.has(item.id)) continue;
      seenPlaylistIds.add(item.id);
      playlistItems.push(toItem(item));
      if (playlistItems.length >= 60) break;
    }
  }
  if (playlistItems.length) {
    rows.push({ id: "yt-lists", title: "Tus listas de reproducción", items: playlistItems, ref: "b:FEmusic_library_playlists", genre: "musica" });
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

const episodeOf = (x, i, head) => {
  const facts = [];
  if (x.album) facts.push("Álbum: " + x.album);
  if (x.video) facts.push("Video musical");
  if (x.year) facts.push(String(x.year));
  if (x.explicit) facts.push("Explícito");
  return {
    season: 1,
    number: i + 1,
    ref: trackRef(x.id, x.title),
    title: x.title.slice(0, 200),
    still: x.poster || head.poster,
    runtimeMinutes: x.minutes,
    overview: facts.length ? facts.join(" · ").slice(0, 2000) : undefined,
  };
};

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
  const counts = [tracks.length + (tracks.length === 1 ? " canción" : " canciones")];
  if (albums.length) counts.push(albums.length + (albums.length === 1 ? " álbum y sencillo" : " álbumes y sencillos"));
  const overview = [head.overview, counts.join(" · ")].filter(Boolean).join(" · ").slice(0, 2000);
  const out = {
    series: { title: head.title, poster: head.poster, backdrop: head.poster, overview },
    episodes: tracks.slice(0, 500).map((x, i) => episodeOf(x, i, head)),
  };
  if (albums.length) {
    out.seasons = [{ id: "a." + id, ref: "a:" + id, title: "Canciones", current: true }].concat(
      albums.map((a) => ({
        id: "b." + a.id,
        ref: "b:" + a.id,
        title: (a.year ? a.title + " (" + a.year + ")" : a.title).slice(0, 200),
      })),
    );
  }
  return out;
}

export async function episodes(ref) {
  const p = parseRef(ref);
  if (!p) throw kino.error("not_found", "ref no válido");
  // Una pista suelta es un álbum de una sola pista.
  if (p.type === "t") {
    const trackTitle = p.title || "Canción";
    const trackCover = "https://i.ytimg.com/vi/" + p.id + "/hqdefault.jpg";
    return {
      series: {
        title: trackTitle,
        poster: trackCover,
        backdrop: trackCover
      },
      episodes: [
        {
          season: 1,
          number: 1,
          ref: String(ref),
          title: trackTitle,
          still: trackCover
        }
      ]
    };
  }
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
function withBrowserCopy(stream, id, reserve) {
  const alts = (stream.alternatives || []).filter((a) => !a.ref).slice(0, 7 - (reserve || 0));
  alts.push({ label: "Navegador oculto", ref: "tb:" + id });
  stream.alternatives = alts;
}

// ---------------------------------------------------------------------------------------------
// Audio 8D: busca en YouTube Music la versión 8D de la canción y devuelve su videoId.
// Si no la encuentra, devuelve null (el flujo normal continúa con el id original).
// Solo se prueba si el toggle "audio8d" está activo y el ref trae título.
// ---------------------------------------------------------------------------------------------
async function find8dVersion(originalId, title) {
  if (!title) return null;
  try {
    const cleanTitle = String(title || "").trim();
    const q = cleanTitle + " 8D audio";
    const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");

    // Busca primero entre canciones (SEARCH_SONGS) y luego en general (videos incluidos).
    const [songsData, generalData] = await Promise.all([
      yt("search", { query: q, params: SEARCH_SONGS }, { timeoutMs: 8000 }).catch(() => null),
      yt("search", { query: q }, { timeoutMs: 8000 }).catch(() => null),
    ]);

    const candidates = [];
    const seen = new Set();
    for (const data of [songsData, generalData]) {
      if (!data) continue;
      for (const x of collectItems(data)) {
        if (x.type !== "track" || !keep(x) || seen.has(x.id)) continue;
        seen.add(x.id);
        candidates.push(x);
      }
    }

    const origLower = cleanTitle.toLowerCase();
    const unwantedTerms = [
      "slowed",
      "slow",
      "reverb",
      "speed up",
      "sped up",
      "speedup",
      "spedup",
      "nightcore",
      "daycore",
      "hardtekk",
      "hardstyle",
      "chopped",
      "screwed",
      "chipmunk",
      "bass boosted",
      "bassboosted",
      "mashup",
      "parody",
      "pitch"
    ];

    function scoreCandidate(c) {
      if (c.id === originalId) return -1000;
      const cTitle = String(c.title || "").toLowerCase();
      const cNorm = norm(cTitle);

      // Debe contener indicación de 8D
      if (!cNorm.includes("8d") && !cNorm.includes("9d") && !cNorm.includes("16d")) {
        return -1000;
      }

      // Descartar si incluye términos alterados (slowed, reverb, sped up, etc.) no presentes en el original
      for (const term of unwantedTerms) {
        if (!origLower.includes(term) && cTitle.includes(term)) {
          return -1000;
        }
      }

      let score = 10;
      // Bonus si incluye "8d audio" o "audio 8d"
      if (cTitle.includes("8d audio") || cTitle.includes("audio 8d") || cTitle.includes("8d sound")) {
        score += 30;
      }
      // Bonus si incluye las palabras del título original
      const titleWords = cleanTitle.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      let matchCount = 0;
      for (const w of titleWords) {
        if (cTitle.includes(w)) matchCount++;
      }
      if (titleWords.length > 0 && matchCount === titleWords.length) {
        score += 40;
      }

      // Bonus si el canal es conocido por 8D puro
      const artist = String(c.artist || "").toLowerCase();
      if (artist.includes("8d tunes") || artist.includes("8d music") || artist.includes("8d era") || artist.includes("8d hub")) {
        score += 25;
      }

      // Penalizar si tiene remix no solicitado
      if (!origLower.includes("remix") && cTitle.includes("remix")) {
        score -= 50;
      }

      return score;
    }

    let bestHit = null;
    let bestScore = 0;

    for (const cand of candidates) {
      const s = scoreCandidate(cand);
      if (s > bestScore) {
        bestScore = s;
        bestHit = cand;
      }
    }

    if (bestHit) {
      kino.log("8D óptima encontrada (score=" + bestScore + "):", bestHit.id, bestHit.title.slice(0, 60));
      return bestHit.id;
    }

    kino.log("8D limpia no encontrada para:", cleanTitle.slice(0, 60));
    return null;
  } catch (e) {
    kino.log("8D search error:", e.code || "error");
    return null;
  }
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
  // Copia perezosa "Audio original": la pista original, sin buscar su versión 8D (la persona la eligió en "Servidor").
  const orig = /^to:([A-Za-z0-9_-]{11})$/.exec(String(ref || ""));
  if (orig) return resolveTrack({ type: "t", id: orig[1], params: "", title: "" }, options, canBrowse, 0);

  const p = parseRef(ref);
  if (!p || p.type !== "t" || !/^[A-Za-z0-9_-]{11}$/.test(p.id)) throw kino.error("not_found", "ref de pista no válido");

  // Audio 8D: si está activo, se intenta resolver el equivalente 8D antes de cualquier otra lógica.
  // La búsqueda es rápida (8 s máx.) y silenciosa: si falla o no hay resultado, se sigue con el original.
  // Si se encuentra, "Servidor" ofrece "Audio 8D" (el que suena) y "Audio original" (copia perezosa) para intercambiarlos.
  if (kino.config.get("audio8d") === true && p.title) {
    const id8d = await find8dVersion(p.id, p.title);
    if (id8d) {
      const stream = await resolveTrack(Object.assign({}, p, { id: id8d }), options, canBrowse, 1);
      const alts = (stream.alternatives || []).slice(0, 7);
      alts.unshift({ label: "Audio original", ref: "to:" + p.id });
      return Object.assign({}, stream, { label: "Audio 8D", alternatives: alts.slice(0, 8) });
    }
  }
  return resolveTrack(p, options, canBrowse, 0);
}

// Resuelve el audio de una pista (ya sin lógica 8D). "reserve" deja sitio en las copias para entradas extra.
async function resolveTrack(p, options, canBrowse, reserve) {
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
    if (!canBrowse || definitive) throw e;
    kino.log("resolveDirect falló (" + (e.code || "error") + ") -> intentando navegador oculto");
    try {
      stream = await resolveViaBrowser(p.id);
      viaDirect = false;
    } catch (e2) {
      kino.log("navegador oculto tampoco:", e2.code || "error");
      throw e;
    }
  }
  if (viaDirect && canBrowse) withBrowserCopy(stream, p.id, reserve);
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

// =============================================================================================
// UI SCREEN (apiVersion 14 / enhancements)
// =============================================================================================

function parseItemType(ref, badges) {
  const r = String(ref || "");
  const m = /^([tba]):([^|@]+)/.exec(r);
  const type = m ? m[1] : (r.startsWith("a:") ? "a" : r.startsWith("b:") ? "b" : "t");
  const b = badges || [];
  const isArtist = type === "a" || b.includes("Artista");
  const isAlbum = type === "b" || b.includes("Álbum") || b.includes("Lista");
  return {
    type,
    idPart: m ? m[2] : r.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
    isArtist,
    isAlbum,
    isPlaylist: type === "b" && (r.startsWith("b:VLPL") || r.startsWith("b:PL") || r.startsWith("b:RD")),
    isTrack: !isArtist && !isAlbum
  };
}

function renderMusicTile(item, idx, prefix = "tr_") {
  const meta = parseItemType(item.ref, item.badges);
  const rawId = item.id || (meta.type + "." + meta.idPart);
  const itemId = /^[A-Za-z0-9._~-]{1,128}$/.test(rawId) ? rawId : (meta.type + "." + String(idx));
  const title = String(item.title || (meta.isArtist ? "Artista" : meta.isAlbum ? "Álbum" : "Canción")).slice(0, 200);
  const initials = title.slice(0, 2).toUpperCase();

  let subtitle = "";
  if (meta.isArtist) {
    subtitle = "Artista" + (item.subscribers ? " · " + item.subscribers : "");
  } else if (meta.isAlbum) {
    const kindLabel = (item.badges && item.badges.includes("Lista")) ? "Lista" : "Álbum";
    subtitle = item.artist ? (item.artist + " · " + kindLabel) : kindLabel;
  } else {
    const isVid = item.badges && item.badges.includes("Video");
    subtitle = item.artist ? (item.artist + (isVid ? " · Video" : " · Canción")) : (isVid ? "Video musical" : "Canción");
  }

  const trailingIcon = meta.isArtist ? "person" : meta.isAlbum ? "list" : "play";

  const onTapAction = (meta.isArtist || meta.isAlbum)
    ? { go: { title: { ref: item.ref, kind: "music", id: itemId, title } } }
    : { go: { play: { ref: item.ref, kind: "music", id: itemId, title } } };

  return {
    type: "ListTile",
    key: prefix + idx,
    title,
    subtitle,
    leading: {
      type: "CircleAvatar",
      image: item.poster || "",
      radius: 24,
      text: initials
    },
    trailing: {
      type: "Icon",
      name: trailingIcon
    },
    onTap: onTapAction
  };
}

export async function screen({ state, route, device, size, lang, installed }) {
  lastInstalled = installed || {};
  const s = state || {};
  const tab = s.tab || "trending";

  let bodyNode;

  if (tab === "trending") {
    const rails = s.rails || [];
    const filter = s.trendFilter || "all";
    const featuredHero = s.heroItem || (rails[0]?.items?.[0]);

    const children = [];

    // The Inicio on screen was loaded before the account changed (linked or logged out): offer to load it again.
    if (s.trendingLoaded && s.railsAuth !== sessionActive(s)) {
      children.push({
        type: "Card",
        key: "card_reload_home",
        padding: 16,
        variant: "outlined",
        children: [
          {
            type: "Text",
            key: "reload_home_txt",
            text: sessionActive(s) ? "Tu cuenta ya está vinculada. Carga tu Inicio para ver tu música." : "Cerraste sesión. Actualiza para volver al Inicio general.",
            textEn: sessionActive(s) ? "Your account is linked. Load your Home to see your music." : "You logged out. Refresh to go back to the general Home."
          },
          {
            type: "ElevatedButton",
            key: "btn_reload_home",
            labelText: sessionActive(s) ? "Cargar mi Inicio" : "Actualizar",
            labelTextEn: sessionActive(s) ? "Load my Home" : "Refresh",
            icon: "refresh",
            onPressed: "refresh_screen"
          }
        ]
      });
    }

    // Hero compacto recupera jerarquía visual sin empujar los carruseles bajo el primer pliegue.
    if (featuredHero) {
      children.push({
        type: "heroCard",
        key: "hero_trend",
        title: "Tendencias Musicales",
        text: featuredHero.title ? "Destacado: " + featuredHero.title : "Descubre música en YouTube Music",
        image: featuredHero.poster || "",
        buttons: [{
          type: "Button",
          key: "hero_btn_search",
          variant: "secondary",
          icon: "search",
          labelText: "Buscar música",
          labelTextEn: "Search music",
          onPressed: "open_search"
        }]
      });
    }

    // Filtros de categoría rápida.
    children.push({
      type: "Card",
      key: "trend_filter_card",
      padding: 8,
      variant: "outlined",
      children: [
        {
          type: "SingleChildScrollView",
          key: "trend_filter_scroll",
          direction: "horizontal",
          children: [{
            type: "Chips",
            key: "trend_filter",
            value: filter,
            onChange: "filter_trending",
            options: [
              { value: "all", label: "Todo", labelEn: "All" },
              { value: "songs", label: "Canciones", labelEn: "Songs" },
              { value: "artists", label: "Artistas", labelEn: "Artists" },
              { value: "albums", label: "Álbumes y Listas", labelEn: "Albums & Lists" }
            ]
          }]
        }
      ]
    });

    // Kino puede restaurar trendingLoaded sin restaurar rails tras cerrar/abrir la mini-app.
    // Sin filas, conservamos Skeleton en vez de una portada vacía.
    if (!s.trendingLoaded || !rails.length) {
      children.push({ type: "Skeleton", key: "skel_trend", variant: "list", rows: 8, padding: 12 });
    } else if (filter === "all") {
      // Vista completa con carruseles horizontales nativos (titleRail)
      rails.forEach((rail, idx) => {
        if (rail.items && rail.items.length) {
          children.push({
            type: "titleRail",
            key: "rail_" + idx,
            title: rail.title,
            items: rail.items
          });
        }
      });
    } else {
      // Filtrar items según la selección
      const filteredItems = [];
      const seen = new Set();
      for (const r of rails) {
        for (const it of r.items || []) {
          if (!it.ref || seen.has(it.ref)) continue;
          seen.add(it.ref);
          const meta = parseItemType(it.ref, it.badges);
          if (filter === "songs" && meta.isTrack) filteredItems.push(it);
          if (filter === "artists" && meta.isArtist) filteredItems.push(it);
          if (filter === "albums" && meta.isAlbum) filteredItems.push(it);
        }
      }

      if (filteredItems.length) {
        children.push({
          type: "titleRail",
          key: "rail_filtered",
          title: filter === "songs" ? "Canciones destacadas" : filter === "artists" ? "Artistas principales" : "Álbumes y Listas",
          items: filteredItems.slice(0, 30)
        });
        // También listado detallado
        children.push({
          type: "Card",
          key: "filtered_list_card",
          padding: 8,
          variant: "outlined",
          children: filteredItems.slice(0, 20).map((it, idx) => renderMusicTile(it, idx, "flt_"))
        });
      } else {
        children.push({
          type: "emptyState",
          key: "trend_empty",
          title: "Sin resultados en esta categoría",
          titleEn: "No items in this category",
          text: "Selecciona otra categoría arriba o vuelve a cargar la página.",
          icon: "filter_list"
        });
        children.push({
          type: "ElevatedButton",
          key: "btn_trend_refresh",
          labelText: "Actualizar",
          labelTextEn: "Refresh",
          icon: "refresh",
          onPressed: "refresh_screen"
        });
      }
    }

    bodyNode = {
      type: "SingleChildScrollView",
      key: "trend_scroll",
      children: [
        {
          type: "Column",
          key: "trend_col",
          gap: 16,
          padding: 12,
          children
        }
      ]
    };
  } else if (tab === "search") {
    const rawResults = s.searchResults || [];
    const filter = s.searchFilter || "all";
    const tracks = [];
    const others = [];

    for (const it of rawResults) {
      const meta = parseItemType(it.ref, it.badges);
      if (meta.isTrack) tracks.push(it);
      else others.push(it);
    }

    const artists = [];
    const albums = [];
    for (const it of others) (parseItemType(it.ref, it.badges).isArtist ? artists : albums).push(it);
    const shownTracks = filter === "artists" || filter === "albums" ? [] : tracks;
    const shownOthers = filter === "all" ? others : filter === "songs" ? [] : filter === "artists" ? artists : albums;

    const children = [
      {
        type: "Row",
        key: "search_top_row",
        children: [
          {
            type: "TextButton",
            key: "btn_close_search",
            icon: "arrow_back",
            labelText: "Volver",
            labelTextEn: "Back",
            onPressed: "close_search"
          },
          { type: "Text", key: "search_top_title", text: "Buscar en YouTube Music", textEn: "Search YouTube Music", style: "h3" }
        ]
      },
      {
        type: "Card",
        key: "search_card",
        padding: 12,
        variant: "outlined",
        children: [
          {
            type: "TextField",
            key: "searchQuery",
            kind: "search",
            labelText: "Buscar en YouTube Music",
            labelTextEn: "Search YouTube Music",
            hintText: "Canción, artista, álbum o playlist...",
            hintTextEn: "Song, artist, album or playlist...",
            onSubmitted: SEARCH_ACTION,
            trailingIcon: "search",
            trailingLabel: "Buscar",
            trailingLabelEn: "Search",
            onTrailingTap: SEARCH_ACTION
          },
          {
            type: "Text",
            key: "search_hint",
            text: "Busca canciones, artistas, álbumes y playlists.",
            textEn: "Search songs, artists, albums and playlists.",
            style: "caption",
            color: "muted"
          }
        ]
      }
    ];

    // Filtro de resultados por tipo de contenido.
    children.push({
      type: "Card",
      key: "search_filter_card",
      padding: 8,
      variant: "outlined",
      children: [
        {
          type: "SingleChildScrollView",
          key: "search_filter_scroll",
          direction: "horizontal",
          children: [{
            type: "Chips",
            key: "search_filter",
            value: filter,
            onChange: "filter_search",
            options: [
              { value: "all", label: "Todo", labelEn: "All" },
              { value: "songs", label: "Canciones", labelEn: "Songs" },
              { value: "artists", label: "Artistas", labelEn: "Artists" },
              { value: "albums", label: "Álbumes", labelEn: "Albums" }
            ]
          }]
        }
      ]
    });

    // The spinner card always exists, hidden: pressing search shows it before the plugin is even called (SEARCH_ACTION).
    children.push({
        type: "Card",
        key: "search_loading_card",
        padding: 24,
        align: "center",
        hidden: true,
        canRequestFocus: true,
        children: [
          {
            type: "CircularProgressIndicator",
            key: "search_cpi",
            text: "Buscando en YouTube Music...",
            textEn: "Searching YouTube Music..."
          }
        ]
      });
    if (s.searching) {
      children.push({ type: "Skeleton", key: "skel_search", variant: "list", rows: 6, padding: 12 });
    } else if (rawResults.length && (shownTracks.length || shownOthers.length)) {
      // Resultados encontrados con organización profesional
      if (shownOthers.length) {
        children.push({
          type: "titleRail",
          key: "sr_rail_others",
          title: filter === "artists" ? "Artistas encontrados" : filter === "albums" ? "Álbumes y Listas encontrados" : "Artistas y Álbumes encontrados",
          items: shownOthers.slice(0, 20)
        });
      }

      if (shownTracks.length) {
        children.push({
          type: "titleRail",
          key: "sr_rail_tracks",
          title: "Canciones destacadas",
          items: shownTracks.slice(0, 20)
        });

        // Lista de reproducción directa con información enriquecida
        children.push({
          type: "Card",
          key: "sr_tracks_card",
          padding: 8,
          variant: "outlined",
          children: [
            { type: "Text", key: "sr_tracklist_head", text: "Lista de Canciones", style: "h4" },
            ...shownTracks.slice(0, 15).map((item, idx) => renderMusicTile(item, idx, "sr_t_"))
          ]
        });
      }
    } else if (rawResults.length) {
      children.push({
        type: "emptyState",
        key: "sr_filter_empty",
        title: "Sin resultados en este filtro",
        titleEn: "No results in this filter",
        text: "Selecciona «Todo» arriba o pulsa Volver para cambiar la búsqueda.",
        icon: "filter_list"
      });
    } else if (s.searched) {
      children.push({
        type: "emptyState",
        key: "sr_empty",
        title: "Sin resultados para \"" + (s.lastQuery || "") + "\"",
        titleEn: "No results",
        text: "Prueba con otra palabra o selecciona uno de los géneros de arriba.",
        icon: "search"
      });
    } else {
      // Pantalla inicial antes de buscar: sugerencias atractivas
      const recRails = (s.rails || []).slice(0, 2);
      if (recRails.length) {
        recRails.forEach((r, idx) => {
          if (r.items && r.items.length) {
            children.push({
              type: "titleRail",
              key: "sr_rec_rail_" + idx,
              title: "Recomendado: " + r.title,
              items: r.items.slice(0, 15)
            });
          }
        });
      } else {
        children.push({
          type: "emptyState",
          key: "sr_init",
          title: "Buscador de YouTube Music",
          titleEn: "YouTube Music Search",
          text: "Escribe cualquier canción, artista o playlist y pulsa Buscar.",
          icon: "music"
        });
      }
    }

    bodyNode = {
      type: "SingleChildScrollView",
      key: "search_scroll",
      children: [
        {
          type: "Column",
          key: "search_col",
          gap: 16,
          padding: 12,
          children
        }
      ]
    };
  } else if (tab === "ai") {
    const aiList = s.aiTracks || [];
    const children = [
      {
        type: "heroCard",
        key: "hero_ai",
        title: "Playlist Inteligente con IA",
        text: "Describe cualquier momento o estilo musical y la IA creará una selección real y personalizada.",
        image: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=1200&q=80"
      },
      {
        type: "Card",
        key: "ai_card",
        padding: 14,
        variant: "filled",
        children: [
          { type: "Text", key: "ai_t1", text: "¿Qué te apetece escuchar?", style: "h3" },
          { type: "Text", key: "ai_desc", text: "Toca una idea rápida o escribe tu propia descripción:", color: "muted" },
          {
            type: "Chips",
            key: "ai_quick_chips",
            onChange: "quick_ai_prompt",
            options: [
              { value: "Rock clásico legendario de los 70 y 80", label: "Rock Clásico", labelEn: "Classic Rock" },
              { value: "Éxitos de reggaetón y pop latino 2024", label: "Pop & Urbano", labelEn: "Pop & Urban" },
              { value: "Lo-Fi relajante y chill para estudiar concentrado", label: "Lo-Fi Chill", labelEn: "Lo-Fi Chill" },
              { value: "Música electrónica energizante para entrenar en el gym", label: "Gym & Workout", labelEn: "Gym & Workout" },
              { value: "Synthwave y retrowave de noche en la ciudad", label: "Synthwave 80s", labelEn: "Synthwave 80s" }
            ]
          },
          {
            type: "TextField",
            key: "aiPrompt",
            labelText: "Escribe tu idea temática",
            labelTextEn: "What music do you want today?",
            hintText: "Ej. Baladas acústicas melancólicas para un día lluvioso",
            hintTextEn: "E.g. 80s synthwave for driving",
            onSubmit: "generate_ai",
            trailingIcon: "magic",
            trailingLabel: "Crear",
            trailingLabelEn: "Create",
            onTrailingTap: "generate_ai"
          },
          {
            type: "ElevatedButton",
            key: "btn_ai_exec",
            labelText: "Generar Playlist con IA",
            labelTextEn: "Generate AI Playlist",
            icon: "magic",
            onPressed: "generate_ai"
          }
        ]
      }
    ];

    if (s.aiLoading) {
      children.push({ type: "Skeleton", key: "skel_ai", variant: "list", rows: 6, padding: 12 });
    } else if (aiList.length) {
      // Carrusel visual de los temas generados
      children.push({
        type: "titleRail",
        key: "ai_rail_results",
        title: "Selección creada por la IA",
        items: aiList
      });

      // Lista interactiva con botón de reproducción
      children.push({
        type: "Card",
        key: "ai_list_card",
        padding: 8,
        variant: "outlined",
        children: [
          { type: "Text", key: "ai_list_title", text: "Canciones en tu Lista", style: "h4" },
          ...aiList.map((item, idx) => renderMusicTile(item, idx, "ai_it_"))
        ]
      });
    } else {
      children.push({
        type: "emptyState",
        key: "ai_init",
        title: "Tu DJ Personal con Inteligencia Artificial",
        titleEn: "Your AI Playlist Creator",
        text: "Toca una de las sugerencias rápidas de arriba o escribe cualquier descripción.",
        icon: "magic"
      });
    }

    bodyNode = {
      type: "SingleChildScrollView",
      key: "ai_scroll",
      children: [
        {
          type: "Column",
          key: "ai_col",
          gap: 16,
          padding: 12,
          children
        }
      ]
    };
  } else if (tab === "library") {
    const rawLib = s.libraryItems || [];
    const filter = s.libFilter || "all";
    const hasSess = sessionActive(s);

    if (hasSess) {
      const tracks = [];
      const playlists = [];
      const others = [];
      for (const it of rawLib) {
        const meta = parseItemType(it.ref, it.badges);
        if (meta.isTrack) tracks.push(it);
        else if (meta.isPlaylist || String(it.ref || "").startsWith("b:")) playlists.push(it);
        else others.push(it);
      }

      const children = [
        {
          type: "Card",
          key: "lib_user_card",
          padding: 14,
          variant: "outlined",
          children: [
            {
              type: "ListTile",
              key: "lib_user_tile",
              title: "Mi Biblioteca Sincronizada",
              titleEn: "My synced library",
              subtitle: rawLib.length
                ? "Conectado a tu cuenta · " + rawLib.length + " elementos guardados"
                : "Conectado a tu cuenta oficial de YouTube Music",
              subtitleEn: "Connected to your YouTube Music account",
              leading: { type: "CircleAvatar", key: "lib_avatar", radius: 24, icon: "music" },
              trailing: { type: "Icon", key: "lib_open_account", name: "arrow_forward" },
              onTap: "switch_screen_tab_account"
            }
          ]
        }
      ];

      // Filtro por tipo de contenido guardado.
      children.push({
        type: "Card",
        key: "lib_filter_card",
        padding: 8,
        variant: "outlined",
        children: [
          {
            type: "SingleChildScrollView",
            key: "lib_filter_scroll",
            direction: "horizontal",
            children: [{
              type: "Chips",
              key: "lib_filter",
              value: filter,
              onChange: "filter_library",
              options: [
                { value: "all", label: "Todo", labelEn: "All" },
                { value: "playlists", label: "Listas", labelEn: "Playlists" },
                { value: "albums", label: "Álbumes", labelEn: "Albums" },
                { value: "tracks", label: "Me gusta", labelEn: "Liked" }
              ]
            }]
          }
        ]
      });

      if (!s.libraryLoaded) {
        children.push({ type: "Skeleton", key: "skel_lib", variant: "list", rows: 8, padding: 12 });
      } else if (rawLib.length) {
        const showPlaylists = filter === "all" || filter === "playlists";
        const showAlbums = filter === "all" || filter === "albums";
        const showTracks = filter === "all" || filter === "tracks";
        let shown = 0;
        if (showPlaylists && playlists.length) {
          shown++;
          children.push({
            type: "titleRail",
            key: "lib_rail_playlists",
            title: "Tus listas de reproducción",
            items: playlists
          });
        }
        if (showAlbums && others.length) {
          shown++;
          children.push({
            type: "titleRail",
            key: "lib_rail_albums",
            title: "Álbumes guardados",
            items: others
          });
        }
        if (showTracks && tracks.length) {
          shown++;
          children.push({
            type: "titleRail",
            key: "lib_rail_tracks",
            title: "Canciones que te gustan (Me gusta)",
            items: tracks.slice(0, 20)
          });
          children.push({
            type: "Card",
            key: "lib_tracks_card",
            padding: 8,
            variant: "outlined",
            children: [
              { type: "Text", key: "lib_t_head", text: "Tus Temas Favoritos", style: "h4" },
              ...tracks.slice(0, 15).map((item, idx) => renderMusicTile(item, idx, "lib_t_"))
            ]
          });
        }
        if (!shown) {
          children.push({
            type: "emptyState",
            key: "lib_filter_empty",
            title: "Nada en este filtro",
            titleEn: "Nothing in this filter",
            text: "Selecciona «Todo» arriba para ver toda tu biblioteca.",
            icon: "filter_list"
          });
        }
      } else {
        children.push({
          type: "emptyState",
          key: "lib_empty",
          title: s.libraryError ? "No se pudo cargar tu biblioteca" : "No se encontraron listas guardadas",
          text: s.libraryError || "Comprueba que las listas estén guardadas en la biblioteca de YouTube Music y actualiza para volver a sincronizar.",
          icon: s.libraryError ? "warning" : "music"
        });
      }

      bodyNode = {
        type: "SingleChildScrollView",
        key: "lib_scroll",
        children: [
          {
            type: "Column",
            key: "lib_col",
            gap: 16,
            padding: 12,
            children
          }
        ]
      };
    } else {
      // Modo Invitado con diseño interactivo, explicaciones visuales y pegado directo en 1 paso
      bodyNode = {
        type: "SingleChildScrollView",
        key: "lib_guest_scroll",
        children: [
          {
            type: "Column",
            key: "lib_guest_col",
            padding: 16,
            gap: 16,
            children: [
              {
                type: "banner",
                key: "guest_banner",
                role: "info",
                title: "Estás en Modo Invitado",
                text: "Vincula tu cuenta de YouTube Music para acceder a tus «Me gusta», artistas seguidos y playlists personales."
              },
              {
                type: "Card",
                key: "card_guide",
                padding: 16,
                variant: "outlined",
                children: [
                  { type: "Text", key: "g_t1", text: "Guía Rápida: Cómo extraer tus cookies", style: "h3" },
                  { type: "Text", key: "g_sub", text: "Elige el método según el dispositivo que estés usando:", color: "muted" },
                  {
                    type: "ExpansionTile",
                    key: "guest_guide_methods",
                    items: [
                      {
                        key: "m_android",
                        title: "Método 1: En tu celular Android",
                        titleEn: "Method 1: On your Android phone",
                        children: [
                          { type: "Text", key: "g_m1_1", text: "1. Instala Kiwi Browser desde la Google Play Store." },
                          { type: "Text", key: "g_m1_2", text: "2. En Kiwi, abre la Chrome Web Store e instala la extensión Cookie-Editor." },
                          { type: "Text", key: "g_m1_3", text: "3. Entra a music.youtube.com e inicia sesión con tu cuenta de Google." },
                          { type: "Text", key: "g_m1_4", text: "4. Toca el menú de tres puntos de Kiwi, elige Cookie-Editor, Export y Export as Header Value." },
                          { type: "Text", key: "g_m1_5", text: "5. Pega el texto en la caja de abajo y pulsa Vincular." }
                        ]
                      },
                      {
                        key: "m_pc",
                        title: "Método 2: Desde una PC",
                        titleEn: "Method 2: From a computer",
                        children: [
                          { type: "Text", key: "g_m2_1", text: "1. Abre music.youtube.com en Chrome o Edge con tu cuenta de Google." },
                          { type: "Text", key: "g_m2_2", text: "2. Presiona F12 (Herramientas de Desarrollador) y ve a la pestaña Red (Network)." },
                          { type: "Text", key: "g_m2_3", text: "3. Recarga la página y haz clic en cualquier petición (por ejemplo browse o next)." },
                          { type: "Text", key: "g_m2_4", text: "4. En Encabezados de solicitud, copia todo el valor que sale en «cookie»." },
                          { type: "Text", key: "g_m2_5", text: "5. Envíatelo a tu móvil por WhatsApp o Telegram y pégalo abajo." }
                        ]
                      }
                    ]
                  }
                ]
              },
              {
                type: "Card",
                key: "card_paste",
                padding: 16,
                variant: "filled",
                children: [
                  { type: "Text", key: "p_title", text: "Vincular Cuenta en 1 Solo Paso", style: "h3" },
                  { type: "Text", key: "p_desc", text: "Pega aquí todo el texto de tus cookies. El plugin lo analiza, divide y guarda automáticamente:", color: "muted" },
                  {
                    type: "TextField",
                    key: "rawCookiesInput",
                    labelText: "Pegar Cookies Aquí",
                    hintText: "Ej. SAPISID=...; __Secure-3PAPISID=...; (o texto de Cookie-Editor)",
                    maxLines: 4
                  },
                  {
                    type: "ElevatedButton",
                    key: "btn_save_cookies",
                    labelText: "Vincular Cuenta Ahora",
                    icon: "check",
                    onPressed: "save_cookies"
                  }
                ]
              }
            ]
          }
        ]
      };
    }
  } else {
    // tab === "account"
    const hasSess = sessionActive(s);
    const is8d = kino.config.get("audio8d") === true;
    const qual = kino.config.get("quality") || "aac";
    const sessionBad = hasSess && s.accountChecked && !s.accountName;
    bodyNode = {
      type: "SingleChildScrollView",
      key: "acc_scroll",
      children: [
        {
          type: "Column",
          key: "acc_col",
          padding: 16,
          gap: 16,
          children: [
            {
              type: "Card",
              key: "card_account",
              padding: 16,
              variant: "outlined",
              children: [
                {
                  type: "ListTile",
                  key: "acc_status_tile",
                  title: "Cuenta de YouTube Music",
                  titleEn: "YouTube Music account",
                  subtitle: !hasSess ? "Modo invitado (sin sesión)"
                    : sessionBad ? "YouTube no reconoce esta sesión"
                    : s.accountName ? "Sesión activa como " + s.accountName
                    : "Sesión activa y sincronizada",
                  subtitleEn: !hasSess ? "Guest mode (no session)"
                    : sessionBad ? "YouTube does not recognise this session"
                    : s.accountName ? "Session active as " + s.accountName
                    : "Session active and synced",
                  leading: { type: "CircleAvatar", key: "acc_avatar", radius: 24, icon: !hasSess ? "person" : sessionBad ? "info" : "check" },
                  trailing: { type: "Icon", key: "acc_status_icon", name: !hasSess ? "info" : sessionBad ? "info" : "check" }
                },
                ...(hasSess ? [
                  {
                    type: "ElevatedButton",
                    key: "btn_linked",
                    labelText: "Cuenta vinculada",
                    labelTextEn: "Account linked",
                    icon: "check",
                    enabled: false
                  },
                  {
                    type: "TextButton",
                    key: "btn_logout",
                    labelText: "Cerrar sesión",
                    labelTextEn: "Log out",
                    onPressed: "logout_session"
                  }
                ] : [
                  accountOptionsNode()
                ])
              ]
            },
            {
              type: "settings",
              key: "acc_settings_form",
              keys: [
                "about",
                "account",
                "cookieA",
                "cookieB",
                "cookieC",
                "cookieD",
                "linked",
                "logout",
                "playback",
                "quality",
                "method",
                "audio8d",
                "content",
                "hideExplicit"
              ],
              onSaved: "settings_saved"
            },
            {
              type: "Card",
              key: "card_recommended",
              padding: 16,
              variant: "outlined",
              children: [{ type: "Text", key: "rec_head", text: "Plugins recomendados", style: "h3" }].concat(
                RECOMMENDED_PLUGINS.map((p) => ({
                  type: "ListTile",
                  key: "tile_install_" + p.key,
                  title: p.title,
                  subtitle: lastInstalled[p.repo] === true ? "Instalado" : p.subtitle,
                  trailing: { type: "Icon", name: lastInstalled[p.repo] === true ? "check" : "download" },
                  onTap: "install_plugin_" + p.key
                }))
              )
            },
            {
              type: "Card",
              key: "card_about",
              padding: 16,
              variant: "outlined",
              children: [
                {
                  type: "ListTile",
                  key: "about_tile",
                  title: "Acerca de YTMusic para Kino",
                  titleEn: "About YTMusic for Kino",
                  subtitle: "Versión 0.5.20 · Creado por JuandreXter",
                  subtitleEn: "Version 0.5.20 · Created by JuandreXter",
                  leading: { type: "CircleAvatar", key: "about_avatar", radius: 24, icon: "info" },
                  dense: true
                }
              ]
            }
          ]
        }
      ]
    };
  }

  const tabs = tab !== "search" ? {
    type: "TabBar",
    key: "ytm_tab_bar",
    value: tab,
    onChanged: "switch_screen_tab",
    tabs: [
      { value: "trending", label: "Explorar", labelEn: "Explore" },
      { value: "ai", label: "Playlist IA", labelEn: "AI Playlist" },
      { value: "library", label: "Mi Música", labelEn: "My Music" },
      { value: "account", label: "Ajustes", labelEn: "Settings" }
    ]
  } : null;

  // Cada sección ya es un ScrollView. Insertar las pestañas en ese mismo scroll
  // evita que un Column padre sin altura deje el contenido invisible en Kino TV.
  if (tabs && bodyNode && bodyNode.children && bodyNode.children[0] && bodyNode.children[0].children) {
    bodyNode.children[0].children.unshift(tabs);
  }

  return {
    type: "Scaffold",
    key: "ytm_main_scaffold",
    floatingActionButton: tab !== "search" ? {
      type: "FloatingActionButton",
      key: "fab_search",
      icon: "search",
      labelText: "Buscar música",
      labelTextEn: "Search music",
      onPressed: "open_search"
    } : null,
    // Back on the search view goes back to the tab it came from (Flutter's PopScope); the next Back leaves to Home.
    onBack: tab === "search" ? "close_search" : null,
    appBar: tab === "search" ? {
      type: "AppBar",
      mergeWithKinoBar: true,
      leading: { type: "IconButton", key: "search_back", icon: "arrow_back", labelText: "Volver", labelTextEn: "Back", onPressed: "close_search" },
      title: "Buscar",
      titleEn: "Search"
    } : null,
    body: bodyNode
  };
}

export async function screenEvent({ name, arg, value, state, route, device, lang, installed }) {
  lastInstalled = installed || {};
  kino.log("ytmusic screenEvent called:", { name, arg, value, stateInputs: state && state.inputs });
  const s = Object.assign({}, state || {});

  // "account_linked": Kino saved the cookies (storeAs.thenEvent) and tells the screen; it reloads like a refresh, now with the account.
  if (name === "open" || name === "refresh_screen" || name === "account_linked") {
    // On a reload the saved cookies are the truth again (the screen-only flags of link_account / logout_session end here).
    s.sessionOff = false;
    s.linkedNow = false;
    await checkSession(s);
    kino.log("ytmusic screenEvent: loading charts and home rows");
    try {
      const [homeRows, sectionData] = await Promise.all([
        home().catch(() => []),
        section({ tab: "tendencias" }).catch(() => ({ rows: [] }))
      ]);

      const rails = [];
      const seenRails = new Set();
      for (const r of [...homeRows, ...(sectionData.rows || [])]) {
        if (!r || !r.items || !r.items.length) continue;
        const title = r.title || "Música destacada";
        if (seenRails.has(title)) continue;
        seenRails.add(title);
        rails.push({ title, items: r.items.slice(0, 25) });
      }

      s.rails = rails;
      s.heroItem = rails[0]?.items?.[0] || null;
      s.trendingLoaded = true;
      // Whether this Inicio was asked with the account: after linking or logging out the screen offers to load it again.
      s.railsAuth = sessionActive(s);
      kino.log("ytmusic screenEvent: rails loaded count:", rails.length);
    } catch (e) {
      kino.log("ytmusic screenEvent: error loading trending:", e && e.message);
      s.trendingLoaded = true;
      s.railsAuth = sessionActive(s);
    }

    if (savedCookie()) {
      try {
        const libRows = await libraryRows();
        const lItems = [];
        for (const r of libRows) {
          for (const it of r.items) {
            if (it.ref && !lItems.some((x) => x.ref === it.ref)) {
              lItems.push(it);
            }
          }
        }
        s.libraryItems = lItems;
        s.libraryError = "";
        s.libraryLoaded = true;
      } catch (e) {
        kino.log("ytmusic screenEvent: error loading library:", e && e.message);
        s.libraryError = "No se pudieron cargar las listas. Revisa la sesión y vuelve a sincronizar.";
        s.libraryLoaded = true;
      }
    } else {
      s.libraryLoaded = true;
    }
    return { state: s };
  }

  if (name === "open_search") {
    s.prevTab = s.tab !== "search" ? s.tab : (s.prevTab || "trending");
    s.tab = "search";
    return { state: s };
  }

  if (name === "close_search") {
    s.tab = s.prevTab || "trending";
    return { state: s };
  }

  if (name === "switch_screen_tab") {
    s.tab = value || "trending";
    // TabBar envía este evento con value: "library". Recargar aquí evita
    // depender del botón secundario switch_screen_tab_library.
    if (s.tab === "library") {
      s.libraryLoaded = false;
      if (savedCookie()) {
        try {
          const rows = await libraryRows();
          s.libraryItems = rows.flatMap((r) => r.items || []);
          s.libraryError = "";
          kino.log("ytmusic screenEvent: library synced items:", s.libraryItems.length);
        } catch (e) {
          kino.log("ytmusic screenEvent: library reload failed:", e && e.message);
          s.libraryError = "No se pudieron cargar las listas. Revisa la sesión y vuelve a sincronizar.";
        }
      }
      s.libraryLoaded = true;
      return { state: s, toast: s.libraryItems && s.libraryItems.length ? "Biblioteca sincronizada" : undefined };
    }
    return { state: s };
  }

  if (name === "switch_screen_tab_account") {
    s.tab = "account";
    return { state: s };
  }

  if (name === "switch_screen_tab_library") {
    s.tab = "library";
    s.libraryLoaded = false;
    if (savedCookie()) {
      try {
        const rows = await libraryRows();
        s.libraryItems = rows.flatMap((r) => r.items || []);
        s.libraryError = "";
      } catch (e) {
        kino.log("ytmusic screenEvent: library reload failed:", e && e.message);
        s.libraryError = "No se pudieron cargar las listas. Revisa la sesión y vuelve a sincronizar.";
      }
    }
    s.libraryLoaded = true;
    return { state: s, toast: s.libraryItems && s.libraryItems.length ? "Biblioteca sincronizada" : undefined };
  }

  if (name === "filter_trending") {
    s.trendFilter = value || "all";
    return { state: s };
  }

  if (name === "filter_search") {
    s.searchFilter = value || "all";
    return { state: s };
  }

  if (name === "filter_library") {
    s.libFilter = value || "all";
    return { state: s };
  }

  if (name === "quick_search_chip") {
    const q = String(value || "").trim();
    if (q) {
      if (!s.inputs) s.inputs = {};
      s.inputs.searchQuery = q;
      return screenEvent({ name: "do_search", value: q, state: s, route, device, lang });
    }
    return { state: s };
  }

  if (name === "quick_ai_prompt") {
    const prompt = String(value || "").trim();
    if (prompt) {
      if (!s.inputs) s.inputs = {};
      s.inputs.aiPrompt = prompt;
      return screenEvent({ name: "generate_ai", value: prompt, state: s, route, device, lang });
    }
    return { state: s };
  }

  if (name === "save_cookies") {
    let raw = String(
      value || arg || (s.inputs && (s.inputs.rawCookiesInput || s.inputs.cookies)) || ""
    ).trim();
    if (!raw) {
      return { toast: "Pega tus cookies antes de vincular" };
    }
    if (raw.startsWith("cookie:") || raw.startsWith("Cookie:")) {
      raw = raw.slice(7).trim();
    }
    if (raw.startsWith("[") && raw.endsWith("]")) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          raw = arr.map((c) => c.name + "=" + c.value).join("; ");
        }
      } catch (e) {}
    }
    if (!/SAPISID|__Secure-3PAPISID|HSID|SSID|SID/i.test(raw)) {
      return { toast: "Las cookies no parecen válidas (deben contener SAPISID o SID)" };
    }
    const chunk = 500;
    const cfg = {
      cookieA: raw.slice(0, chunk),
      cookieB: raw.slice(chunk, chunk * 2),
      cookieC: raw.slice(chunk * 2, chunk * 3),
      cookieD: raw.slice(chunk * 3, chunk * 4)
    };
    s.tab = "library";
    s.libraryLoaded = false;
    return {
      config: cfg,
      state: s,
      toast: "¡Cuenta vinculada con éxito!"
    };
  }

  if (name === "do_search" || name === "searched") {
    const q = String(value || arg || (s.inputs && (s.inputs.searchQuery || s.inputs.search)) || "").trim();
    if (!q) {
      return { toast: "Escribe algo para buscar", ui: [{ hide: "search_loading_card" }] };
    }
    s.searching = true;
    s.searched = true;
    s.lastQuery = q;
    try {
      const rawResults = await search({ q });
      const items = Array.isArray(rawResults) ? rawResults : (rawResults && Array.isArray(rawResults.items) ? rawResults.items : []);
      s.searchResults = items.slice(0, 50);
    } catch (e) {
      kino.log("ytmusic screenEvent: search exception:", e && e.message ? e.message : e);
      s.searchResults = [];
    }
    s.searching = false;
    return { state: s, ui: [{ hide: "search_loading_card" }] };
  }

  if (name === "generate_ai") {
    const prompt = String(value || arg || (s.inputs && (s.inputs.aiPrompt || s.inputs.prompt)) || "").trim();
    if (!prompt) {
      return { toast: "Escribe tu idea para la playlist" };
    }
    if (typeof kino.ai !== "object" || typeof kino.ai.ask !== "function") {
      return { toast: "Kino AI no está disponible en este dispositivo" };
    }
    s.aiLoading = true;
    try {
      const system = "You are a professional music curator. Return ONLY a valid JSON array of 5 to 7 song recommendations for the given user request. Each array element MUST be an object with string fields \"title\" and \"artist\". Do not include markdown codeblocks, notes, or explanations.";
      const res = await kino.ai.ask({ prompt, system, json: true, maxChars: 1200 });
      if (!res || !res.ok) {
        s.aiLoading = false;
        return { state: s, toast: res?.error || "Error al consultar a la IA" };
      }
      let list = [];
      try {
        const cleaned = (res.text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
        const parsed = JSON.parse(cleaned);
        list = Array.isArray(parsed) ? parsed : (parsed.songs || parsed.tracks || parsed.items || []);
      } catch (e) {}
      const tracks = [];
      for (const song of list.slice(0, 7)) {
        if (!song || !song.title) continue;
        const trackQ = song.title + (song.artist ? " " + song.artist : "");
        try {
          const found = await search({ q: trackQ });
          const items = Array.isArray(found) ? found : (found && Array.isArray(found.items) ? found.items : []);
          if (items.length) {
            const track = items.find((x) => x.ref && x.ref.startsWith("t:")) || items[0];
            if (track && !tracks.some((x) => x.ref === track.ref)) {
              tracks.push(track);
            }
          }
        } catch (err) {}
      }
      s.aiTracks = tracks;
    } catch (e) {
      kino.log("ytmusic screenEvent: generate_ai exception:", e && e.message ? e.message : e);
    }
    s.aiLoading = false;
    return { state: s };
  }

  if (name === "toggle_quality_setting") {
    const cur = kino.config.get("quality") === "opus" ? "aac" : "opus";
    return { state: s, config: { quality: cur }, toast: "Formato: " + cur.toUpperCase() };
  }

  if (name.startsWith("install_plugin_")) {
    const wanted = RECOMMENDED_PLUGINS.find((p) => "install_plugin_" + p.key === name);
    if (!wanted) return { state: s };
    return { state: s, go: { installPlugin: { repo: wanted.repo } } };
  }

  if (name === "link_account") {
    if (!(kino.visualBrowser && kino.visualBrowser.available)) {
      return { state: s, toast: "Este aparato no permite vincular con el navegador. Usa la opción manual." };
    }
    // The cookies go straight into the first cookie setting (Kino writes them; this script never sees them).
    const r = await kino.visualBrowser.open({
      url: "https://accounts.google.com/ServiceLogin?service=youtube&continue=" + encodeURIComponent("https://music.youtube.com/"),
      title: "YouTube Music",
      userAgent: "browser",
      doneWhen: { cookies: ["SAPISID"] },
      collect: { cookies: LINK_COOKIES, storeAs: { setting: "cookieA", spill: ["cookieB", "cookieC", "cookieD"], format: "header", thenEvent: "account_linked" } },
      timeoutMs: 600000
    });
    // Kino writes the cookies once this call ends; linkedNow shows the linked state at once, until the setting is read.
    if (r.status === "done" && r.stored) return { state: Object.assign({}, s, { linkedNow: true, sessionOff: false }), toast: "Cuenta vinculada" };
    return { state: s, toast: r.status === "closed" ? "No se vinculó la cuenta" : "No se pudo vincular la cuenta" };
  }

  if (name === "toggle_8d_setting") {
    const cur = kino.config.get("audio8d") === true;
    return { state: s, config: { audio8d: !cur }, toast: !cur ? "Audio 8D activado" : "Audio 8D desactivado" };
  }

  if (name === "logout_session") {
    return {
      state: Object.assign({}, s, { libraryItems: [], linkedNow: false, sessionOff: true }),
      clearSettings: COOKIE_KEYS.slice(),
      toast: "Sesión cerrada"
    };
  }

  // El formulario de ajustes de Kino terminó de guardar (Guardar o un cambio automático).
  if (name === "settings_saved") {
    const keys = value && Array.isArray(value.keys) ? value.keys : [];
    const acted = (value && value.action) || "";
    const ok = !value || value.ok !== false;
    if (keys.includes("logout") || acted === "logout") {
      s.libraryItems = [];
      s.libraryError = "";
      s.libraryLoaded = true;
    } else if (keys.some((k) => k === "cookieA" || k === "cookieB" || k === "cookieC" || k === "cookieD")) {
      s.libraryLoaded = false;
      if (savedCookie()) {
        try {
          const rows = await libraryRows();
          s.libraryItems = rows.flatMap((r) => r.items || []);
          s.libraryError = "";
        } catch (e) {
          s.libraryError = "No se pudieron cargar las listas. Revisa la sesión y vuelve a sincronizar.";
        }
      } else {
        s.libraryItems = [];
      }
      s.libraryLoaded = true;
    }
    return { state: s, toast: ok ? "Ajustes guardados" : "Revisa los ajustes: no se pudieron guardar" };
  }

  return { state: s };
}

// =============================================================================================
// PANEL DEL REPRODUCTOR (apiVersion 14 / enhancements)
// =============================================================================================

async function fetchLyrics(videoId) {
  try {
    const n = await safe("lyrics next", () => yt("next", { videoId }), null);
    if (!n) return null;
    const tabs = n.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs || [];
    let browseId = null;
    for (const t of tabs) {
      const b = t.tabRenderer?.endpoint?.browseEndpoint?.browseId;
      if (b && (b.startsWith("MPLY") || /letra|lyrics/i.test(t.tabRenderer?.title?.runs?.[0]?.text || ""))) {
        browseId = b;
        break;
      }
    }
    if (!browseId) return null;
    const b = await safe("lyrics browse", () => yt("browse", { browseId }), null);
    const shelf = b?.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer;
    if (!shelf) return null;
    const text = shelf.description?.runs?.map((r) => r.text).join("") || "";
    const footer = shelf.footer?.runs?.map((r) => r.text).join("") || "";
    return { text, footer };
  } catch (e) {
    return null;
  }
}

async function fetchUpNext(videoId) {
  try {
    const n = await safe("next queue", () => yt("next", { videoId, playlistId: "RDAMVM" + videoId }), null);
    if (!n) return [];
    const tab0 = n.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0];
    const queue = tab0?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents || [];
    const list = [];
    for (const item of queue) {
      const r = item.playlistPanelVideoRenderer;
      if (!r || !r.videoId || r.videoId === videoId) continue;
      const title = r.title?.runs?.[0]?.text || "Canción";
      const artist = r.shortBylineText?.runs?.map((x) => x.text).join("") || "";
      const length = r.lengthText?.runs?.[0]?.text || "";
      const thumbs = r.thumbnail?.thumbnails || [];
      const thumb = thumbs.length ? thumbs[thumbs.length - 1].url : "";
      list.push({ videoId: r.videoId, title, artist, length, thumb });
      if (list.length >= 20) break;
    }
    return list;
  } catch (e) {
    return [];
  }
}

export async function panel(context) {
  const c = context || {};
  const currentTab = c.tab || "lyrics";
  const p = parseRef(c.ref);
  const videoId = p && p.type === "t" ? p.id : "";
  const isScreen = (c.features || []).includes("screen");

  if (isScreen) {
    let rootNode;
    if (currentTab === "lyrics") {
      const lyricsData = videoId ? await fetchLyrics(videoId) : null;
      rootNode = {
        type: "SingleChildScrollView",
        key: "p_lyrics_scroll",
        children: [
          {
            type: "Column",
            key: "p_lyrics_col",
            padding: 16,
            gap: 12,
            children: lyricsData && lyricsData.text ? [
              { type: "Text", key: "p_ly_head", text: "Letra de la Canción", style: "h3" },
              { type: "Text", key: "p_ly_text", text: lyricsData.text, style: "body" },
              ...(lyricsData.footer ? [{ type: "Text", key: "p_ly_foot", text: lyricsData.footer, style: "caption", color: "muted" }] : [])
            ] : [
              { type: "emptyState", key: "p_ly_empty", title: "Sin letra disponible", titleEn: "No lyrics available", text: "No se encontró letra para este tema.", icon: "subtitles" }
            ]
          }
        ]
      };
    } else if (currentTab === "upnext") {
      const nextTracks = videoId ? await fetchUpNext(videoId) : [];
      rootNode = nextTracks.length ? {
        type: "ListView",
        key: "p_queue_list",
        items: nextTracks.map((item, idx) => ({
          type: "ListTile",
          key: "pq_" + idx,
          title: item.title,
          subtitle: item.artist + (item.length ? " · " + item.length : ""),
          leading: {
            type: "CircleAvatar",
            image: item.thumb || "",
            radius: 24,
            text: (item.title || "YT").slice(0, 2).toUpperCase()
          },
          trailing: {
            type: "Icon",
            name: "play"
          },
          onTap: {
            go: {
              play: {
                ref: trackRef(item.videoId, item.title),
                kind: "music",
                id: "t." + item.videoId,
                title: item.title
              }
            }
          }
        }))
      } : {
        type: "emptyState",
        key: "p_q_empty",
        title: "Sin canciones sugeridas",
        titleEn: "No suggested songs",
        text: "No se encontraron canciones sugeridas.",
        icon: "music"
      };
    } else {
      const is8d = kino.config.get("audio8d") === true;
      const qual = kino.config.get("quality") || "aac";
      rootNode = {
        type: "Column",
        key: "p_opt_col",
        padding: 16,
        gap: 12,
        children: [
          { type: "Text", key: "p_opt_head", text: "Opciones de Sonido", style: "h3" },
          {
            type: "Card",
            key: "p_card_8d",
            padding: 12,
            children: [
              { type: "Text", key: "p_t_8d", text: "Audio 8D envolvente", style: "h4" },
              { type: "Text", key: "p_s_8d", text: is8d ? "Actualmente activo" : "Desactivado", color: "muted" },
              { type: "ElevatedButton", key: "btn_p_8d", labelText: is8d ? "Desactivar 8D" : "Activar 8D", icon: "bolt", onPressed: "toggle_panel_8d" }
            ]
          },
          {
            type: "Card",
            key: "p_card_qual",
            padding: 12,
            children: [
              { type: "Text", key: "p_t_q", text: "Formato de Audio", style: "h4" },
              { type: "Text", key: "p_s_q", text: qual === "opus" ? "Opus (mayor fidelidad)" : "AAC (alta compatibilidad)", color: "muted" },
              { type: "ElevatedButton", key: "btn_p_q", labelText: qual === "opus" ? "Cambiar a AAC" : "Cambiar a Opus", icon: "tune", onPressed: "toggle_panel_quality" }
            ]
          }
        ]
      };
    }

    return {
      format: "screen",
      title: "YouTube Music",
      accent: "#FF0050",
      tabs: [
        { id: "lyrics", label: "Letras", labelEn: "Lyrics" },
        { id: "upnext", label: "A continuación", labelEn: "Up next" },
        { id: "audio", label: "Opciones", labelEn: "Options" }
      ],
      tab: currentTab,
      root: rootNode
    };
  }

  // Legacy panel format
  const elements = [];
  if (currentTab === "lyrics") {
    const lyricsData = videoId ? await fetchLyrics(videoId) : null;
    elements.push({ type: "section", title: "Letra" });
    if (lyricsData && lyricsData.text) {
      elements.push({ type: "text", text: lyricsData.text });
      if (lyricsData.footer) elements.push({ type: "status", text: lyricsData.footer });
    } else {
      elements.push({ type: "status", text: "Sin letra disponible" });
    }
  } else if (currentTab === "upnext") {
    elements.push({ type: "section", title: "A continuación" });
    const nextTracks = videoId ? await fetchUpNext(videoId) : [];
    if (nextTracks.length) {
      for (const t of nextTracks.slice(0, 6)) {
        elements.push({ type: "status", text: t.title + " · " + t.artist });
      }
    } else {
      elements.push({ type: "status", text: "Sin canciones siguientes" });
    }
  } else {
    const is8d = kino.config.get("audio8d") === true;
    const qual = kino.config.get("quality") || "aac";
    elements.push({ type: "section", title: "Opciones" });
    elements.push({ type: "status", text: "Audio 8D: " + (is8d ? "Activo" : "Desactivado") });
    elements.push({ type: "button", key: "btn_p_8d", label: is8d ? "Desactivar 8D" : "Activar 8D" });
    elements.push({ type: "status", text: "Formato: " + qual.toUpperCase() });
    elements.push({ type: "button", key: "btn_p_q", label: "Alternar AAC/Opus" });
  }

  return {
    presentation: "panel",
    title: "YouTube Music",
    tabs: [
      { id: "lyrics", label: "Letras", labelEn: "Lyrics" },
      { id: "upnext", label: "A continuación", labelEn: "Up next" },
      { id: "audio", label: "Opciones", labelEn: "Options" }
    ],
    tab: currentTab,
    elements
  };
}

export async function panelAction(event, context) {
  const name = typeof event === "string" ? event : (event.name || event.key);
  if (name === "toggle_panel_8d" || name === "btn_p_8d") {
    const cur = kino.config.get("audio8d") === true;
    return { toast: !cur ? "Audio 8D activado" : "Audio 8D desactivado", config: { audio8d: !cur } };
  }
  if (name === "toggle_panel_quality" || name === "btn_p_q") {
    const cur = kino.config.get("quality") === "opus" ? "aac" : "opus";
    return { toast: "Formato: " + cur.toUpperCase(), config: { quality: cur } };
  }
  return null;
}

export async function playerEvent(event, context) {
  return null;
}
