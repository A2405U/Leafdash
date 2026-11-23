# Leaf Dash checks

Automated checks that run the app in a headless Chromium browser. They're for contributors only: the website and the
app don't use this folder (it's excluded in `_config.yml`).

```bash
node tests/run.js            # all of them, about 4 minutes
node tests/run.js smoke      # just one, or several names
```

They need [Playwright](https://playwright.dev) with Chromium: `npm install playwright` then `npx playwright install chromium`
(in a Claude Code cloud session both are already there). The runner serves the app itself, so no other web server is needed.

| Check | What it proves |
|---|---|
| `smoke` | Every view and mode at phone, sideways-phone and tablet sizes: no page errors, no "undefined"/"NaN" on screen, no sideways scrolling. An older phone's database upgrades without losing data. |
| `readonly` | **Hard rule 1.** Connected to a fake adapter, every command sent is an adapter AT command, a `21xx` or a `22xxxx` read. Write and control services are refused before reaching the adapter, from code and from the command box. |
| `polling` | On a realistic link (70 ms a reply) while moving, every slow value gets read: cells, temperatures, 12 V, dash range, tyres, odometer. |
| `safety` | The "Before you drive" note, and the lock on Settings and Debug while the car is moving. |
| `recorder` | The drive recorder keeps every kind of line, never the VIN, and survives the app closing. |
| `mapcache` | Remembered map areas and retries, with fake map servers that are busy, then back. |
| `replay` | Records the demo route, then replays it: no map downloads, 8×, losing GPS, seeking, next junction, stopping. |
| `cameras` | Every common camera tagging is recognised; each demo-route camera shows ahead (over its lights); the switch hides them. |

`mock-adapter.js` is a fake LELink² that answers like the car and records every command. Set `window.__lat` (ms per reply)
and `window.__spd` (speed in tenths of km/h) to try other conditions. No test ever reaches a real service.
