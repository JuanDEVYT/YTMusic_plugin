# YouTube Music para Kino

Plugin de música para Kino (apiVersion 8, Kino 0.9.54 o superior): busca, explora una sección propia, abre álbumes y listas, y reproduce el audio de YouTube Music. Con tu sesión, también ves tus **Me gusta** y **tus listas**.

## Novedades de la 0.5.0

- **Artistas**: aparecen en la búsqueda (con la etiqueta *Artista*; si se llama igual que lo que escribes, va primero) y en las filas. Al abrir uno ves sus canciones y, como "temporadas", sus álbumes y sencillos; cada uno se abre como su propio álbum.
- **Paginación de la búsqueda**: "Ver más resultados" sigue con más canciones.
- **Inicio completo**: Para ti, Explorar y Tendencias piden las filas que YouTube entrega por continuación (antes solo salía la primera tanda). Biblioteca y filas de YouTube Music se piden a la vez.
- **Ocultar contenido explícito** (Ajustes > YouTube Music > Contenido). Los resultados explícitos llevan la etiqueta *Explícito*; también hay *Video*, *Sencillo* y *EP*.
- **Descargas**: el plugin declara `download`. Kino guarda cada canción como un solo archivo para oírla sin conexión (solo en celulares; la descarga la pide y la controla Kino).
- **Copia "Navegador oculto"** en el menú *Servidor* del reproductor: es una copia perezosa, solo se abre si la eliges o si las otras fallan, así que ya no se espera antes del primer sonido.
- **Telemetría** (`"telemetry": true`): Kino recibe los errores y datos técnicos de reproducción que el plugin marca con `kino.log.report`, para poder arreglar fallas. Kino lo muestra en la hoja de consentimiento y hay un interruptor en la pestaña del plugin en Ajustes. No se envían cookies ni lo que escuchas.
- **Pasar lo guardado** (`migrate`): reconoce direcciones de YouTube y de YouTube Music, ids de listas y de álbumes, y ids de canal que la persona tuviera guardados, y los convierte a los refs del plugin. No hace peticiones y no reclama nada que no sea inconfundiblemente de YouTube.
- Cookies en **4 partes** (hasta 2000 caracteres).
- Descripción del álbum, año y fondo en la página de álbumes, listas y artistas; el álbum aparece en la sinopsis de cada canción.

Arreglos:

- Si Kino pide de nuevo porque el servidor rechazó la URL (`options.retry`), ya no se devuelve la URL guardada. Una URL guardada informa cuánto le queda de verdad (antes repetía el plazo original).
- La caché separa AAC y Opus y tiene tope: como máximo 16 canciones y unos 150 KB, de los 256 KB que da `kino.storage`. Antes se llenaba en silencio y dejaba de funcionar.
- Plazos: cada petición de la búsqueda espera 10 s (Kino corta a los 15 s) y las demás 15 s (el límite es 20 s). Álbumes, Inicio y artistas dejan de paginar al pasar de 14 s.
- "No disponible" ya no se decide leyendo el texto traducido del error: se usa el estado `UNPLAYABLE` de YouTube.
- Se quitó una petición de diagnóstico extra que se hacía en cada canción.
- Las canciones en gris (no disponibles) ya no salen en las listas.
- Un `403` con sesión se comprueba repitiendo la petición como invitado: si funciona, es la sesión; si no, es YouTube y el mensaje lo dice.
- Los `hint` del manifiesto pasan de 80 caracteres en la 0.4.2; Kino permite 80 como máximo y ya están recortados.

## Novedades de la 0.4.2

- Cuando YouTube dice que una pista "no está disponible", el error sale al instante con el motivo real y ya no se intenta el navegador oculto (que acababa en un falso "verifica que eres una persona").
- El navegador oculto solo se usa como respaldo en otros fallos; si también falla, se muestra el error original.
- Los registros incluyen `reason=` del `playabilityStatus`.
- Caché del stream resuelto hasta que caduque.

## Novedades de la 0.4.0

- **Tema rojo de YouTube Music** (`theme` en el manifiesto): fondo casi negro, superficies grises y acento rojo-carmesí `#FF0050`. Kino rechaza acentos demasiado parecidos a su propio rojo (`#E50914`, distancia mínima 25 en CIE76), por eso el acento es un rojo algo más carmesí que el `#FF0000` oficial.
- **Icono propio** (`icon.png`, 512×512, 120 KB; el límite es 128 KB) con una nota musical y barras de ecualizador. Si prefieres otro, sustituye `icon.png` (y `icon.svg`) por tu imagen.
- **Sección propia "YT Music"** (en la barra lateral de TV y como chip sobre Inicio en el teléfono) con pestañas **Para ti**, **Explorar** (nuevos álbumes y lo que sugiere YouTube), **Tendencias** (charts) y **Biblioteca** (solo con sesión: Me gusta, tus listas y lo escuchado hace poco), más un destacado con portada que cambia cada día.
- **Categorías**: los "estados de ánimo y géneros" de YouTube Music como mosaicos.
- **Búsqueda mejorada**: pide a la vez canciones, álbumes y listas, las junta sin repetir (canciones primero) y marca cada resultado con una etiqueta *Canción*, *Álbum* o *Lista*. Con `scopedSearch` también se puede buscar dentro de un "Ver más".

## Qué hace y qué no

