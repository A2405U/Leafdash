package com.a2405.leafdash;

import androidx.annotation.NonNull;
import androidx.car.app.AppManager;
import androidx.car.app.CarContext;
import androidx.car.app.Screen;
import androidx.car.app.model.Action;
import androidx.car.app.model.ActionStrip;
import androidx.car.app.model.CarIcon;
import androidx.car.app.model.Template;
import androidx.car.app.navigation.model.NavigationTemplate;
import androidx.core.graphics.drawable.IconCompat;
import androidx.lifecycle.DefaultLifecycleObserver;
import androidx.lifecycle.LifecycleOwner;

/**
 * The one car screen. Android Auto supplies a blank drawing area behind its own buttons;
 * SurfaceRenderer puts the Leaf Dash Drive screen on it.
 */
final class DriveScreen extends Screen implements DefaultLifecycleObserver {
    private final SurfaceRenderer renderer;

    DriveScreen(@NonNull CarContext carContext) {
        super(carContext);
        renderer = new SurfaceRenderer(carContext);
        carContext.getCarService(AppManager.class).setSurfaceCallback(renderer);
        getLifecycle().addObserver(this);
    }

    @Override
    public void onDestroy(@NonNull LifecycleOwner owner) {
        renderer.release();
    }

    @NonNull
    @Override
    public Template onGetTemplate() {
        // Android Auto insists on at least one button of its own here (it shows for a few seconds after a touch).
        // It opens the Leaf Dash ☰ menu, where Reload now lives.
        Action menu = new Action.Builder()
                .setIcon(new CarIcon.Builder(IconCompat.createWithResource(getCarContext(), R.drawable.ic_menu)).build())
                .setOnClickListener(renderer::toggleMenu)
                .build();
        NavigationTemplate.Builder t = new NavigationTemplate.Builder()
                .setActionStrip(new ActionStrip.Builder().addAction(menu).build());
        // A movable "map": with it, Android Auto passes swipes and flicks on to SurfaceRenderer (onScroll, onFling),
        // which scroll the page. Needs Car App API level 2 or later.
        if (getCarContext().getCarAppApiLevel() >= 2) {
            t.setMapActionStrip(new ActionStrip.Builder().addAction(Action.PAN).build());
            t.setPanModeListener(isInPanMode -> { });
        }
        return t.build();
    }
}
