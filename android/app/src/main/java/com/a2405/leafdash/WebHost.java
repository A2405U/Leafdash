package com.a2405.leafdash;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

/**
 * Makes a web view that shows the Leaf Dash web app packed inside this app.
 *
 * The files are served from inside the package under a fixed https address, so the page behaves as it does on
 * the website (same security rules, same saved settings between runs) and needs no network to start.
 * The page can't navigate anywhere else: other links open in the phone's browser, so the bridge to the phone's
 * Bluetooth is only ever offered to the app's own files.
 */
final class WebHost {
    static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String BASE = ORIGIN + "/assets/www/index.html";
    private static final String TAG = "LeafDash";

    private WebHost() {}

    /**
     * @param query  what to put after the page address, for example "?demo"
     * @param bridge the phone features (Bluetooth, speech, files), or null for a screen that only shows Demo
     */
    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    static WebView create(@NonNull Context context, @NonNull String query, boolean carScreen, @Nullable Object bridge) {
        WebViewAssetLoader.Builder loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(context));
        if (bridge != null) {      // downloaded offline map packs (MapDownloads), for offmap.js to read
            java.io.File maps = MapDownloads.dir(context);
            //noinspection ResultOfMethodCallIgnored
            maps.mkdirs();
            loader.addPathHandler("/" + MapDownloads.DIR + "/", new WebViewAssetLoader.InternalStoragePathHandler(context, maps));
        }
        final WebViewAssetLoader assets = loader.build();

        WebView web = new WebView(context);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);          // the web app is all JavaScript
        s.setDomStorageEnabled(true);          // where the web app keeps its settings
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(!carScreen);

        if (bridge != null) {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                web.addJavascriptInterface(bridge, "LeafNative");
                WebViewCompat.addDocumentStartJavaScript(web, readAsset(context, "leafnative.js"), Collections.singleton(ORIGIN));
            } else {
                Log.w(TAG, "This WebView is too old for the Bluetooth bridge: update Android System WebView");
            }
        }

        web.setWebViewClient(new WebViewClient() {
            @Nullable
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (ORIGIN.equals(u.getScheme() + "://" + u.getHost())) return false;
                if (!carScreen && ("https".equals(u.getScheme()) || "http".equals(u.getScheme()))) {
                    try { context.startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
                    catch (ActivityNotFoundException ignored) { }
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // On the car screen, hide the "no Bluetooth" notice and the demo test-panel button.
                if (!carScreen) return;
                view.evaluateJavascript(
                        "(function(){var s=document.createElement('style');s.textContent='#noBt,#demoFab,#demoPanel{display:none!important}';"
                                + "document.head.appendChild(s);"
                                + "if(typeof fitScene==='function')setTimeout(fitScene,50);})();", null);
            }
        });
        web.loadUrl(BASE + query);
        return web;
    }

    private static String readAsset(Context context, String name) {
        try (InputStream in = context.getAssets().open(name); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            throw new IllegalStateException("missing " + name, e);
        }
    }
}