- Búsqueda de canciones, álbumes, listas y artistas, con paginación; filas de Inicio; álbumes, listas y artistas.
- Reproducción de audio. Pide la canción a YouTube como el cliente de Apple Vision Pro, cuyas URLs googlevideo sirve completas sin PO token (iOS y Android VR solo dejan pasar ~1 MB y el reproductor recibe 403 después). Antes de entregar la URL, el plugin la prueba más allá del primer MB; si falla, pasa al HLS de iOS o a los otros clientes. Puedes elegir AAC u Opus en Ajustes. "Navegador oculto (experimental)" no funciona hoy: YouTube pide verificar que eres una persona.
- No hay podcasts todavía y no ofrece el audio Premium de 256 kbps.
- **Descargas**: Kino llama a `resolve` y guarda el audio progresivo (AAC u Opus) como un solo archivo. Si solo se consigue el HLS de iOS, ese stream incluye video, y Kino descargaría esa variante: prefiere que la descarga use el camino directo (el normal).

## Iniciar sesión (opcional)

Google no permite iniciar sesión con usuario y contraseña desde un plugin, así que se usan las cookies de tu propia sesión. Un ajuste `password` admite 500 caracteres como máximo (límite de Kino que un plugin no puede subir), por eso se pegan en cuatro partes de hasta 500: son 2000 caracteres y Kino permite 12 ajustes con valor, de los que el plugin usa 7.

1. Abre una **ventana de incógnito**, entra a <https://music.youtube.com> con tu cuenta y haz los pasos 2 y 3 ahí. **Al terminar, cierra la ventana de incógnito sin volver a usarla**: así Google no renueva ("rota") esas cookies y la sesión dura mucho más. Si las copias de tu ventana normal, se vuelven inválidas a los pocos días.
2. DevTools (F12) > Network > pulsa cualquier petición a `music.youtube.com` > Request Headers > copia el valor de `cookie`.
3. En la pestaña Console pega esto (con tu cookie entre las comillas invertidas). Filtra solo lo necesario y lo corta en 4 partes:

```js
const s = `PEGA_AQUÍ_LA_COOKIE`;
const keep = ["SID","__Secure-1PSID","__Secure-3PSID","HSID","SSID","APISID","SAPISID","__Secure-1PAPISID","__Secure-3PAPISID","__Secure-1PSIDTS","__Secure-3PSIDTS","LOGIN_INFO","VISITOR_INFO1_LIVE"];
const t = s.split(/;\s*/).filter(p => keep.includes(p.split("=")[0])).join("; ");
[t.slice(0,500), t.slice(500,1000), t.slice(1000,1500), t.slice(1500,2000)].forEach((x,i)=>console.log(`Parte ${i+1}:\n${x}`));
console.log("Total:", t.length);
```

4. En Kino: Ajustes > YouTube Music, pega las partes (las que salgan) y guarda. Kino comprueba la sesión antes de guardar. Si "Total" pasa de 2000, quita las cookies opcionales (`LOGIN_INFO`, `VISITOR_INFO1_LIVE`, las `PSIDTS`).

Las cookies equivalen a tu sesión de Google: no las compartas. Se guardan cifradas en el aparato y el plugin solo puede hablar con `music.youtube.com`, `www.youtube.com` y `*.googlevideo.com`. "Cerrar sesión" las borra de todos tus aparatos.

## Advertencias

- Usar un cliente no oficial va contra las condiciones de servicio de YouTube. Úsalo con criterio y, si te preocupa tu cuenta, no inicies sesión (como invitado funciona la búsqueda y la reproducción).
- El camino directo imita a un cliente oficial (`CLIENTS` en `plugin.js`) y YouTube lo bloquea a ratos (`LOGIN_REQUIRED`). Por eso el plugin declara `"browser": true`: Kino muestra en rojo "Puede abrir páginas web ocultas para encontrar el video" y hay que aceptarlo. La página oculta empieza sin cookies, así que ese camino reproduce como invitado: YouTube le pone anuncios, el plugin los descarta (URLs con `ctier`) y espera a que empiece la canción, por lo que puede tardar hasta unos 25 segundos y fallar si el anuncio es largo. Si Kino devuelve `blocked`, YouTube pidió verificar que eres una persona y Kino nunca resuelve eso: prueba más tarde. Con `"debug": true` el Registro dice qué camino falló y por qué.
- Las URLs de audio van atadas a tu conexión; por eso el plugin las pide en el aparato y Kino las renueva al caducar.

## Descargas y responsabilidad

Descargar audio de YouTube va contra sus condiciones de servicio y puede afectar derechos de autor. Esta versión incluye `download` por decisión de su autor, que asume esa responsabilidad. Si publicas el plugin, Kino puede retirarlo de su índice si recibe un reclamo (mira *Reclamos y retiro de plugins* en la documentación de Kino).

## Por verificar en un aparato real

Esta versión se probó con respuestas simuladas, no contra YouTube ni la app de Kino. Conviene comprobar:

- Que la pantalla de audio de Kino pinte los álbumes del artista como chips de "temporada". Si no lo hace, siguen saliendo en la búsqueda y como filas.
- Que las continuaciones (búsqueda, Inicio, páginas largas) funcionen con el token en el cuerpo **y** en la dirección, como en la web.
- Que las descargas funcionen con las URLs de googlevideo (el rango único `range=0-N`) y que el archivo se reproduzca sin conexión.
- Los datos de los clientes (`CLIENTS`, versiones de iOS, Android VR y Vision Pro): son lo primero que caduca.

## Probar y publicar

Copia la carpeta `sdk/` de [kinotvapp/kino-plugin-archive-audio](https://github.com/kinotvapp/kino-plugin-archive-audio) junto al plugin:

```
node sdk/validate.mjs .
node sdk/run.mjs . search "algo"
node sdk/run.mjs . resolve "t:<videoId de 11 caracteres>"
node sdk/run.mjs --config quality=opus . resolve "t:<videoId>"
```

Publica como repositorio público (no fork) con el topic `kino-plugin`, cambia `author` y `homepage` en `kino-plugin.json`, e instala desde Ajustes > Plugins con `usuario/repo`.
