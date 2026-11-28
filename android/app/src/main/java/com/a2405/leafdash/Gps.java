package com.a2405.leafdash;

import android.annotation.SuppressLint;
import android.content.Context;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Looper;

import androidx.annotation.NonNull;

import java.util.function.Consumer;

/**
 * The phone's GPS for the page (leafnative.js replaces the page's own location with this). Unlike the WebView's,
 * it keeps going while the app is in the background, as long as KeepAliveService runs as a location service, so
 * the road keeps drawing on the phone and the car screen. One fix a second.
 */
@SuppressLint("MissingPermission")   // NativeBridge checks the location permission before start()
final class Gps implements LocationListener {
    private final LocationManager lm;
    private final Consumer<Location> out;
    private boolean on;

    Gps(Context context, Consumer<Location> out) {
        this.lm = context.getApplicationContext().getSystemService(LocationManager.class);
        this.out = out;
    }

    /** @return false if no location source is switched on */
    boolean start() {
        if (on) return true;
        String provider = lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ? LocationManager.GPS_PROVIDER
                : lm.isProviderEnabled(LocationManager.FUSED_PROVIDER) ? LocationManager.FUSED_PROVIDER
                : lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) ? LocationManager.NETWORK_PROVIDER : null;
        if (provider == null) return false;
        lm.requestLocationUpdates(provider, 1000L, 0f, this, Looper.getMainLooper());
        on = true;
        return true;
    }

    void stop() {
        if (!on) return;
        lm.removeUpdates(this);
        on = false;
    }

    @Override
    public void onLocationChanged(@NonNull Location l) { out.accept(l); }

    @Override
    public void onProviderDisabled(@NonNull String provider) { }

    @Override
    public void onProviderEnabled(@NonNull String provider) { }
}
