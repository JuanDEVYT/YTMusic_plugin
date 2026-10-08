# YouTube Music para Kino

Plugin de música para Kino (apiVersion 8, Kino 0.9.54 o superior): busca, explora una sección propia, abre álbumes y listas, y reproduce el audio de YouTube Music. Con tu sesión, también ves tus **Me gusta** y **tus listas**.

## Novedades de la 0.4.0

- **Tema rojo de YouTube Music** (`theme` en el manifiesto): fondo casi negro, superficies grises y acento rojo-carmesí `#FF0050`. Kino rechaza acentos demasiado parecidos a su propio rojo (`#E50914`, distancia mínima 25 en CIE76), por eso el acento es un rojo algo más carmesí que el `#FF0000` oficial.
- **Icono propio** (`icon.png`, 512×512, 120 KB; el límite es 128 KB) con una nota musical y barras de ecualizador. Si prefieres otro, sustituye `icon.png` (y `icon.svg`) por tu imagen.
- **Sección propia "YT Music"** (en la barra lateral de TV y como chip sobre Inicio en el teléfono) con pestañas **Para ti**, **Explorar** (nuevos álbumes y lo que sugiere YouTube), **Tendencias** (charts) y **Biblioteca** (solo con sesión: Me gusta, tus listas y lo escuchado hace poco), más un destacado con portada que cambia cada día.
- **Categorías**: los "estados de ánimo y géneros" de YouTube Music como mosaicos.
- **Búsqueda mejorada**: pide a la vez canciones, álbumes y listas, las junta sin repetir (canciones primero) y marca cada resultado con una etiqueta *Canción*, *Álbum* o *Lista*. Con `scopedSearch` también se puede buscar dentro de un "Ver más".

## Qué hace y qué no

- Búsqueda de canciones, álbumes y listas; filas de Inicio; álbumes y listas con paginación.
- Reproducción de audio. Pide la canción a YouTube como el cliente de Apple Vision Pro, cuyas URLs googlevideo sirve completas sin PO token (iOS y Android VR solo dejan pasar ~1 MB y el reproductor recibe 403 después). Antes de entregar la URL, el plugin la prueba más allá del primer MB; si falla, pasa al HLS de iOS o a los otros clientes. Puedes elegir AAC u Opus en Ajustes. "Navegador oculto (experimental)" no funciona hoy: YouTube pide verificar que eres una persona.
- **No** descarga (no declara `download`), no hay artistas ni podcasts todavía, y no ofrece el audio Premium de 256 kbps.

## Iniciar sesión (opcional)

Google no permite iniciar sesión con usuario y contraseña desde un plugin, así que se usan las cookies de tu propia sesión. Un ajuste `password` admite 500 caracteres, por eso se pegan en tres partes.

1. Abre <https://music.youtube.com> con tu cuenta.
2. DevTools (F12) > Network > pulsa cualquier petición a `music.youtube.com` > Request Headers > copia el valor de `cookie`.
3. En la pestaña Console pega esto (con tu cookie entre las comillas invertidas). Filtra solo lo necesario y lo corta en 3 partes:

```js
const s = `PEGA_AQUÍ_LA_COOKIE`;
const keep = ["SID","__Secure-1PSID","__Secure-3PSID","HSID","SSID","APISID","SAPISID","__Secure-1PAPISID","__Secure-3PAPISID","__Secure-1PSIDTS","__Secure-3PSIDTS","LOGIN_INFO","VISITOR_INFO1_LIVE"];
const t = s.split(/;\s*/).filter(p => keep.includes(p.split("=")[0])).join("; ");
[t.slice(0,500), t.slice(500,1000), t.slice(1000,1500)].forEach((x,i)=>console.log(`Parte ${i+1}:\n${x}`));
console.log("Total:", t.length);
```

4. En Kino: Ajustes > YouTube Music, pega las partes 1, 2 y 3 y guarda. Kino comprueba la sesión antes de guardar. Si "Total" pasa de 1500, quita las cookies opcionales (`LOGIN_INFO`, `VISITOR_INFO1_LIVE`, las `PSIDTS`).

Las cookies equivalen a tu sesión de Google: no las compartas. Se guardan cifradas en el aparato y el plugin solo puede hablar con `music.youtube.com`, `www.youtube.com` y `*.googlevideo.com`. "Cerrar sesión" las borra de todos tus aparatos.

## Advertencias

- Usar un cliente no oficial va contra las condiciones de servicio de YouTube. Úsalo con criterio y, si te preocupa tu cuenta, no inicies sesión (como invitado funciona la búsqueda y la reproducción).
- El camino directo imita a un cliente oficial (`CLIENTS` en `plugin.js`) y YouTube lo bloquea a ratos (`LOGIN_REQUIRED`). Por eso el plugin declara `"browser": true`: Kino muestra en rojo "Puede abrir páginas web ocultas para encontrar el video" y hay que aceptarlo. La página oculta empieza sin cookies, así que ese camino reproduce como invitado: YouTube le pone anuncios, el plugin los descarta (URLs con `ctier`) y espera a que empiece la canción, por lo que puede tardar hasta unos 25 segundos y fallar si el anuncio es largo. Si Kino devuelve `blocked`, YouTube pidió verificar que eres una persona y Kino nunca resuelve eso: prueba más tarde. Con `"debug": true` el Registro dice qué camino falló y por qué.
- Las URLs de audio van atadas a tu conexión; por eso el plugin las pide en el aparato y Kino las renueva al caducar.

## Probar y publicar

Copia la carpeta `sdk/` de [kinotvapp/kino-plugin-archive-audio](https://github.com/kinotvapp/kino-plugin-archive-audio) junto al plugin:

```
node sdk/validate.mjs .
node sdk/run.mjs . search "algo"
node sdk/run.mjs . resolve "t:<videoId de 11 caracteres>"
node sdk/run.mjs --config quality=opus . resolve "t:<videoId>"
```

Publica como repositorio público (no fork) con el topic `kino-plugin`, cambia `author` y `homepage` en `kino-plugin.json`, e instala desde Ajustes > Plugins con `usuario/repo`.
