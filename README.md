# Waypoint Studio — исходники

Планировщик маршрутов съёмки для дронов DJI (macOS, Electron).

| Папка | Что внутри |
|---|---|
| `app/` | интерфейс программы (HTML/CSS/JS): карта, 3D, симуляция, проверки, пульт |
| `desktop/` | оболочка Electron: `main.js` — загрузчик (внутри подписанной программы), `core.js` — сама программа (сервер, пульт, обновления) |
| `bridge/` | исходники USB-помощника `wsbridge` для пульта DJI RC 2 |
| `tests/` | автотесты: `node tests/run.js` |
| `tools/` | сборка: `build.sh` (полная), `mkupd.sh` (полное обновление), `mklight.sh` (лёгкое обновление) |

## Проверка перед выпуском
```
npm i -D playwright && npx playwright install chromium   # один раз
node tests/run.js
```

## Обновления
* **Полное** (~116 МБ) — когда меняются Electron, USB-помощник или загрузчик (`desktop/main.js`, константа `SHELL`).
* **Лёгкое** (~2 МБ) — всё остальное: `core.js` + `app/` ставятся в `~/Library/Application Support/Waypoint Studio/live/<версия>`.
  Если лёгкая версия не открыла окно, при следующем запуске программа сама вернётся к встроенной.

Ключ Google Maps хранится в `app/config.js` и в историю не попадает.
