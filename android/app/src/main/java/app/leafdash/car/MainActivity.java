package app.leafdash.car;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;

/** The phone screen of the test app: Leaf Dash in Demo mode, to show the packed web app runs. */
public final class MainActivity extends Activity {
    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = WebHost.create(this, "?demo", false);
        setContentView(web);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
}
