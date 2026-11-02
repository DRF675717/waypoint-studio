# Third-party components / Сторонние компоненты

| Component | Version | License | Where |
|---|---|---|---|
| [Leaflet](https://leafletjs.com) | 1.9.4 | BSD-2-Clause | `app/vendor/leaflet` |
| [Leaflet.GridLayer.GoogleMutant](https://gitlab.com/IvanSanchez/Leaflet.GridLayer.GoogleMutant) | — | BSD-3-Clause | `app/vendor/Leaflet.GoogleMutant.js` |
| [CesiumJS](https://cesium.com/platform/cesiumjs/) | 1.121 | Apache-2.0 | `app/vendor/cesium` |
| [JSZip](https://stuk.github.io/jszip/) | 3.10.1 | MIT (or GPLv3) | `app/vendor/jszip.min.js` |
| [Electron](https://www.electronjs.org) | — | MIT | desktop shell (not in the repository) |
| [libmtp](https://libmtp.sourceforge.net) | — | LGPL-2.1 | linked dynamically by `bridge/wsbridge` |

Map imagery, terrain, geocoding and 3D tiles come from online services (Esri, Google, OpenStreetMap, Open-Meteo,
Cesium ion, Airbus OneAtlas, Vantor/Maxar…) under their own terms; keys are supplied by the user and are never stored
in this repository.
