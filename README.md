# Waypoint Studio

Планировщик маршрутов съёмки для дронов DJI: карта и 3D, симуляция полёта с видом из камеры, проверка маршрута
(рельеф, зоны, батарея, ограничения приложения), генераторы (орбита, кинокадры, картирование, коридор, фасад),
экспорт в DJI Fly / DJI Pilot 2 / Litchi / Google Earth и запись заданий прямо на пульт DJI RC 2 по USB.
Программа работает на компьютере (macOS, Electron), интерфейс на русском и английском.

*A route planner for DJI drone shooting: 2D map and 3D view, flight simulation with the camera view, route check
(terrain, no-fly zones, battery, app limits), generators (orbit, cine shots, mapping, corridor, facade), export to DJI
Fly / DJI Pilot 2 / Litchi / Google Earth, and writing missions straight to the DJI RC 2 remote over USB. Runs locally
(macOS, Electron); the interface is in Russian and English.*

## Структура / Layout

| Папка | Что внутри |
|---|---|
| `app/` | интерфейс (HTML/CSS/JS): карта, 3D, симуляция, проверки, экспорт, пульт, переводы (`js/i18n-en.js`) |
| `desktop/` | оболочка Electron: `main.js` — загрузчик (внутри подписанной программы), `core.js` — программа (локальный сервер, пульт, обновления) |
| `bridge/` | `wsbridge.c` — USB-помощник для пульта DJI RC 2 (libmtp) |
| `tests/` | `run.js` — автотесты, `fuzz.js` — случайные маршруты, `uiaudit.js` — проверка интерфейса на обоих языках |
| `tools/` | сборка (`build.sh`, `mkupd.sh`, `mklight.sh`) и правка переводов (`retip.py`, `setdict.py`) |

Сторонние библиотеки и их лицензии — в [THIRD_PARTY.md](THIRD_PARTY.md).

## Запуск в браузере (без оболочки) / Run in a browser

```
cd app && python3 -m http.server 8765      # затем откройте http://localhost:8765
```
Работа с пультом, геозоны и обновления доступны только в настольной версии.

## Проверка перед выпуском / Checks before a release

```
npm i -D playwright@1.60.0 && npx playwright install chromium   # один раз / once
node tests/run.js              # автотесты + 120 случайных маршрутов
node tests/fuzz.js 300 7       # больше случайных маршрутов: <количество> <seed>
node tests/uiaudit.js          # обрезанные / перекрытые надписи, непереведённые тексты (RU и EN, 1440×900 и 1280×800)
npx eslint                     # статическая проверка кода
```

Что проверяет фаззер: симуляция без NaN и без рывков курса, расчёты, проверка маршрута, каждый экспорт и обратный
импорт (координаты, высоты, действия, наклон камеры). Если экспорт отказывает, во вкладке «Проверка» уже должна быть
ошибка.

## Переводы / Translations

Программа написана по-русски; английский интерфейс получается словарём фраз `app/js/i18n-en.js`, который применяется
на лету (самая длинная фраза — первой, только целые слова). Чтобы поменять текст и его перевод сразу:

```
python3 tools/retip.py pairs.json    # [[«старый русский», «новый русский», «english»], …]
python3 tools/setdict.py pairs.json  # [[«русский», «english»], …] — только перевод
```

## Обновления / Updates

* **Полное** (~116 МБ) — когда меняются Electron, USB-помощник или загрузчик (`desktop/main.js`, константа `SHELL`).
* **Лёгкое** (~250 КБ) — всё остальное: `core.js` + `app/` ставятся в
  `~/Library/Application Support/Waypoint Studio/live/<версия>`. Если лёгкая версия не открыла окно, при следующем
  запуске программа сама вернётся к встроенной.

## Ключи / Keys

Ключи Google Maps, Cesium ion, Airbus и Maxar вводятся в настройках программы и хранятся только на компьютере
пользователя (`app/config.js` и папка данных программы). В репозиторий они не попадают.

## Известные ограничения / Known limitations

* DJI Fly не поддерживает действие «поворот дрона» и интервальную съёмку в заданиях — программа предупреждает об этом
  во вкладке «Проверка» и не даёт записать такой маршрут.
* При обратном чтении KMZ для DJI Pilot 2 с режимом подвеса «Не управлять» маршрут из двух точек, в каждой из которых
  первое действие — «Наклон камеры», читается неоднозначно (первый наклон может стать наклоном точки).
* Ответственность за полёт несёт пилот: перед взлётом проверяйте маршрут, зоны и погоду.

© Pavel Dorofeev. Все права защищены / All rights reserved.
