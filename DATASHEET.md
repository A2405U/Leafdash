# Leaf Dash car datasheet

What Leaf Dash reads from the car, where each value lives, and how sure we are of it.
Update this file whenever a mode scan turns up something new.

Last updated: 14 November 2026 (Lights and Brake and accelerator mode scan).

## The car

| | |
|---|---|
| Make and model | Nissan Leaf (second generation, ZE1) |
| Year | 2021 |
| Trim | Acenta |
| Body | 5-door hatchback |
| Battery | 40 kWh (96 cell pairs) |
| Market | UK, right-hand drive |
| Front heated windscreen | Not fitted. "Front demist" runs the A/C and heater with recirculation |

Other trims, years and the 62 kWh e+ may differ. Treat everything here as true for this car only.

## How the app talks to the car

| | |
|---|---|
| Adapter | LELink² Bluetooth LE OBD-II (shows as "OBDBLE", ELM327 v1.5) |
| Bluetooth service | FFE0, characteristic FFE1 |
| CAN bus | 500 kbit/s, 11-bit identifiers (`ATSP6`) |
| Adapter set-up | `ATZ ATE0 ATL0 ATS0 ATH0 ATSP6 ATCAF1 ATAT2 ATSH79B ATCRA7BB ATFCSH79B ATFCSD300000 ATFCSM1` |
| Requests used | `21 xx` (read a group) and `22 xx xx` (read one identifier). Both only read |
| Listening to traffic | Not possible. The car's gateway only passes replies to requests, and the adapter has no silent mode (`ATCSM1`) |

**Read-only.** Leaf Dash never sends anything that can change the car. Nothing in this file is a write command.

### Computers

| Name in the app | What it is | Request ID | Reply ID | Notes |
|---|---|---|---|---|
| `lbc` | Battery controller | 79B | 7BB | Answers `21 xx` groups |
| `vcm` | Main vehicle computer | 797 | 79A | Answers `22 xx xx` |
| `meter` | Instrument cluster | 743 | 763 | Answers `22 xx xx` |
| `bcm` | Body computer | 745 | 765 | Answered none of `0E00`–`0EFF` (mode scan, 14 Nov 2026) |

### Reply format

Long replies arrive in pieces: a 3-digit length line (for example `0C6`), then lines `0:…`, `1:…`, and so on, with the number wrapping from F back to 0. The app rejects a reply with a missing or short piece.

## How sure we are

| Mark | Meaning |
|---|---|
| **Confirmed** | Checked on this car: against LeafSpy, the dash, the cell voltages, or a step-by-step mode scan |
| **In use** | Taken from open-source Leaf projects and community notes. It reads sensibly on this car but hasn't been checked value by value |
| **To check** | In use, but the scaling or meaning is in doubt |
| **Not found** | Looked for, or still to look for |

## Battery controller (`lbc`, request 79B)

Byte positions count from the start of the reply, where byte 0 is `61` and byte 1 is the group number.

### Group 01: main battery data (`21 01`, 53 bytes on this car)

| Value | Bytes | How to read it | Unit | Status |
|---|---|---|---|---|
| Pack current | 2–5 | signed, ÷ 1024, then sign flipped so driving is positive | A | Confirmed (sign) |
| Pack voltage | 20–21 | ÷ 100 | V | Confirmed against cell voltages |
| Hx | 30–31 | ÷ 102.4 | % | To check against LeafSpy (reads 105.4–105.6% on a real drive, so the scaling is probably wrong) |
| State of charge | 33–35 | ÷ 10000 | % | Confirmed |
| Capacity | 37–39 | ÷ 10000 | Ah | Confirmed. One byte later than on 2011–17 cars |

Power is worked out as current × voltage ÷ 1000 (kW).

### Group 02: cell voltages (`21 02`)

| Value | Bytes | How to read it | Unit | Status |
|---|---|---|---|---|
| 96 cell pairs | 2–193, two bytes each | high byte × 256 + low byte | mV | In use (in-car check against LeafSpy still open) |

A reading is only accepted with at least 194 bytes and values between 2000 and 4400 mV.

### Group 04: pack temperatures (`21 04`)

| Value | Bytes | How to read it | Unit | Status |
|---|---|---|---|---|
| Sensors 1–4 | 3 bytes each from byte 2: two raw bytes, then the temperature | third byte, signed | °C | In use |

