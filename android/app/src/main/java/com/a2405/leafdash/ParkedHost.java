package com.a2405.leafdash;

import android.app.Presentation;
import android.content.Context;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.WebView;

/**
 * Keeps the phone page running while the app is in the background.
 *
 * Android's WebView slows a hidden page's timers and, after a few minutes, stops it altogether, which froze
 * reading the car (and so the car screen) with Waze in front or the phone locked. While the app is connected and
 * not on screen, the page is moved onto a private, invisible display inside the app (the same way the car screen
 * is shown on Android Auto's display), where it counts as on screen and nothing is held back. Its pictures are
 * thrown away unseen. When the app comes back on screen, the page moves back.
 */
final class ParkedHost {
    private static final String TAG = "LeafDash";
    private final Context context;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private ImageReader reader;
    private VirtualDisplay display;
    private Presentation presentation;

    ParkedHost(Context context) { this.context = context; }

    boolean parked() { return presentation != null; }

    /** Move the page onto the invisible display, keeping its size. */
    void park(WebView web, int width, int height, int dpi) {
        if (parked() || width <= 0 || height <= 0) return;
        try {
            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
            reader.setOnImageAvailableListener(r -> { Image i = r.acquireLatestImage(); if (i != null) i.close(); }, ui);
            display = context.getSystemService(DisplayManager.class).createVirtualDisplay("LeafDashParked", width, height, dpi,
                    reader.getSurface(), DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY);
            ((ViewGroup) web.getParent()).removeView(web);
            presentation = new Presentation(context, display.getDisplay());
            presentation.setContentView(web);
            presentation.show();
            web.evaluateJavascript("window.__leafParked&&window.__leafParked(true)", null);
            Log.i(TAG, "page parked on the invisible display " + width + "x" + height);
        } catch (RuntimeException e) {
            Log.e(TAG, "could not park the page", e);
            release();
        }
    }

    /** Put the page back in the app's own window. */
    void unpark(WebView web, ViewGroup home) {
        if (presentation != null) {
            try { ((ViewGroup) web.getParent()).removeView(web); } catch (RuntimeException ignored) { }
        }
        release();
        if (web.getParent() == null) {
            home.addView(web, 0, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            web.evaluateJavascript("window.__leafParked&&window.__leafParked(false)", null);
            Log.i(TAG, "page back on screen");
        }
    }

    private void release() {
        if (presentation != null) { try { presentation.dismiss(); } catch (RuntimeException ignored) { } presentation = null; }
        if (display != null) { display.release(); display = null; }
        if (reader != null) { reader.close(); reader = null; }
    }
}
