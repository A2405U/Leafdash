package com.a2405.leafdash;

import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import org.json.JSONObject;

/**
 * The link between the two copies of Leaf Dash in this app: the phone screen (which owns the adapter connection)
 * and the car screen (Android Auto). The phone page sends the car's values, its GPS fixes and its mode
 * (carscreen.js → NativeBridge.toCar), and they're handed to the car page as window.__leafFromPhone(text).
 * Nothing goes the other way except Android Auto's own buttons and taps (SurfaceRenderer).
 */
final class CarLink {
    private static final Handler UI = new Handler(Looper.getMainLooper());
    private static volatile WebView car;
    private static volatile String phoneMode = null, zoom = "normal";   // null: the phone app isn't running

    private CarLink() {}

    static void attach(WebView web) { car = web; beat(); }

    static void detach(WebView web) { if (car == web) car = null; }

    /**
     * The phone page's mode (and road size), from carscreen.js. The car screen is told every second from here,
     * not only by the page: Android holds back a page's timers while the app is in the background, and the car
     * screen would think the phone app had gone.
     */
    static void phoneMode(String mode, String roadSize) {
        phoneMode = mode;
        if (roadSize != null && roadSize.matches("small|normal|large")) zoom = roadSize;
    }

    /** The phone app has closed: the car screen should say so. */
    static void phoneGone() { phoneMode = null; }

    private static final Runnable BEAT = new Runnable() {
        @Override public void run() {
            if (car == null) return;
            String m = phoneMode;
            if (m != null && m.matches("on|off|busy|demo")) send("{\"k\":\"hb\",\"mode\":\"" + m + "\",\"zoom\":\"" + zoom + "\"}");
            UI.postDelayed(this, 1000);
        }
    };

    private static void beat() { UI.removeCallbacks(BEAT); UI.post(BEAT); }

    /** Whether a car screen is showing, so the phone page only sends when it's worth it. */
    static boolean showing() { return car != null; }

    static void send(String json) {
        if (car == null || json == null || json.length() > 200_000) return;
        run("window.__leafFromPhone&&window.__leafFromPhone(" + JSONObject.quote(json) + ")");
    }

    /** Run JavaScript in the car page (on the main thread). */
    static void run(String js) {
        UI.post(() -> { WebView w = car; if (w != null) w.evaluateJavascript(js, null); });
    }
}
