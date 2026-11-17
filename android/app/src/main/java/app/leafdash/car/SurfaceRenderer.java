package app.leafdash.car;

import android.app.Presentation;
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
            web = WebHost.create(presentation.getContext(), "?demo", true);
            presentation.setContentView(web);
            presentation.show();
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

    /** The button on the car screen: load the page again. */
    void reload() {
        if (web != null) web.reload();
    }

    void release() {
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
