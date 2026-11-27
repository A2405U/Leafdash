# Putting Leaf Dash on Google Play (internal testing)

Leaf Dash goes on Play's **internal testing** track only: up to 100 testers you invite by email, no public listing, and no wait for review. That's enough for the phone app, and it's the only way Android Auto will show the car screen on a real car (it only accepts car apps installed from a trusted store).

## 1. Make the upload key (once, on your computer)

Google Play signs the app people install with its own key (**Play App Signing**, the default). You sign each upload with your own private **upload key**, which proves the upload came from you. If the upload key is ever lost or leaked, Google can reset it, so it's not the end of the world, but keep it private and backed up.

`keytool` comes with Java. Android Studio has its own copy in its `jbr/bin` folder.

```bash
keytool -genkeypair -v -keystore leafdash-upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000
```

- It asks for a password (twice), then for a name, organisation and so on. These go into the key's certificate. **You don't have to give your real name:** "Leaf Dash" for the name and "GB" for the country is enough.
- Keep `leafdash-upload.jks` and its password somewhere safe, for example a password manager. **Never put it in the repo.**

## 2. Give the key to GitHub (encrypted secrets)

GitHub → the repo → **Settings → Environments → New environment** → name it `play`:
- **Deployment branches and tags:** "Selected branches and tags" → add `main`. Only the main branch can then use the key.

Then, in the `play` environment, **Add environment secret** four times:

| Name | Value |
|---|---|
| `UPLOAD_KEYSTORE_B64` | the key file as text: run `base64 -w0 leafdash-upload.jks` and paste the output |
| `UPLOAD_STORE_PASSWORD` | the password you chose |
| `UPLOAD_KEY_ALIAS` | `upload` |
| `UPLOAD_KEY_PASSWORD` | the same password (keytool uses one password for both unless you chose two) |

Or with the GitHub CLI, from the folder with the key (it asks for each value, so nothing ends up in your shell history):

```bash
base64 -w0 leafdash-upload.jks | gh secret set UPLOAD_KEYSTORE_B64 --env play --repo A2405U/Leafdash
```

```bash
gh secret set UPLOAD_STORE_PASSWORD --env play --repo A2405U/Leafdash
```

```bash
gh secret set UPLOAD_KEY_ALIAS --env play --repo A2405U/Leafdash
```

```bash
gh secret set UPLOAD_KEY_PASSWORD --env play --repo A2405U/Leafdash
```

## 3. Build the bundle

GitHub → **Actions** → **Google Play release** → **Run workflow** (branch `main`). When it finishes, download the `leafdash-play-bundle` artifact and unzip it: `app-release.aab` is the file Play wants. Each run gets a higher build number automatically.

## 4. In the Play Console

1. **Create app:** name *Leaf Dash*, default language English (United Kingdom), App, Free. Tick the declarations.
2. **Test and release → Testing → Internal testing:**
   - **Testers:** create an email list with your own Google account (the one signed in on your phone).
   - **Create new release:** accept **Play App Signing**, upload `app-release.aab`, release name `1.0`, notes "First test build", then **Save → Review release → Start rollout**.
   - Copy the **opt-in link** from the Testers tab, open it on the phone, accept, then install from Play.
3. **Advanced settings → Form factors → Add form factor → Android Auto.** Needed before Android Auto shows the car screen.

Before the first rollout the console asks you to fill in **App content** (Policy → App content). Draft answers are below. Check each against what the form actually asks; the forms change.

## 5. App content: draft answers

**Privacy policy:** `https://a2405u.github.io/Leafdash/privacy.html`

**Ads:** No, the app doesn't contain ads.

**App access:** All functionality is available without special access. Note for reviewers: *"Needs a Bluetooth OBD-II adapter in a Nissan Leaf. Without one, use Demo (the button on the first screen) to see every screen."*

**Target audience:** 18 and over (it's for drivers). Not designed for children.

**Content rating questionnaire:** category *All other app types* (or *Utility*). No violence, sexual content, bad language, drugs, gambling or user-generated content; it doesn't share the user's location with other users; no purchases. Expect *Everyone* / *PEGI 3*.

**Data safety** (what leaves the phone; see the privacy policy):
- Does the app collect or share any required user data types? **Yes:** location, for map data.
- Is all data encrypted in transit? **Yes** (https only).
- Can users ask for their data to be deleted? There are no accounts, and nothing is kept by the developer. Pick the option that says the app doesn't create accounts or store data on a server, if the form offers it.
- **Location → Precise location.** Google counts anything finer than about 3 km² as precise, and the grid square sent is about 220 × 140 m.
  - Collected: **yes**. Shared: the cautious answer is **yes**, because it goes to third-party map servers.
  - Processed ephemerally: **yes** (the developer never receives or stores it).
  - Required or optional: **optional** (only with real road shape switched on).
  - Purpose: **App functionality**.
- **Car data sent by the add-ons** (Home Assistant, MQTT, ABRP) goes only where the user chooses, after switching it on. Google's guidance counts data the user deliberately sends to a destination they chose as not "shared", so these don't need their own entries beyond location.
- No personal info, financial info, health, messages, photos, contacts, calendar, files or app activity is collected. (The car photo you can upload stays on the phone.)

**Government app / financial features / health:** No.

## 6. Store listing (needed even for internal testing)

**Short description (80 characters at most):**
> A clean, read-only dashboard for the Nissan Leaf, through a Bluetooth OBD adapter.

**Full description:**
> Leaf Dash shows what your Nissan Leaf is doing, clearly: battery charge and health, power, range, all 96 cell voltages, temperatures, tyres, charging speed and running costs. A Drive screen draws the road ahead from OpenStreetMap with speed limits, junctions, traffic lights and cameras.
>
> It only ever reads from the car. Every command is checked against a read-only list twice, in the web code and in the app, before it reaches the adapter, and anything that could change the car is blocked.
>
> No accounts, no adverts, no analytics. Your data stays on your phone unless you switch on an add-on (Home Assistant, MQTT or A Better Route Planner).
>
> Needs a Bluetooth LE OBD-II adapter (built and tested with a LELink² on a 2021 Leaf, 40 kWh). Demo mode shows every screen without a car.
>
> Not affiliated with Nissan. Nissan and Leaf are trademarks of Nissan. Free software under the GNU GPL v3.0.

**Graphics:** app icon 512 × 512 (`icons/icon-512.png`), a feature graphic 1024 × 500, and at least two phone screenshots.

**Category:** Auto & Vehicles. **Contact email:** required. Note that it's shown on the Play listing. While the app is internal-only, only your testers can see the listing.

## 7. After switching to the Play version

The Play version is signed with Google's key and the test builds with the public test key, so they can't install over each other. Once: **save a backup** in the test build (Settings → Your data), **uninstall** it, install from Play, then **restore**. After that, updates come through Play.

Each update: merge the pull request → run **Google Play release** → upload the new `.aab` as a new internal testing release.
