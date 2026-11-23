# Leaf Dash

Notice: This project and part of the information about this project was created using Claude Opus 5.5 and Claude Fable 5.2 - This project is also still in beta and active development

Inspired a lot by Leafspy - leafspy.com 

Maps data from Openstreetmap - openstreetmap.org

A clean, customisable dashboard for the Nissan Leaf (built and calibrated on a 2021 ZE1 40 kWh). It runs in Chrome on Android and talks to a Bluetooth LE OBD adapter (LELink²) using Web Bluetooth. You install it from the browser, and it works offline once loaded.

## Before you use it

- **Use at your own risk.** Leaf Dash is a hobby project, provided without any warranty (see the licence).
- **It only reads from the car** (see below), but you plug the adapter in and use the app at your own risk.
- **Don't operate it while driving.** Set it up while parked, put the phone in a fixed holder where it doesn't block your view, and keep your eyes on the road. In the UK it's illegal to hold or use a phone while driving, including when stopped at lights or in traffic. Leaf Dash shows a reminder the first time it connects to the car, and locks Settings and the Debug tab while the car is moving.
- **Calibrated on one car:** a 2021 Nissan Leaf ZE1 with the 40 kWh battery, UK model. Other years, trims and the 62 kWh e+ may read some values wrongly. [`DATASHEET.md`](DATASHEET.md) says how sure each value is.
- **Not affiliated with Nissan.** Nissan and Leaf are trademarks of Nissan. LeafSpy is a separate app by its own developer.

## Read-only by design

Leaf Dash can't change anything in your car. A single gate in `app.js` (`isReadOnly()`) checks every command before it reaches the adapter, and only lets these through:

- **adapter set-up and info commands**, which only configure the LELink itself
- **`21 xx`**: read data by local identifier (battery data)
- **`22 xx xx`**: read data by identifier (gear, ECO, speed, power, counters…)

Everything else is rejected before it's sent, with no override: clearing codes, resets, writes, routines, session changes, and adapter EEPROM or baud changes. Add-ons never get access to the adapter at all.


## What leaves your phone

Everything Leaf Dash knows stays in the browser on your phone, except these, each listed with whether it's on in **Settings → Your data**:

| What | Sent to | When |
|---|---|---|
| The app itself | GitHub Pages (github.io), which sees your internet address like any website | Loading and updating the app |
| Your position, asking for the roads within 700 m | Two OpenStreetMap map servers: overpass-api.de and overpass.kumi.systems | Only with real road shape on (Settings → Drive screen). Areas you've driven are kept on the phone and not asked for again |
| The car data you chose, and location only if allowed | Your own Home Assistant or MQTT broker, or ABRP (api.iternio.com) | Only for an add-on you've turned on, after a confirmation. Never in Demo mode |
| Recordings, reports, scans, backups | Wherever you send them | Only when you tap Share or Save |

The VIN is never sent. There are no accounts, no analytics or tracking, no adverts and no crash reports. Your phone's own services are separate: Android provides the GPS position, and spoken updates use the phone's voice engine.
## Screens

| Tab | What's on it |
|---|---|
| **Drive** | Road view with your car, speed, gear, ECO and e-Pedal, a Tesla-style power bar and warp effect, and four chips you choose |
| **Dash** | Your customisable tile dashboard |
| **Energy** | Power graph, trip energy, running costs and the charge log |
| **Cells** | All 96 cell voltages, the pack temperature sensors and the battery health trend |
| **Debug** | Only shown in Developer mode (Settings): health trip recording, mode scanner, raw data |

## Demo route

Demo mode now drives a made-up map route so you can see how the Drive screen handles real roads: Elm Road (20 mph, zebra, side road) → right at the lights onto the A105 High Road (30, S-bends, crossing lights) → slip road onto the A40 dual carriageway (70) → off-slip → left at the lights onto Station Road (40, a roundabout, tight bend, zebra, mini-roundabout), then it starts again. It stops at the junction lights and slows for bends and turns. Turn it off with *Map route* in the test panel.

## Demo test panel

In Demo mode a **Test panel** button appears. Turn on *Manual control* to switch each light (side/tail, dipped, main beam, brake, indicators, hazards, reverse, rear fog), pick the gear, toggle ECO, e-Pedal and charging (3-pin, wallbox or rapid), and hold speed, power, charge and battery temperature with sliders. *Move up* docks it at the top so it doesn't hide what you're checking. It only changes the simulated data, never the car.

