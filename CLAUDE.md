# CLAUDE.md: Leaf Dash

Context for any Claude (or other AI coding assistant) session working on this repo, and a technical guide for human contributors. Read this first.

## What this is

Leaf Dash is a phone and tablet web app that replaces LeafSpy's interface for a Nissan Leaf. It reads the car through a Bluetooth LE OBD-II adapter and shows a clean, customisable dashboard.

- **Reference car:** 2021 Nissan Leaf ZE1, 40 kWh, Acenta, UK. Units are mph by default. Everything in "Car protocol notes" was confirmed on this car; other cars may differ.
- **Reference adapter:** LELink² (BLE name "OBDBLE", ELM327 v1.5, BLE UART service FFE0/FFE1). It does **not** support `ATCSM1` (silent listening), so the CAN sniffer can't run on it.
- **Runs in:** Chrome on Android (Web Bluetooth). Tablets are supported too.
- **Hosting:** a PWA on GitHub Pages, published from `main`.
- **Licence:** GPL-3.0 (`LICENSE`), including the car pictures. Keep new files compatible with it.
- **Private notes:** the owner keeps personal notes (in-car to-do list, plans, set-up details) in a separate private repository. Never copy personal details into this public repo: no names, devices, locations, home network details, VIN or odometer readings.
- **Content security policy:** a `<meta>` tag in `index.html` allows only the app's own scripts (no inline `<script>` or `onclick="…"` attributes; attach handlers in JS) and only https/wss connections.
- **No build step:** plain HTML, CSS and JS, all loaded in order by `index.html`.

## Hard rules

1. **Read-only, always.** Nothing may modify the car or be able to break it. Every adapter command goes through `isReadOnly()` in `app.js`, and `Elm.send()` rejects anything else. Only adapter setup/info AT commands, service `21xx` (LBC group reads) and `22xxxx` (read data by identifier) are allowed. Never add write services (`2E`, `2F`, `31`, `27`, `10`, `11`, `14`, `28`, `85` …) or loosen the allowlist. Keep the "read-only" statement in Settings → About.
2. **Not overcomplicated.** Informative and customisable, without walls of data nobody will read. Advanced and diagnostic tools stay behind **Developer mode** (Settings), which shows the Debug tab.
3. **Keep the look.** Keep the current dark theme and design. Changes should fit it, not restyle it.
4. **Add-ons are opt-in.** Home Assistant, MQTT and ABRP are each enabled in Settings → Add-ons, behind a confirmation (with a tick box) saying data will be sent out. They never send in demo mode, and location is stripped unless that add-on allows it.
5. **Dashboard editing:** simple pick-and-reorder is the default. The advanced free layout editor is a toggle in Settings.
6. **Copyright:** the generic drawn car must not replicate the ZE1 design. The `car-rear.webp` and `car-side.webp` pictures are the owner's own models, released under the project's GPL-3.0 licence.

## Working style

- After changes: run `node --check` on every JS file, bump `VERSION` in `sw.js`, and test in headless Chrome (see Testing).
- **Bump the app version with every pull request** (`LeafDash.version` in `metrics.js`, currently `4.7`). It's shown in Settings → About, so users can tell which update they're on. Put the new number in the pull request title.
- New car values come from mode scans (`leafdash-modescan-*.txt`). Decode them, wire them in, and update `DATASHEET.md`. Scan files can contain a VIN: never commit them.
- Plain-English text in the app and docs, without jargon dumps.

## Files

