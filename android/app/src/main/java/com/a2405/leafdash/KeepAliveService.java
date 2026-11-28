package com.a2405.leafdash;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

/**
 * Keeps Leaf Dash running while it's connected to the car, with the screen off or another app in front (Android
 * stops or freezes apps in the background otherwise). Shows the usual "running" notification; tapping it opens
 * the app. It only runs while connected: NativeBridge starts and stops it as the page's connection changes.
 */
public final class KeepAliveService extends Service {
    private static final String CHANNEL = "connected";
    private static final int ID = 7;
    private static boolean running;
    private static final Handler UI = new Handler(Looper.getMainLooper());
    private static Runnable pendingStop;

    /**
     * Start or stop, as the connection to the adapter comes and goes. Stopping waits a minute: a dropped link goes
     * to "off" for a moment before reconnecting, and Android doesn't allow starting the service again from the
     * background.
     */
    static void set(Context context, boolean on) {
        Context app = context.getApplicationContext();
        if (on) {
            if (pendingStop != null) { UI.removeCallbacks(pendingStop); pendingStop = null; }
            if (running) return;
            try { app.startForegroundService(new Intent(app, KeepAliveService.class)); running = true; }
            catch (RuntimeException e) { running = false; }    // not allowed right now (e.g. started from the background)
        } else if (running && pendingStop == null) {
            pendingStop = () -> { pendingStop = null; app.stopService(new Intent(app, KeepAliveService.class)); running = false; };
            UI.postDelayed(pendingStop, 60_000);
        }
    }

    /** Location was just allowed: start again, so the service can also keep GPS going in the background. */
    static void refresh(Context context) {
        if (!running) return;
        Context app = context.getApplicationContext();
        try { app.startForegroundService(new Intent(app, KeepAliveService.class)); } catch (RuntimeException ignored) { }
    }

    /** The app is closing: stop now. */
    static void stopNow(Context context) {
        if (pendingStop != null) { UI.removeCallbacks(pendingStop); pendingStop = null; }
        Context app = context.getApplicationContext();
        app.stopService(new Intent(app, KeepAliveService.class));
        running = false;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Connected to the car", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while Leaf Dash is reading the car, so it keeps going in the background");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_launcher_mono)
                .setContentTitle("Leaf Dash is reading the car")
                .setContentText("Read-only. Tap to open.")
                .setContentIntent(open)
                .setOngoing(true)
                .build();
        // a location service too when location is allowed, so GPS keeps going with the app in the background
        int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
        if (checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED)
            type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
        try {
            startForeground(ID, n, type);
        } catch (RuntimeException e) {
            // location not allowed for a service right now (e.g. started from the background): Bluetooth only
            try { startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE); }
            catch (RuntimeException e2) { running = false; stopSelf(); }
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