A sensor whose raw bytes are `FF FF` or `00 00` is treated as not fitted.

### Other groups

| Group | What | Status |
|---|---|---|
| `21 06` | Balancing shunts. Read and shown raw only | Not decoded |
| `21 61` | Battery health on 2018+ cars. Read and shown raw only | Not found: the health value's position is unknown |

### Battery health (SOH)

Because group 61 isn't decoded, health is estimated as capacity ÷ 115.44 Ah. That figure is the capacity of a new 40 kWh pack, and the result matches LeafSpy on this car (105.89 Ah → 91.73%). **Confirmed.**

## Main computer (`vcm`, request 797)

Each is read with `22` followed by the identifier. Bytes count from the first data byte, after the `62 xx xx` at the start of the reply.

| Value | Identifier | How to read it | Unit | Status |
|---|---|---|---|---|
| Gear | `1156` | byte 0: 1 = P, 2 = R, 3 = N, 4 = D, 7 = B | | Confirmed, including B |
| Road speed | `121A` | bytes 0–1 signed ÷ 10 | km/h | In use |
| Motor power | `1146` | bytes 0–1 signed × 40 ÷ 1000 | kW | In use, scaling to check: on a real drive it never went above exactly 80.0 kW while the battery gave 130 kW |
| Motor speed | `1255` | bytes 0–1 signed | rpm | To check |
| e-Pedal | `131A` | byte 0 equal to `04` means on | | In use |
| Brake pedal pressed | `1305` | byte 0, bit `04` | | Confirmed by mode scan, 14 Nov 2026 |
| Brake pedal amount | `1119` | bytes 0–1: 0 released, 31 light press, 1022 firm press | raw, 0–1023 | Confirmed by mode scan. Full scale taken as 1023 |
| Accelerator pedal | `1132` | bytes 0–1: 0 released, 314 about halfway, 682 on the floor | raw | Confirmed by mode scan. The app shows it as a percentage of 682 |
| 12 V and systems power | `1152` | byte 0 × 100 ÷ 1000 | kW | In use |
| Climate running | `1323` | byte 0, bit `20` | | Confirmed by mode scan |
| A/C on | `131B` | byte 0, bit `01` | | Confirmed by mode scan |
| ECO mode | `131B` | byte 0, bit `10` | | Confirmed by mode scan (in-car check that the badge follows the button still open) |
| Rear window heater | `131B` | byte 0, bit `20` | | Confirmed by mode scan |
| A/C compressor speed | `1178` | bytes 0–1 | rpm | In use |
| A/C coil temperature | `1263` | byte 0 ÷ 2 − 40 | °C | In use |
| Heater power | `1262` | byte 0 × 250 ÷ 1000 | kW | In use |
| 12 V battery current | `1183` | bytes 0–1 signed ÷ 256 | A | In use |
| 12 V battery voltage | `1103` | byte 0 × 0.08 | V | In use |
| Car is in READY | `1304` | byte 0, bit `80` | | In use |
| Outside temperature | `115D` | byte 0 ÷ 2 − 40 | °C | In use (in-car check open) |
| Charging type | `114E` | byte 0: 0 = not charging, 1 = 3-pin, 2 = wallbox, 3 = rapid | | In use (in-car check open) |
| Plug | `1234` | byte 0: 0 = unplugged, 1 = partly, 2 = plugged in | | In use |
| On-board charger power | `1236` | bytes 0–1 signed × 100 ÷ 1000 | kW | In use |
| Rapid charge count | `1203` | bytes 0–1 | count | In use (in-car check open) |
| Slow charge count | `1205` | bytes 0–1 | count | In use (in-car check open) |
| VIN | `21 81` (a group read, not `22`) | text | | In use. Never stored in this file |

Removed: A/C power `1151` gave unreliable values and is no longer read.

Seen in the 14 Nov 2026 scan but not used by the app:

| Identifier | What was seen | Likely meaning |
|---|---|---|
| `120D`, `120E` | 148 released, about 465 halfway, 792 and 798 on the floor | The two accelerator pedal sensors |
| `117D` | 0 released, 3954 halfway, 8516 on the floor | Follows the accelerator; meaning not known |
| `132A` | byte 0: `40` with dipped beam, `60` with main beam, `00` with side lights only | Headlight request: bit `40` dipped, bit `20` main |
| `1318` | byte 0, bit `08` set normally, clear while the brake is pressed | Not known |
| `130D` | byte 0: `10` normally, `20` while the brake is pressed | Not known |