| File | What it does |
|---|---|
| `index.html` | Layout: header, connect bar, no-Bluetooth notice, power strip, views (Drive, Dash, Energy, Cells, Debug) and tabs. Script order matters. |
| `style.css` | All styles, including responsive phone, sideways-phone, tablet and landscape side rail. |
| `cardata.js` | `CAR_DIDS` (VCM and cluster reads), `ecuRead`, `deriveCarData`, `LIGHT_BITS`/`carLights()`, VIN, charge modes. |
| `settings.js` | `SET_DEFAULTS`, the settings sheet, `openSheet`/`confirmSheet`, `applyDevMode`, `showView`. The sheet is a short list of collapsible sections (`<details class="set-sec" data-sec=…>`, one open at a time), each with a one-line summary of how it's set (`subs()`). `openSettings('costs')` opens straight into a section. New settings go inside an existing section; keep the closed list short. `LeafDash.version` (in `metrics.js`) is shown in About: bump it with releases. |
| `app.js` | Core: the `Elm` BLE/ELM327 class, the `isReadOnly` guard, `INIT`, `ECUS`, ISO-TP `parseReply`, LBC group decoding (01/02/04/06/61), `pollLoop`, `render`, the demo generator, power strip, sniffer (needs `ATCSM1`, so not usable with the LELink²) and command box. |
| `metrics.js` | The `LeafDash` API (`registerMetric`/`registerWidget`/`registerAddon`, `on`/`emit`, `snapshot`), metric definitions, `fmtMetric`, `buildSnapshot`. |
| `didscan.js` | Mode scanner. Every test is: starting point (read twice → noise list) → one thing on → back off. `DS_GROUPS` holds each group's `start` text and tests (`on`/`off` instructions, `hold` for pedals = countdown + beeps, `flash` = three passes). Likely matches = changed on and returned off; values that fail to return in two or more tests are treated as drift. Custom tests and ticked computers are kept in `leafdash.modescan.prefs`. Results file is `leafdash-modescan-*.txt`, headed `mode scan v2`, with bit-level changes. |
| `car3d.js` | Simple drawn 3D loft car (fallback), its lights and beams. |
| `carimg.js` | the owner's model pictures: the rear view on Drive with traced lamp polygons (`REAR_LAMPS`), and the side view on the charging screen (`SIDE`). |
| `osmroad.js` | Real road shape from OpenStreetMap (Overpass): matching, smoothed path, junction side roads, T-junction turn pick, traffic lights and zebras, lane tapering, overlays. |
| `charge.js` | Charging screen: time to 80% and 100%, what's limiting the speed, pack drawing, flow line. |
| `drive.js` | The Drive screen render loop (road, warp, car, overlays), GPS, `fitScene`. |
| `dashboard.js` | Dash tab widgets and the editor. |
| `addons.js` | Home Assistant REST, MQTT (lazy `vendor/mqtt.min.js`, MIT) with HA discovery, ABRP. |
| `healthtrip.js` | Health trip recording (Debug): samples, cell snapshots, resistance regressions, report and raw CSV. The last ten reports are kept in `leafdash.healthtrips` and listed under "Past trips"; the last three raw logs are kept in IndexedDB (`leafdash` database, `healthraw` store, not in backups). A recording is saved once a minute and on `pagehide`, so closing the app mid-trip keeps it. An unseen report is offered on the next start through `alertNotice`. Demo trips are never kept. |
| `history.js` | Things remembered between drives (localStorage, never saved in demo): recent efficiency buckets → range, charge log and costs (`SET.prices`), daily battery health readings and the trend chart. |
| `backup.js` | User data safety: `navigator.storage.persist()`, backup file (all `leafdash.*` keys, add-on logins only if ticked), restore (sets `window.LD_RESTORING` so nothing saves over it, then reloads), last-backup reminder. |
| `alerts.js` | Gentle alert banner (`ALERT_RULES`), spoken updates (`say`), night dimming, speed limit nudge. `alertNotice({ text, action, dismiss })` shows one quiet blue notice in the same line when no alert is showing: use it for anything the user might have missed, instead of a pop-up that can be lost. |
| `demoroute.js` | Made-up 3.5 km map route that demo mode drives (bends, junctions, lights, dual carriageway, a roundabout and a mini-roundabout). |
| `demopanel.js` | Demo test panel: lights, gear, ECO, e-Pedal, charging type, low tyre, held sliders, map route toggle. |
| `main.js` | Start-up and URL parameters. |
| `sw.js` | Service worker. Network-first. **Bump `VERSION` on every change** (currently `leafdash-v61`). It only caches the app's own files, never requests to other services. `FILES` must list every file. |
| `manifest.webmanifest`, `icons/` | PWA manifest (orientation `any`) and icons. |
| `_config.yml` | GitHub Pages (Jekyll) settings: keeps `CLAUDE.md` and the `android/` folder off the website, which only needs the app. |
| `android/`, `.github/workflows/android.yml` | Android Auto proof of concept (Java, Car App Library 1.4.0, no Bluetooth, Demo mode only). GitHub Actions builds it; the installable file is the `leafdash-car-test` artifact. `android/README.md` has the install and test steps. The sandbox can't build it (no Google Maven, no Android SDK), so read the Actions run to see whether a change compiles. `android/test.keystore` is a throwaway, public signing key (password `android`) so builds install over each other; never use it for a Play upload. |
| `LICENSE` | GPL-3.0. |
| `README.md` | User-facing docs. |
| `DATASHEET.md` | The car and every value read from it: computer, identifier, decoding, and status (Confirmed / In use / To check / Not found). **Update it whenever a scan file is decoded or a value is confirmed in the car.** Never put a VIN or anything personal in it. |

## Car protocol notes (confirmed on the owner's car)