## Car model

The Drive and charging screens use your Leaf model pictures (`car-rear.webp`, `car-side.webp`). Brake, tail, reverse and indicator lights glow on the picture, the headlights light the road, and *Car colour* tints it. Settings → Drive screen → *Car model* switches back to the simple drawn car. An uploaded photo of your own car still takes priority.

## Charging screen (Settings → Drive screen)

When the car is charging, the Drive tab switches to a side view of the car with the battery pack visible through the body, filling from the front as it charges. Below it: charge %, power, time to 80% and to 100%, % per hour, kWh added, battery temperature, cell spread and **what's setting the speed** (charger output, wallbox or 3-pin supply, the car's on-board charger, battery temperature, or the taper above 80%). Times are estimates that allow for the slowdown near full. Turn it off with the *Charging screen* toggle. Try it with `?charging`.

## Refresh speed

Speed, gear, battery power and the brake pedal are read every cycle. On a real Bluetooth adapter that's about once a second (each request takes 70–100 ms). Slower-changing values (cells, temperatures, 12 V, odometer, dash range, tyres, counters) are spread across cycles in a short slot after the fast reads, whichever is most overdue first, so nothing gets left out. While driving, values that matter little on the move (A/C compressor, charger, plug) are read less often, which leaves room for the rest: on a typical adapter cells come round about every 15 s, temperatures every 8 s, tyres every 30 s and the odometer every minute. When parked the slot is longer.

Cell readings that arrive with a missing or cut-short Bluetooth piece are now rejected instead of being shown shifted. That was what caused the wrong-looking spread and missing cells. The last good set stays on screen until a clean one arrives.

## Drive recorder (Developer mode → Debug)

Tap **Start recording** before you set off and **Stop recording** when you park. Everything the app sees goes into one file: car values as they change, each set of cell voltages, every adapter request and reply, every GPS fix, the OpenStreetMap data downloaded for the road drawing, what the road drawing matched (road, speed limit, lanes, next junction), and the power label, lights, alerts and log. A red **REC** in the header shows it's running; tap it to jump to the Debug tab. Turn on real road shape first if you want the map data in the file.

Keep Leaf Dash on screen while recording (the screen is kept awake). It's saved every 5 s, so closing the app loses at most a few seconds. The last three recordings are kept, and **Share** packs one into a `leafdash-drive-*.jsonl.gz` file (JSON Lines, gzipped). The VIN is never recorded, but the file does contain your route, so only share it with people you trust. Recordings aren't part of a backup file.

## Drive replay (Developer mode → Debug)

Each recording has a **Replay** button, and **Replay a file…** opens a `leafdash-drive-*.jsonl.gz` from the phone's storage. The drive plays back in Demo mode: the GPS track drives the road drawing as it did in the car, using the map data saved in the recording (nothing is downloaded), and speed, power, gear, cells and lights follow the drive. A bar on the Drive screen has pause, 1×/2×/4×/8×, a slider to move through the drive, **Lose GPS 15 s** (to see what happens in a tunnel) and **Next junction** (jumps to just before the next junction, roundabout, lights or zebra). Being Demo mode, nothing is sent to add-ons or saved to the history. Tap ✕ or **Stop demo** to finish.

## Health trip recording (Developer mode → Debug)

Tick **Record my next trip**, then drive. Recording starts when you pull away and stops after 3 minutes parked in P, when you disconnect, or when you tap *Stop now* (3 hour cap). During the trip cells are read every 2 s. At the end you get a report with distance, efficiency, SoC used, SOH/Hx, an estimated pack resistance, voltage sag at peak power, cell spread at rest and under load, which cell drops lowest, battery temperature, charts, and an estimated resistance for each of the 96 cell pairs, with weak ones highlighted. **Share report** saves a standalone HTML page. **Share raw log** saves a CSV with every sample and cell snapshot. Resistance figures are estimates: a trip with a few firm accelerations gives the best numbers. Try the report with `?healthdemo`.

Reports are kept: the last ten are listed under **Past trips** in the same card, so one you missed can be reopened, and the raw log is kept for the last three. A recording is saved once a minute and again if the app is closed mid-trip. If a report appeared as you were closing the app, a quiet "report is ready" line offers it the next time you open Leaf Dash.

