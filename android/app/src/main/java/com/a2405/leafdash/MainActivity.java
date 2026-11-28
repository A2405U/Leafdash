package com.a2405.leafdash;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.GeolocationPermissions;
import android.window.OnBackInvokedDispatcher;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.view.WindowInsets;
import android.webkit.WebView;
import android.widget.FrameLayout;

/**
 * The phone screen: the full Leaf Dash, packed inside the app, connected to the car through the phone's own
 * Bluetooth (NativeBridge). Location is asked for the first time the Drive screen wants it, as in Chrome.
 */
public class MainActivity extends Activity {
    private static final int REQ_LOCATION = 42, REQ_FILE = 43;

    private WebView web;
    private NativeBridge bridge;
    private GeolocationPermissions.Callback geoCallback;
    private String geoOrigin;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        bridge = new NativeBridge(this);
        web = WebHost.create(this, "", false, bridge);
        bridge.attach(web);
        // keep the page's process running at full importance when the app isn't on screen (it's reading the car)
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (!WebHost.ORIGIN.equals(origin.replaceAll("/$", ""))) { callback.invoke(origin, false, false); return; }
                if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    callback.invoke(origin, true, false);
                    return;
                }
                geoOrigin = origin; geoCallback = callback;
                requestPermissions(new String[]{ Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, REQ_LOCATION);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try { startActivityForResult(params.createIntent(), REQ_FILE); }
                catch (ActivityNotFoundException e) { fileCallback = null; return false; }
                return true;
            }
        });
        // Android 15+ draws apps under the status and navigation bars: keep the page clear of them.
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsets.CONSUMED;
        });
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        }
    }

    /** Back: step back in the page if it can, otherwise go to the home screen but keep running (and connected). */
    private void back() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        boolean granted = results.length > 0;
        for (int i = 0; i < results.length && i < permissions.length; i++)   // notifications are optional: only Bluetooth decides
            if (permissions[i].startsWith("android.permission.BLUETOOTH")) granted &= results[i] == PackageManager.PERMISSION_GRANTED;
        if (code == NativeBridge.REQ_BLUETOOTH) bridge.onPermissionResult(granted);
        else if (code == NativeBridge.REQ_GPS) {
            boolean any = false;
            for (int r : results) any |= r == PackageManager.PERMISSION_GRANTED;
            bridge.onGpsPermission(any);
        }
        else if (code == REQ_LOCATION && geoCallback != null) {
            boolean any = false;
            for (int r : results) any |= r == PackageManager.PERMISSION_GRANTED;
            geoCallback.invoke(geoOrigin, any, false);
            geoCallback = null; geoOrigin = null;
        }
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        if (code == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(code, result, data);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() { back(); }   // Android 12, before the new back handling

    @Override
    protected void onStart() {
        super.onStart();
        if (bridge != null) bridge.background(false);
    }

    @Override
    protected void onStop() {
        if (bridge != null) bridge.background(true);   // keep the page's repeating jobs going (NativeBridge)
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        bridge.close();
        web.destroy();
        super.onDestroy();
    }
}