- **ELM setup** (`INIT`): `ATZ ATE0 ATL0 ATS0 ATH0 ATSP6 ATCAF1 ATAT2 ATSH79B ATCRA7BB ATFCSH79B ATFCSD300000 ATFCSM1`.
- **Computers** (`ECUS`):
  - lbc (battery): 79B → 7BB
  - vcm: 797 → 79A
  - meter (instrument cluster): 743 → 763
  - bcm: 745 → 765. Answered none of `0E00`–`0EFF` in the 14 Nov 2026 scan (0 values).
- **No broadcast sniffing.** The 2018+ gateway only passes request/reply traffic, so sniffing is useless. Everything is polled.
- **Multi-frame replies:** CAF on, headers off. Lines look like `0C6`, `0:…`, `1:…`, with indices wrapping 0–F. `parseReply` rejects missing or short pieces; dropped BLE pieces used to shift cell voltages. `decodeCells` needs at least 194 bytes and valid values of 2000–4400 mV, otherwise the last good set is kept.
- **Current sign:** `CURRENT_SIGN = -1`.
- **SOH:** estimated from Ah against `NEW_AH = 115.44`, which matches LeafSpy.
- **Gears** (VCM `1156`): 1 P, 2 R, 3 N, 4 D, 7 **B**. B was once wrongly labelled ECO; it's B.
- **VCM `131B` (hvacRaw):**
  - 0x01: A/C
  - 0x10: ECO
  - 0x20: rear heated screen. The car has no front heated screen; "front demist" just runs A/C and heat with recirculation.
- **VCM `1323`:** 0x20 = climate running.
- **Fast lane, every cycle:** gear `1156`, speed `121A`, motor kW `1146`.
- **Lights and pedals** (mode scans of 11 and 14 Nov 2026; full table in `DATASHEET.md`):
  - cluster `0E07` byte 0: 0x01 main beam. Byte 1: 0x10 side/tail, 0x20 + 0x40 fog (front/rear split unknown), 0x80 an indicator is lit (flashes; identical for left, right and hazards)
  - cluster `0E0F` byte 3: 0x01 dipped beam
  - VCM `1305` byte 0: 0x04 brake pedal pressed (fast lane, `brakeRaw`). VCM `1119`: brake pedal amount 0–1023
  - VCM `1132`: accelerator, 0 released, 682 on the floor (`ACCEL_FLOOR`)
  - cluster `0E2E` is **not** the accelerator (earlier guess was wrong) and is no longer read
