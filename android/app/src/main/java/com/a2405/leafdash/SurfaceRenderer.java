package com.a2405.leafdash;

import android.app.Presentation;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.util.Log;
import android.view.Surface;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.car.app.CarContext;
import androidx.car.app.SurfaceCallback;
import androidx.car.app.SurfaceContainer;

/**
 * Shows the Leaf Dash web page on the car's drawing area.
 *
 * Android Auto hands over a drawing surface. An ordinary web view can't draw on that
 * directly, so the surface is wrapped as an extra (virtual) display and the web view
 * is shown on that display. This is the method Google's car documentation describes
 * for showing ordinary views on the car screen.
 */
final class SurfaceRenderer implements SurfaceCallback {
    private static final String TAG = "LeafDashCar";

    private final CarContext carContext;
    private VirtualDisplay display;
    private Presentation presentation;
    private WebView web;
    private float density = 1f;
    private int width, height;
    private Rect visible;
    private final Handler ui = new Handler(Looper.getMainLooper());

    SurfaceRenderer(@NonNull CarContext carContext) {
        this.carContext = carContext;
    }

    @Override
    public void onSurfaceAvailable(@NonNull SurfaceContainer container) {
        release();
        Surface surface = container.getSurface();
        if (surface == null) return;
        Log.i(TAG, "car surface " + container.getWidth() + "x" + container.getHeight() + " @" + container.getDpi() + "dpi");
        try {
            display = carContext.getSystemService(DisplayManager.class).createVirtualDisplay(
                    "LeafDashCar", container.getWidth(), container.getHeight(), container.getDpi(),
                    surface, DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY);
            presentation = new Presentation(carContext, display.getDisplay());
            width = container.getWidth(); height = container.getHeight();
            density = container.getDpi() / 160f;
            web = WebHost.create(presentation.getContext(), "?car", true, null);
            presentation.setContentView(web);
            presentation.show();
            CarLink.attach(web);
            // tell the page which part Android Auto leaves free, once it has loaded (and whenever it changes)
            for (int ms : new int[]{ 800, 2000, 5000 }) ui.postDelayed(this::sendArea, ms);
        } catch (RuntimeException e) {
            // Logged so the reason can be read back with "adb logcat -s LeafDashCar"
            Log.e(TAG, "could not show the page on the car surface", e);
            release();
        }
    }

    @Override
    public void onSurfaceDestroyed(@NonNull SurfaceContainer container) {
        release();
    }

    @Override
    public void onVisibleAreaChanged(@NonNull Rect area) {
        visible = new Rect(area);
        sendArea();
    }

    /** The part of the surface not covered by Android Auto's own bars, as insets in the page's pixels. */
    private void sendArea() {
        if (web == null || visible == null || visible.isEmpty()) return;
        int l = Math.round(visible.left / density), t = Math.round(visible.top / density);
        int r = Math.round((width - visible.right) / density), b = Math.round((height - visible.bottom) / density);
        CarLink.run("window.__leafCarArea&&window.__leafCarArea(" + l + "," + t + "," + r + "," + b + ")");
    }

    /** A tap on the car screen (where the car and Android Auto pass taps on): tap the page there. */
    @Override
    public void onClick(float x, float y) {
        if (web == null) return;
        long now = SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x, y, 0);
        MotionEvent up = MotionEvent.obtain(now, now + 60, MotionEvent.ACTION_UP, x, y, 0);
        web.dispatchTouchEvent(down);
        web.dispatchTouchEvent(up);
        down.recycle(); up.recycle();
    }

    /** Android Auto's ☰ button: open or close the Leaf Dash menu. */
    void toggleMenu() {
        CarLink.run("window.__leafCarMenu&&window.__leafCarMenu()");
    }

    /** The button on the car screen: load the page again. */
    void reload() {
        if (web != null) web.reload();
    }

    void release() {
        ui.removeCallbacksAndMessages(null);
        CarLink.detach(web);
        if (presentation != null) {
            try { presentation.dismiss(); } catch (RuntimeException ignored) { }
            presentation = null;
        }
        if (web != null) {
            web.destroy();
            web = null;
        }
        if (display != null) {
            display.release();
            display = null;
        }
    }
}
