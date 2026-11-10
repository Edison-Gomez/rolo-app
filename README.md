# Rolo · Tu mapa de Bogotá

App móvil hecha con **Ionic 8 + Angular + Capacitor** para guardar lugares y reportar daños en la ciudad (huecos, alumbrado, basuras), con un mapa compartido entre todos los usuarios.

## Qué hace

- **Mapa** con OpenStreetMap (Leaflet), pines con foto y agrupación de puntos cercanos.
- **Agregar puntos** con foto (cámara o galería), categoría, nota y dirección automática.
- **Reportes** de huecos y daños: sin arreglar / arreglado, con foto del antes y el después.
- **Mapa de la comunidad**: lo que publica cada persona lo ven los demás, con "Yo también lo vi".
- **Cómo llegar** a pie, en bici o en carro, con navegación paso a paso.
- **Recordatorios** con notificaciones locales y alertas al estar cerca de un punto.
- **Buscador** que tolera errores de tecleo, **filtros**, **favoritos** y **modo oscuro**.
- Funciona **sin internet**: lo que se agrega se publica al volver la conexión.

## Backend

Los puntos compartidos se guardan en [rolo-api](https://github.com/Edison-Gomez/rolo-api)
(Node.js + Express + TypeScript + MongoDB Atlas), publicada en Render:
`https://rolo-api-osh2.onrender.com/api/v1/puntos`

La casa del usuario nunca se publica, y solo quien publicó un punto puede editarlo o borrarlo.

## Ejecutar

```bash
npm install
ionic serve          # en el navegador
```

## Generar el APK (Android)

```bash
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
```

El APK queda en `android/app/build/outputs/apk/debug/app-debug.apk`. Requiere JDK 21.

## Tecnologías

Ionic 8 · Angular · Capacitor 8 (cámara, geolocalización, notificaciones locales, preferencias) ·
Leaflet + MarkerCluster · OpenStreetMap / Nominatim / OSRM · Wikipedia API (fotos de lugares).
