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

    private CarLink() {}

    static void attach(WebView web) { car = web; }

    static void detach(WebView web) { if (car == web) car = null; }

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
