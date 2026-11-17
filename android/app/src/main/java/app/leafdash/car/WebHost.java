package app.leafdash.car;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Color;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.WebViewAssetLoader;

/**
 * Makes a web view that shows the Leaf Dash web app packed inside this app.
 *
 * The files are served from inside the package under a fixed https address, so the
 * page behaves as it does on the website (same security rules, same saved settings
 * between runs) and needs no network.
 *
 * This test build has no connection to the car at all: it only ever runs Demo mode.
 */
final class WebHost {
    private static final String BASE = "https://appassets.androidplatform.net/assets/www/index.html";

    private WebHost() {}

    /** @param query what to put after the page address, for example "?demo" */
    @SuppressLint("SetJavaScriptEnabled")
    static WebView create(@NonNull Context context, @NonNull String query, boolean carScreen) {
        final WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(context))
                .build();

        WebView web = new WebView(context);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);          // the web app is all JavaScript
        s.setDomStorageEnabled(true);          // where the web app keeps its settings
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        web.setWebViewClient(new WebViewClient() {
            @Nullable
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // Tidy the page for this test: hide the "no Bluetooth" notice (this build never
                // connects to the car) and, on the car screen, the demo test-panel button.
                String hide = carScreen ? "#noBt,#demoFab,#demoPanel{display:none!important}" : "#noBt{display:none!important}";
                view.evaluateJavascript(
                        "(function(){var s=document.createElement('style');s.textContent='" + hide + "';"
                                + "document.head.appendChild(s);"
                                + "if(typeof fitScene==='function')setTimeout(fitScene,50);})();", null);
            }
        });
        web.loadUrl(BASE + query);
        return web;
    }
}