## Mode scanner (Developer mode → Debug)

Finds which of the car's values follow a light, pedal or button, using read-only requests.

- **Every test is the same shape:** a starting point, turn one thing on, turn it back off. Each screen says what to do and what to leave alone, and the "off" screen repeats the starting point so you know the car should be back there.
- **Starting point:** read twice, so values that change by themselves are ignored.
- **Result after each test:** the values that changed when it went on and went back when it went off, simplest first. If nothing went back, it says so and you can redo the test.
- **Held controls** (pedals) get a 3-second countdown first, and two beeps when you can let go. Flashing lights are read three times so they aren't missed.
- **Your own tests:** type a name to add one; it's kept for next time. The computers you ticked are remembered too.
- **Share results** gives a `leafdash-modescan-…txt` file with the likely matches at the top and every reading below.

## Real road shape (Settings → Drive screen)

When it's turned on, the Drive screen draws the road you're actually on: its curves, the number of lanes, a speed-limit sign and the road name. It keeps the same look as the straight road.

- **How it works:** GPS position → nearby roads from the OpenStreetMap Overpass API (fetched about every 300 m) → snapped to your road → traced about 250 m ahead.
- **Lanes:** from OSM's `lanes`, `lanes:forward` and `lanes:backward` tags, laid out for driving on the left. Your car sits next to the centre line on two-way roads, and in the left or middle lane on one-way roads. Roads with no lane count fall back to one lane each way.
- **Speed limit:** from `maxspeed`, including the UK national limits.
- **Fallback:** with no GPS or no map data, it goes back to the straight road.
- **Privacy:** your approximate location goes to the Overpass servers (you're asked first). No car data is sent.
- **Credit:** map data © OpenStreetMap contributors, shown on screen.
- **Simulated drive:** add `?roadtest` to the address to try it with a made-up road network.
- **Roundabouts:** the ring is drawn with its island and exits, a give-way line where you join, and a "Roundabout · 120 yd" note. Mini-roundabouts show as a painted disc. The map doesn't know which exit you'll take, so the whole ring is shown until you leave it.

Traffic lights and zebra crossings come from the same map download. They're drawn at the kerb (lights unlit, since the map only says where they are, not their colour; zebras with flashing Belisha beacons) with a "Lights · 120 yd" note under the speed sign.

**Cameras:** speed and red-light cameras mapped on OpenStreetMap show the same way ("Red-light camera · 150 yd"), taking priority over the lights or junction they sit at, with a small camera post drawn at the kerb. With spoken updates on, each one is announced once. They're read however they're mapped (`highway=speed_camera`, `speed_camera=traffic_signals`, `highway=red_light_camera`, `man_made=surveillance` + `surveillance=red_light`, or an enforcement relation's device). Only cameras someone has mapped will show, and the direction a camera faces isn't used yet. Turn them off under **Settings → Alerts and driving aids → Cameras**.

**Remembered map areas:** every map download is kept on the phone for 30 days (the newest 250 areas, each 100–300 kB). Driving the same roads again, like a commute, loads them from the phone instead of the map servers, so the road shape still shows when the servers are busy or there's no signal. If both servers fail, the app tries again after 10 s, then 20 s, 40 s and at most a minute. The saved areas show which roads you've driven, stay on this phone only, and aren't part of a backup; **Forget saved map areas** in Settings → Drive screen clears them.

## Alerts and driving aids (Settings → Alerts and driving aids)

- **Gentle alerts:** one quiet line under the power bar, never a pop-up. It shows for a tyre that's low or well below the others, a hot battery (45°C and up), one cell drifting from the rest at rest, or a low 12 V battery. Each has to stay true for a while first, and a dismissed alert stays away until the problem clears.
- **Speed limit nudge:** with the real road shape on, the limit sign pulses when you're more than 3 mph over.
- **Night dimming:** the whole screen darkens a few seconds after the headlights come on.
- **Spoken updates** (off by default): battery milestones on the way down (50, 30, 20, 15, 10, 5%), charging started and stopped, 80% and full, alerts, and the adapter connecting or dropping.
- **Reconnect by itself:** if the link drops, the app tries again by itself for a few minutes. When you open the app it also looks for the adapter used last time, where the browser supports remembering Bluetooth devices; otherwise tap Connect as before.

## Range, running costs and battery history

- **Range:** worked out from how the car has actually been driven over the last 25 miles or so (heater and all), not just this trip. *Range (car's guess)* is there too as a separate value.
- **Running costs (Energy tab):** set a price per kWh for a 3-pin plug, home wallbox, public charger and rapid charger in Settings → Running costs. Every charge is logged and priced by how the car was charged. Tap a charge to switch it (for example from home wallbox to public charger) or remove it. If the car charges while the app is closed, the charge is worked out the next time you connect, from how much fuller the battery is, and the car's own rapid-charge counter says whether it was a rapid. AC charges include about 10% for losses.
- **Battery health over time (Cells tab):** one reading a day (health, capacity, cell spread at rest) shown as a trend, with an Export button for a CSV file.

All of this is stored only in this browser. Demo mode shows a made-up history and saves nothing.

## Your data (Settings → Your data)

Settings, prices, the dashboard layout, the charge log and the battery history live only in this browser on this device. They survive app updates, but not clearing the browser's site data or changing phone.

- **Save backup file** puts everything in one file in your Downloads. Keep it somewhere safe, such as Google Drive. Add-on logins are left out unless you tick the box.
- **Restore from file** replaces what's on the device with the file's contents, on this phone or another one.
- Settings shows when you last backed up, and nudges you after a month.
- The app also asks the browser not to clear its data when the phone runs short of space.

## Roadside scenery (Settings → Drive screen)

Trees, hedges, houses, lamp posts and fences beside the road, in the same outline look as the road, with green only for leaves and hedges. It's drawn by the app, so nothing extra is downloaded. With real road shape on, the mix follows the road: houses and lamp posts on 30 mph streets, hedgerows and trees on country roads, tall lamp posts on dual carriageways. Junctions, roundabouts, lights and zebras are kept clear, and the same stretch of road always looks the same. Turn it off under **Scenery**.

## Lights on the Drive screen

The car on the Drive screen mirrors your real lights: dipped and main beam on the road ahead, tail lights, brake lights (with the high-level one), reverse lights and flashing indicators.

- **Dipped and main beam, side and tail lights, rear fog** come from the instrument cluster.
- **Brake lights** follow the brake pedal, and also glow under strong regen, as the real ones do.
- **Reverse** comes from the gear.
- **Indicators** aren't shown. The car only reports that an indicator is lit, not which side, so they're hidden until the side can be read.

## Customising

- **Dashboard:** tap **Dash → Edit**, then:
  - **+ Add tile** to add something
  - **×** to remove a tile
  - drag the **⠿** handle to move a tile
- **Advanced layout:** in **Settings → Dashboard → Advanced**, a resize corner appears on each tile in edit mode.
- **Drive screen:** **Settings → Drive screen** sets the bottom four chips, car colour or your own photo, the warp effect, units, and the battery size used for range.

## Add-ons (Settings → Add-ons)

All add-ons are off by default. Turning one on shows exactly what will be sent and where, and needs you to tick **I understand**. They only run while connected to the real car, never in Demo mode. Credentials are stored only in your browser.

| Add-on | What it does | You need |
|---|---|---|
| **Home Assistant** | Creates `sensor.leaf_*` entities through HA's REST API | an https URL to HA, a long-lived token, and your app's address under `http: cors_allowed_origins:` in `configuration.yaml` |
| **MQTT** | Publishes `leafdash/state` as JSON, plus optional HA auto-discovery as a "Nissan Leaf" device | a broker with a **wss://** WebSocket listener and a valid certificate |
| **A Better Route Planner** | Live charge, power and location for route planning | your ABRP user token (ABRP → car settings → Live data → Generic) |

Example Home Assistant config:

```yaml
http:
  cors_allowed_origins:
    - https://YOUR-USERNAME.github.io
```

## Extending Leaf Dash

The app is built around a small API (`metrics.js`), so new things plug in without touching the core.

```js
// A metric: shows up as a dashboard tile and a Drive chip automatically
LeafDash.registerMetric({
  id: 'kwhLeft', label: 'Energy left', short: 'kWh left', group: 'Battery',
  get: d => d.soc == null ? null : SET.usableKwh * d.soc / 100,
  unit: () => 'kWh', dp: 1,
});

// A custom tile (w/h in grid units; phones have 2 columns, tablets 4)
LeafDash.registerWidget({
  id: 'myTile', name: 'My tile', group: 'Widgets', w: 2, h: 1,
  render(el, data) { el.innerHTML = `<div class="label">Hello</div><div class="w-val">${data.soc ?? '--'}</div>`; },
});

// An add-on: receives a read-only snapshot (fixed units: km, km/h, °C, kW)
LeafDash.registerAddon({
  id: 'mywebhook', name: 'My webhook', description: 'POSTs data to my server.',
  fields: [{ key: 'url', label: 'URL' }, { key: 'interval', label: 'Every (s)', type: 'number', default: 30 }],
  validate: c => c.url ? null : 'Enter a URL',
  destination: c => c.url, sends: () => ['Battery and driving data'],
  async send(snapshot, cfg, api) { await fetch(cfg.url, { method: 'POST', body: JSON.stringify(snapshot) }); api.status('Sent', 'ok'); },
});
```

To add your own, put the code in a new file, for example `addons/mything.js`. Then add `<script src="addons/mything.js"></script>` to `index.html` just before `main.js`, and add the file to `FILES` in `sw.js`.

Events you can listen for:

- `LeafDash.on('data', …)`: after each live update
- `LeafDash.on('mode', …)`: connection state changes
- `LeafDash.on('ready', …)`: the app has started

## Deploying (GitHub Pages)

1. Upload every file, keeping the `icons/` and `vendor/` folders.
2. Bump `VERSION` in `sw.js` whenever you change something.
3. Phones pick up the update the next time they open the app online.

## Car datasheet

[`DATASHEET.md`](DATASHEET.md) lists the car (2021 Leaf ZE1 Acenta, 40 kWh, UK) and every value the app reads: which computer, which identifier, how it's decoded, and whether it's been confirmed on the car.

## Security

Found a way past the read-only guard, or data going somewhere it shouldn't? Please report it privately, not as a public issue. [`SECURITY.md`](SECURITY.md) says how.

## Licence

Copyright (C) 2026 A2405U and contributors.

Leaf Dash is free software under the **GNU General Public License v3.0** ([`LICENSE`](LICENSE)). You can use, study, change and share it, and any changed version you share must stay under the same licence with its source code available. That includes the car pictures (`car-rear.webp`, `car-side.webp`).

The bundled MQTT library (`vendor/mqtt.min.js`) keeps its own MIT licence ([`vendor/mqtt-LICENSE.md`](vendor/mqtt-LICENSE.md)).

## Files

| File | Job |
|---|---|
| `app.js` | Bluetooth, read-only gate, battery decoding, polling |
| `cardata.js` | Gear, ECO, speed, power, counters and other read-only car values |
| `metrics.js` | The LeafDash API, the metric catalogue, and the snapshot for add-ons |
| `settings.js` | The Settings sheet and stored preferences |
| `dashboard.js` | Customisable tiles |
| `drive.js`, `car3d.js` | Drive screen and the 3D car |
| `carimg.js`, `car-rear.webp`, `car-side.webp` | Your Leaf model pictures and their lights |
| `demopanel.js` | Demo test panel |
| `osmroad.js` | Real road shape from OpenStreetMap |
| `charge.js` | Charging screen |
| `healthtrip.js` | Health trip recording and report |
| `scenery.js` | Roadside scenery on the Drive screen |
| `tests/` | Automated checks for contributors (not part of the app): see `tests/README.md` |
| `replay.js` | Drive replay: plays a recording back in Demo mode |
| `driverec.js` | Drive recorder: everything on a drive, into one file |
| `history.js` | Recent efficiency and range, charge log and costs, battery health trend |
| `alerts.js` | Gentle alerts, spoken updates, night dimming, speed limit nudge |
| `backup.js` | Backup file, restore, and asking the browser to keep the data |
| `addons.js` | Add-on framework, Home Assistant, MQTT and ABRP |
| `didscan.js` | Mode scanner (Developer mode, read-only) |
| `vendor/mqtt.min.js` | MQTT.js (MIT licence), loaded only when the MQTT add-on is on |
| `SECURITY.md` | How to report a security problem privately |
