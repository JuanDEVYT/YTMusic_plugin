# JuanIPTV

**Plugin para Kino TV** — Genera y prueba cuentas IPTV automáticamente.

## ¿Qué hace?

1. Busca en fuentes públicas cuentas Xtream Codes (servidor + usuario + contraseña)
2. Prueba cuáles están activas en tiempo real
3. Muestra sus canales en la pestaña **En vivo** de Kino, agrupados por categorías

No necesitas ingresar ninguna credencial — el plugin las encuentra solo.

## Instalar en Kino

1. Abre Kino en tu celular o TV
2. Ve a **☰ → Plugins → +** (celular) o **Ajustes → Plugins → Agregar** (TV)
3. Escribe: `<tu-usuario-github>/JuanIPTV`
4. Toca **Agregar → Instalar**
5. Abre la pestaña **En vivo** y espera que carguen los canales (~30 seg la primera vez)

## Ajustes opcionales

| Campo | Descripción |
|---|---|
| Fuente extra | URL de un Pastebin o lista raw con más cuentas Xtream |
| Máximo de servidores | Cuántos servidores probar (5 / 10 / 20) |

## Notas

- Los canales se refrescan automáticamente cada 30 minutos
- Si la lista está vacía, toca "Actualizar" en la pestaña En vivo
- Funciona en Kino 0.9.45+ (Android TV, Fire TV y celular)
