# Leaf Dash for Android

The Leaf Dash web app packed into a real Android app. The screens are the same as the website's, and the web files are built into the app, so it starts without a network connection.

- **The phone screen** is the full Leaf Dash. It connects to the OBD adapter through the phone's own Bluetooth, because Android's WebView has no Web Bluetooth. `leafnative.js` gives the web code the browser features it expects (Bluetooth, keeping the screen on, spoken updates, sharing and saving files), using `NativeBridge.java`.
- **Read-only, twice.** The web app refuses anything that isn't read-only (`isReadOnly()` in `app.js`). `ReadOnlyGuard.java` checks every command again just before it's written to the adapter, with the same list. `tests/native.test.js` checks that the two lists match.
- **The car screen** (Android Auto) shows the Drive screen with the phone's live values (`CarLink.java`, `carscreen.js`). Android Auto's ☰ button opens the menu; taps on the screen are passed on where the car supports it.
- **Not published on the website:** `android` is excluded in `_config.yml`.

## How it's built

GitHub builds it automatically (`.github/workflows/android.yml`) whenever the Android code or the web app changes, or when you press **Run workflow** on the Actions tab. The app's version number is the web app's (`LeafDash.version` in `metrics.js`).

To get the app file: GitHub → **Actions** → the latest **Android app** run → **Artifacts** → `leafdash-android`. Unzip it to get `app-debug.apk`.

## Installing on the phone

1. Copy `app-debug.apk` to the phone and open it, or use `adb install -r app-debug.apk` from a computer. Android asks you to allow installs from that app the first time.
2. If the older **Leaf Dash Test** app is installed, you can uninstall it. The new app has a different name inside Android (`com.a2405.leafdash`), so the two don't replace each other.
3. Open **Leaf Dash** and tap **Connect adapter**. Android asks for **Nearby devices** permission (for Bluetooth), then lists the adapters it can see. Location is asked for the first time the Drive screen wants it.

**Your data doesn't move by itself.** The app keeps its settings, history and recordings separately from Chrome. To bring them over: in Chrome, Settings → Your data → **Save backup file**; then in the app, **Restore from file**.

**Google Play:** see [`PLAY.md`](PLAY.md) for the upload key, the release workflow and the Play Console steps. **When you move to the Play version,** that version is signed with a different key, so it can't install over this test build. Save a backup file first, uninstall the test build, install from Play, then restore.

## Android Auto: what you need

- A Windows, Mac or Linux computer and a USB cable to the phone.
- [Android Studio](https://developer.android.com/studio) on the computer. It's free. It's only used here for two tools it can download: `adb` and the Android Auto simulator.

## One-time set-up

**On the phone**

1. Settings → About phone → Software information → tap **Build number** seven times. This switches on Developer options.
2. Settings → Developer options → switch on **USB debugging**.
3. Open Android Auto's settings (Settings → Connected devices → Android Auto). Scroll to the bottom and tap **Version and permission info** ten times. This switches on Android Auto's developer mode.
4. Still in Android Auto's settings: three-dot menu → **Developer settings** → tick **Unknown sources**.

**On the computer**

1. Open Android Studio → More Actions → **SDK Manager** → **SDK Tools** tab.
2. Tick **Android SDK Platform-Tools** and **Android Auto Desktop Head Unit Emulator**, then Apply.
3. Note the "Android SDK Location" shown at the top of that window. The tools are in:
   - `platform-tools/` (contains `adb`)
   - `extras/google/auto/` (contains `desktop-head-unit`)

## The desktop simulator

1. On the phone, in Android Auto's settings: three-dot menu → **Start head unit server**.
2. On the computer:

```bash
adb forward tcp:5277 tcp:5277
```

3. Start the simulator from the `extras/google/auto/` folder:

```bash
./desktop-head-unit
```

(On Windows it's `desktop-head-unit.exe`.)

4. An Android Auto screen appears on the computer. Open its app launcher and choose **Leaf Dash**.

**What to look for:** the Leaf Dash Drive screen, with the road moving, on the simulated car display.

## The real car

Android Auto only shows this kind of app on a real car if it was installed from Google Play.

- **Tried on 15 November 2026 and it doesn't work:** installing from the computer labelled as a Play Store install (`adb install -i com.android.vending`). The app was listed on the car once, then disappeared on every reconnect, because Android still records that the install was started from a computer.
- **The route that should work:** a Google Play developer account, with the app uploaded to a private "internal testing" track and installed from the Play Store. Google's documentation says that track needs no review.

## If something goes wrong

This shows the app's own log messages, including the size of the car screen and any error while showing the page:

```bash
adb logcat -s LeafDash LeafDashCar AndroidRuntime chromium
```

Copy what it prints and send it over.

## The signing key

`android/test.keystore` is a throwaway test key, and its password is in the build file, so anyone can see it. It only exists so test builds install over each other. **Never use it to sign anything uploaded to Google Play**; that needs a new, private key kept in GitHub's encrypted secrets, never in this repo.