- **Indicator display: hidden** (owner's choice, 14 Nov 2026) via `SHOW_INDICATORS = false` in `cardata.js`, because the side is unknown. What follows describes the code that runs when it's switched back on: both sides flash. The bit flashes with the lamp, so `pollLights` reads at uneven gaps, repeats a dark reading a third of a second later while flashing, and `carLights` keeps it lit for 2.4 s. It can take a few seconds to appear. Left/right was looked for twice (VCM `1100`–`13FF`, cluster `0E00`–`0EFF`, BCM `0E00`–`0EFF`) and isn't there; finding it would mean searching other ranges or computers.
- **Fog switch on this car:** front fogs first, then the rear fog is added; the rear can't be on alone. So both `0E07` fog bits set = rear fog on.
- **Power label** (`powerState` in `app.js`): drawing power isn't driving. In P it says Climate (climate running) or Parked; in gear but standing still with the motor under 0.5 kW it says Stopped; otherwise Drive or Regen; Charging while charging. The bar turns grey when power is used without driving. Energy used in P is left out of the recent-efficiency buckets, so parked heating doesn't lower the range figure; it still counts in trip energy.
- **Brake lamps on the picture:** pedal bit, or regen stronger than 8 kW.
- **Removed as unreliable:** A/C power `1151`.
- **Not found yet:** GIDs / kWh remaining.
- **Cluster values in use:** odometer `0E01`, GOM `0E24`, tyres `0E25`–`0E28`.

## Polling

`pollLoop`:
- **Fast lane, every cycle:** LBC group 01, then the fast VCM reads, then `emit('data')`.
- **Slow lane:** due items fitted into about 200 ms, grouped by computer:
  - group 04: every 5 s
  - group 02 (cells): 10 s, or 3 s on the Cells view, or 2 s during a health trip
  - group 06: 15 s
  - group 61: 30 s
  - adapter voltage (`ATRV`): 10 s
  - VIN: once
  - lights: 2 s
- `useEcu()` only switches computers when needed (`S.ecu`, `S.fc`). Anything that changes headers outside it must reset both to `null`.
- With a mock adapter at about 35 ms latency, the fast values refresh about every 0.54 s.

## Drive screen details

- **Perspective road:** camera height 3 m, with `sy = y0 + k/z` and `sx = cx + X*s*k/z`.
- **No map data:** the straight fallback road is a two-lane road, one lane each way, with the car in the left lane (the owner's choice: that's what an unknown road usually is).
- **Warp:** Auto = on when not in ECO, Always, or Off.
- **Car model:** default is the owner's rear picture (`SET.carModel = 'model'`); 'drawn' uses `car3d.js`; an uploaded photo takes priority over both.
- **Rear lamps:** traced from the owner's painted template.
  - Red swoop beside the rear window: tail, brighter for brake.
  - Lower module: orange indicator on the outside, blue reverse on the inside.
  - Purple: rear fog, bottom centre.
  - The high brake light is on the spoiler bar.
  - Mirror indicators face forward, so from behind only their glow on the road shows.
- **Headlights:** one cone from the car's full width.
  - Dipped: covers all lanes and stops at about 25–28 m.
  - Main: just as wide, reaching about 80 m.
- **Real road (OSM):**
  - Downloads within 700 m, refetching after 300 m.
  - Path resampled every 1 m and smoothed.
  - Heading eased, at most about 250°/s.
  - GPS corrections eased in; small ones ignored when slow.
  - A sideways shift slides out over about ½ s.
  - Side roads drawn about 70 m out from each junction, with gaps in the kerb line.
  - At a T-junction, the turn is picked from the heading (about 9° swing), or from an indicator once that's readable.
  - Ground polygons clipped at the near plane, so nothing pops.
  - Lane edges taper over about 20 m; the car drifts into a new lane over about 2 s.
  - Traffic lights (unlit, since the colour isn't known) and zebras with Belisha beacons, plus a "Lights · 120 yd" pill.
  - Roundabouts: `trace()` joins the ring and follows it for one lap (exits become side roads); `findRbts()` gives the island and a give-way line; mini-roundabouts are a painted disc. The exit isn't predicted: the path swaps when GPS matches the exit road.
- **UK specifics:** keep-left lane layout; `maxspeed` needs "mph", and `GB:nsl_*` / `national` are understood.
- **Charging screen:** a side view with the pack in the sill, filling from the front. The flow line runs from the nose port over the front wheel arch.

## Testing

- **Headless browser:** puppeteer-core in `/tmp/pt` with `/usr/bin/google-chrome`. Start `python3 -m http.server PORT` in the **same** Bash command, because background servers die between turns.
- **URL parameters:**
  - `?demo` (with the map route)
  - `?roadtest`
  - `?charging`
  - `?healthdemo`
  - `?view=dash|energy|cells|debug`
- A mock Bluetooth adapter (a fake `navigator.bluetooth` injected before page load, answering `21xx`/`22xxxx`) is the way to test live paths: reconnect, charge detection, history, the read-only guard.
- **Useful test scripts** written in past sessions, kept in `/tmp/pt`, which may not survive:
  - `smoke.js`: every view, mode and size; checks for errors, undefined/NaN and sideways overflow
  - `mock.js`: mock ELM adapter; measures refresh per value and checks the read-only guard
  - `tturn.js`: T-junction jump and freeze detector
  - `lz.js`: lamp close-ups
- The sandbox can't reach Overpass, Google or Maven, so test roads with `osmLoad()` fixtures or the demo route.

## User data

- Everything lives in localStorage under `leafdash.*` keys: `settings`, `trip`, `eff`, `charges`, `health`, `seen`, `modescan.found`, `modescan.prefs`, `healthtrips`. Health trip raw logs are the one exception: they're in IndexedDB and aren't backed up. A new stored key must be added to `BK_KEYS` in `backup.js`.
- Every save function must return early when `window.LD_RESTORING` is set.
- Not done, by choice: moving the logs to IndexedDB (not needed yet) and syncing between devices (would put data on a server).

## Known loose ends

- The comment at the top of `app.js` about `DRIVE`/`0x11A` broadcast decoding is out of date. Gear and ECO now come from VCM reads, and `DRIVE.decode` is unused.
- Unused leftovers flagged by lint: `PLUG_STATES`, `KM_MI`, and a few locals. Harmless.

## Decisions made

- **APK:** a bundled-files APK won't work, because Android WebView has no Web Bluetooth. A Trusted Web Activity is the route if one is wanted. Chrome's "Install app" already gives most of this.
- **Android Auto** (proof of concept in `android/`): a web app can't appear on Android Auto, so it needs a native Car App Library app registered as a navigation app, which may draw on the car's surface. A WebView rendered there with `VirtualDisplay` + `Presentation` works (shown on the Desktop Head Unit simulator). On a real car, Car App Library apps must come from a trusted source such as Google Play: Android Auto's "Unknown sources" setting doesn't apply to them, and sideloading with `adb install -i com.android.vending` doesn't stick (Android records the install as started by the shell). Don't retry free workarounds; the route is a Play internal testing track.
- `safety.js`, an old code-gated override for non-read-only commands, was removed because it conflicts with hard rule 1. Don't bring anything like it back.
