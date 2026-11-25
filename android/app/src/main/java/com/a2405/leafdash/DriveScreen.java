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
        // Android Auto insists on at least one button. This one reloads the picture.
        Action reload = new Action.Builder()
                .setIcon(new CarIcon.Builder(IconCompat.createWithResource(getCarContext(), R.drawable.ic_reload)).build())
                .setOnClickListener(renderer::reload)
                .build();
        return new NavigationTemplate.Builder()
                .setActionStrip(new ActionStrip.Builder().addAction(reload).build())
                .build();
    }
}
