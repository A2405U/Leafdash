# Leaf Dash Test: Android Auto proof of concept

A bare Android app that answers one question: **can the Leaf Dash Drive screen be shown on an Android Auto display?** Answer, 15 November 2026: yes, it runs smoothly on the desktop simulator.

- It shows Leaf Dash in **Demo mode only**. It has no Bluetooth and never talks to the car.
- On the phone it shows the whole app. On the car screen it shows the same page on the drawing area Android Auto gives navigation apps.
- It is a private test build. It is not published on the Leaf Dash website (`android` is excluded in `_config.yml`).

## The signing key

`android/test.keystore` is a throwaway test key, and its password is in the build file, so anyone can see it. It only exists so test builds install over each other. **Never use it to sign anything uploaded to Google Play**; that needs a new, private key.

## How it's built

GitHub builds it automatically (`.github/workflows/android.yml`) whenever a file in `android/` changes, or when you press **Run workflow** on the Actions tab. The web app files from the repo root are copied into the package, so it shows exactly what the website shows.

To get the app file: GitHub → **Actions** → the latest **Android test app** run → **Artifacts** → `leafdash-car-test`. Unzip it to get `app-debug.apk`.

## What you need

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

## Test 1: the phone

Plug the phone in, allow USB debugging when it asks, then in a terminal in the folder with the app file:

```bash
adb install -r app-debug.apk
```

Open **Leaf Dash Test** on the phone. It should show Leaf Dash running in Demo mode. This proves the packed web app works.

## Test 2: the desktop simulator

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

4. An Android Auto screen appears on the computer. Open its app launcher and choose **Leaf Dash Test**.

**What to look for:** the Leaf Dash Drive screen, with the road moving, on the simulated car display.

## The real car

Android Auto only shows this kind of app on a real car if it was installed from Google Play.

- **Tried on 15 November 2026 and it doesn't work:** installing from the computer labelled as a Play Store install (`adb install -i com.android.vending`). The app was listed on the car once, then disappeared on every reconnect, because Android still records that the install was started from a computer.
- **The route that should work:** a Google Play developer account, with the app uploaded to a private "internal testing" track and installed from the Play Store. Google's documentation says that track needs no review.

## If something goes wrong

This shows the app's own log messages, including the size of the car screen and any error while showing the page:

```bash
adb logcat -s LeafDashCar AndroidRuntime
```

Copy what it prints and send it over.
