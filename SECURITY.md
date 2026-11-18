# Security

Leaf Dash talks to a real car, so safety problems matter more than most bugs. Thank you for taking the time to report one.

## Reporting a problem

**Please don't open a public issue for a security problem.** Report it privately instead:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Say what you found, how to make it happen, and which app version you're on (Settings → About).

You'll get a reply as soon as possible. This is a hobby project run by one person, so please allow a little time. Once it's fixed, you're welcome to be credited in the pull request, or to stay anonymous.

## What counts

Most important first:

- **Anything that gets a command past the read-only guard** (`isReadOnly()` in `app.js`), or any way to make Leaf Dash write to, reset or change the car. The app must only ever read.
- **Data leaving the phone when it shouldn't.** For example: an add-on sending without being turned on, sending in Demo mode, sending location when its location setting is off, or logins ending up in a backup file when that box wasn't ticked.
- **Running code that isn't the app's own**, for example through a backup file, map data, a mode-scan file or an add-on reply.
- **Anything that exposes personal details** such as a VIN, location history or add-on logins.

## Not in scope

- The Android Auto test app in `android/`. It's a demo-only proof of concept, signed with a public throwaway key, and isn't meant for real use.
- Problems with the OBD adapter, the car itself, or the services the add-ons connect to (Home Assistant, MQTT brokers, A Better Route Planner).
- Someone with your unlocked phone being able to see your data. Everything is stored in your browser on that phone.

## Supported versions

Only the latest version, the one published on GitHub Pages from `main`, gets fixes.