The rear window heater bit (`131B`, bit `20`) was seen dropping by itself when the heater timed out during the scan, which agrees with the earlier finding.

## Instrument cluster (`meter`, request 743)

| Value | Identifier | How to read it | Unit | Status |
|---|---|---|---|---|
| Dipped headlights | `0E0F` | byte 3, bit `01` | | Confirmed by two Lights scans (11 and 14 Nov 2026). Also set with main beam |
| Main beam | `0E07` | byte 0, bit `01` | | Confirmed by two Lights scans |
| Side and tail lights | `0E07` | byte 1, bit `10` | | Confirmed by mode scan, 14 Nov 2026. Also set with dipped and main beam |
| Fog lights | `0E07` | byte 1, bits `20` and `40` | | Confirmed as the two fog lights. On this car the front fogs come on first and the rear fog can only be added to them, so both bits set means the rear fog is on. Which bit is front and which is rear is still to check |
| An indicator is lit | `0E07` | byte 1, bit `80`. Flashes on and off with the lamp | | Confirmed by mode scan. The same bit for the left indicator, the right indicator and the hazards |
| Odometer | `0E01` | bytes 0–2 | **miles** on the UK car (`ODO_MILES` in `cardata.js`; stored in km) | Confirmed on a real drive: it went up 20 while GPS measured 32.0 km |
| Range shown on the dash | `0E24` | bytes 0–1 signed (a 13-byte reply in two pieces: needs flow control) | km | To check against the dash: read 168 at 74% charge (104 mi). Was ÷ 10 and never read in full before 5.5b |
| Tyre pressure, front right | `0E25` | byte 0 × 1.7236894 (0 = sensor not awake yet, shown as unknown) | kPa | In use |
| Tyre pressure, front left | `0E26` | byte 0 × 1.7236894 (0 = sensor not awake yet, shown as unknown) | kPa | In use |
| Tyre pressure, rear right | `0E27` | byte 0 × 1.7236894 (0 = sensor not awake yet, shown as unknown) | kPa | In use |
| Tyre pressure, rear left | `0E28` | byte 0 × 1.7236894 (0 = sensor not awake yet, shown as unknown) | kPa | In use |

`0E07` and `0E0F` give long replies (19 and 7 bytes of data), so they are read with flow control. The headlights were first found with the automatic lights on at night.

`0E2E` byte 1 was once thought to be the accelerator. It isn't: it stayed at 0 with the pedal on the floor and showed stray values with both feet off. It is no longer read.

## Not found yet

| What | Where it's been looked for | Stand-in the app uses until then |
|---|---|---|
| Which side is indicating (left, right or hazards) | Two scans (14 Nov 2026) of the main computer `1100`–`13FF` and the cluster `0E00`–`0EFF`: only the shared "an indicator is lit" bit. The body computer answered nothing in `0E00`–`0EFF` | Indicators are not shown on the car picture |
| Which fog bit is front and which is rear | Cluster: the two bits came on together | Rear fog is shown only when both bits are set, which is right either way |
| Reverse light | Not needed | Follows the gear (R) |
| Energy remaining (GIDs or kWh) | Not yet | Range is worked out from charge level and recent efficiency |
| Battery health from group 61 | Raw reply shown in Debug | Estimated from capacity |
| Doors, boot, charge flap | Not yet | Not used |

For the fog lights, the mode scanner's **Front fog lights** test (front fogs only) will show which bit is which. For the indicator side there is no known next step: it would mean searching other identifier ranges or computers.

## Where this lives in the code

| What | File |
|---|---|
| Battery group positions (`G1`), gears, computers, adapter set-up | `app.js` |
| Main computer and cluster identifiers (`CAR_DIDS`), light bits (`LIGHT_BITS`) | `cardata.js` |
| Mode scanner tests | `didscan.js` |

## Sources

The battery group layout and most main-computer identifiers started from open-source Leaf projects (the Home Assistant Leaf OBD integration and community notes), then were checked or corrected on this car where marked Confirmed.
