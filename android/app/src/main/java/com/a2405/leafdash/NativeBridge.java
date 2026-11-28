package com.a2405.leafdash;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.speech.tts.TextToSpeech;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.ArrayAdapter;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * What the web app gets from the phone, as window.LeafNative (used by leafnative.js, which turns it into the
 * browser features the web code already uses: navigator.bluetooth, the screen wake lock, speech and sharing).
 *
 * Calls come in on a background thread; answers go back to the page with window.__leafNativeCb(id, ok, data).
 * Only read-only commands ever reach the adapter (BleLink + ReadOnlyGuard).
 */
@SuppressLint("MissingPermission")   // every Bluetooth call is behind withPermissions()
final class NativeBridge implements BleLink.Listener {
    private static final String PREFS = "leafdash", KEY_ADDR = "adapter_address", KEY_NAME = "adapter_name";
    static final int REQ_BLUETOOTH = 41;

    private final MainActivity activity;
    private WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final BleLink link;
    private TextToSpeech tts;
    private Runnable afterPermission, permissionRefused;

    private final MapDownloads maps;

    NativeBridge(MainActivity activity) {
        this.activity = activity;
        this.link = new BleLink(activity, this);
        this.maps = new MapDownloads(activity, this::run);
    }

    /** The page this bridge answers (set once the web view exists). */
    void attach(WebView web) { this.web = web; }

    private void run(String js) {
        ui.post(() -> { if (web != null) web.evaluateJavascript(js, null); });
    }

    /* ---------------- answering the page ---------------- */
    private void answer(String id, boolean ok, String data) {
        String js = "window.__leafNativeCb&&window.__leafNativeCb(" + JSONObject.quote(id) + "," + ok + "," + JSONObject.quote(data == null ? "" : data) + ")";
        run(js);
    }

    @Override
    public void onNotify(String service, String characteristic, byte[] value) {
        String js = "window.__leafNativeNotify&&window.__leafNativeNotify(" + JSONObject.quote(service) + "," + JSONObject.quote(characteristic)
                + "," + JSONObject.quote(Base64.encodeToString(value, Base64.NO_WRAP)) + ")";
        run(js);
    }

    @Override
    public void onDisconnected() {
        run("window.__leafNativeDisconnected&&window.__leafNativeDisconnected()");
    }

    /* ---------------- Bluetooth permissions ---------------- */
    private void withPermissions(Runnable then, String id) {
        String[] need = android.os.Build.VERSION.SDK_INT >= 33
                ? new String[]{ Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.POST_NOTIFICATIONS }
                : new String[]{ Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT };
        boolean ok = true;
        for (String p : need) if (!p.equals(Manifest.permission.POST_NOTIFICATIONS)) ok &= activity.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED;
        if (ok) { then.run(); return; }
        afterPermission = then;
        permissionRefused = () -> answer(id, false, "Bluetooth permission was not given");
        ui.post(() -> activity.requestPermissions(need, REQ_BLUETOOTH));
    }

    /** Called by MainActivity with the answer to the Bluetooth permission request. */
    void onPermissionResult(boolean granted) {
        Runnable r = granted ? afterPermission : permissionRefused;
        afterPermission = null; permissionRefused = null;
        if (r != null) r.run();
    }

    private BluetoothAdapter adapter() {
        BluetoothManager m = activity.getSystemService(BluetoothManager.class);
        return m == null ? null : m.getAdapter();
    }

    /* ---------------- Bluetooth: choose, connect, notify, write ---------------- */
    /** Like Chrome's device picker: scan for about 6 s, list what was found by name, and let the user pick. */
    @JavascriptInterface
    public void bleScan(String id) {
        withPermissions(() -> {
            BluetoothAdapter a = adapter();
            if (a == null || !a.isEnabled()) { answer(id, false, "Bluetooth is off. Turn it on and try again."); return; }
            BluetoothLeScanner scanner = a.getBluetoothLeScanner();
            if (scanner == null) { answer(id, false, "Bluetooth scanning isn't available"); return; }
            Map<String, BluetoothDevice> found = new LinkedHashMap<>();
            List<String> labels = new ArrayList<>();
            ArrayAdapter<String> list = new ArrayAdapter<>(activity, android.R.layout.simple_list_item_1, labels);
            ScanCallback cb = new ScanCallback() {
                @Override
                public void onScanResult(int type, ScanResult r) {
                    BluetoothDevice d = r.getDevice();
                    String name = d.getName();
                    if (name == null || name.isEmpty() || found.containsKey(d.getAddress())) return;
                    found.put(d.getAddress(), d);
                    ui.post(() -> { labels.add(name); list.notifyDataSetChanged(); });
                }
            };
            final boolean[] picked = { false };
            ui.post(() -> {
                AlertDialog dialog = new AlertDialog.Builder(activity)
                        .setTitle("Choose your OBD adapter")
                        .setAdapter(list, (dlg, which) -> {
                            picked[0] = true;
                            try { scanner.stopScan(cb); } catch (RuntimeException ignored) { }
                            BluetoothDevice d = new ArrayList<>(found.values()).get(which);
                            remember(d);
                            try { answer(id, true, new JSONObject().put("id", d.getAddress()).put("name", d.getName()).toString()); }
                            catch (JSONException e) { answer(id, false, "Could not choose that adapter"); }
                        })
                        .setNegativeButton("Cancel", (dlg, w) -> dlg.cancel())
                        .setOnCancelListener(dlg -> { try { scanner.stopScan(cb); } catch (RuntimeException ignored) { } })
                        .setOnDismissListener(dlg -> { if (!picked[0]) answer(id, false, "User cancelled the requestDevice() chooser."); })
                        .create();
                dialog.show();
                scanner.startScan(null, new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), cb);
                ui.postDelayed(() -> { try { scanner.stopScan(cb); } catch (RuntimeException ignored) { } }, 15000);
            });
        }, id);
    }

    /** The adapter used last time, so the app can reconnect by itself when it opens. */
    @JavascriptInterface
    public void bleRemembered(String id) {
        SharedPreferences p = activity.getSharedPreferences(PREFS, 0);
        String addr = p.getString(KEY_ADDR, null);
        JSONArray out = new JSONArray();
        try { if (addr != null) out.put(new JSONObject().put("id", addr).put("name", p.getString(KEY_NAME, "adapter"))); } catch (JSONException ignored) { }
        answer(id, true, out.toString());
    }

    private void remember(BluetoothDevice d) {
        activity.getSharedPreferences(PREFS, 0).edit().putString(KEY_ADDR, d.getAddress()).putString(KEY_NAME, d.getName()).apply();
    }

    @JavascriptInterface
    public void bleConnect(String id, String address) {
        withPermissions(() -> {
            BluetoothAdapter a = adapter();
            if (a == null || !a.isEnabled()) { answer(id, false, "Bluetooth is off"); return; }
            BluetoothDevice d;
            try { d = a.getRemoteDevice(address); } catch (IllegalArgumentException e) { answer(id, false, "Unknown adapter"); return; }
            link.connect(d, (ok, data) -> answer(id, ok, data));
        }, id);
    }

    @JavascriptInterface
    public void bleNotify(String id, String service, String characteristic) {
        link.startNotifications(service, characteristic, (ok, data) -> answer(id, ok, data));
    }

    /** Bytes from the web app's writeValue: checked by ReadOnlyGuard inside BleLink before anything is sent. */
    @JavascriptInterface
    public void bleWrite(String id, String service, String characteristic, String base64, boolean withoutResponse) {
        byte[] data;
        try { data = Base64.decode(base64, Base64.DEFAULT); } catch (IllegalArgumentException e) { answer(id, false, "Bad data"); return; }
        link.write(service, characteristic, data, withoutResponse, (ok, msg) -> answer(id, ok, msg));
    }

    @JavascriptInterface
    public void bleDisconnect() { link.disconnect(); }

    /* ---------------- the car screen (carscreen.js, CarLink) ---------------- */
    @JavascriptInterface
    public boolean carOn() { return CarLink.showing(); }

    @JavascriptInterface
    public void toCar(String json) { CarLink.send(json); }

    /** The page's connection state: tells the car screen, and keeps the app running while connected. */
    @JavascriptInterface
    public void carMode(String mode, String roadSize) {
        CarLink.phoneMode(mode, roadSize);
        boolean connected = "on".equals(mode) || "busy".equals(mode);
        ui.post(() -> KeepAliveService.set(activity, connected));
    }

    /* ---------------- offline maps (offmap.js) ---------------- */
    @JavascriptInterface
    public void mapIndex(String id) { maps.index(id); }

    @JavascriptInterface
    public void mapDownload(String id, String name) { maps.download(id, name); }

    @JavascriptInterface
    public void mapDelete(String name) { maps.delete(name); }

    /** Ask again for the fast link (the web app does this if it measures the link slowing down mid-drive). */
    @JavascriptInterface
    public boolean bleFastLink() { return link.fastLink(); }

    void close() {
        CarLink.phoneGone();
        KeepAliveService.stopNow(activity);
        link.close();
        if (tts != null) { tts.shutdown(); tts = null; }
    }

    /* ---------------- screen, speech, files ---------------- */
    @JavascriptInterface
    public void keepAwake(boolean on) {
        ui.post(() -> {
            if (on) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    @JavascriptInterface
    public void speak(String text, String lang, float rate) {
        ui.post(() -> {
            if (tts == null) {
                tts = new TextToSpeech(activity, status -> { if (status == TextToSpeech.SUCCESS) speakNow(text, lang, rate); });
            } else speakNow(text, lang, rate);
        });
    }

    private void speakNow(String text, String lang, float rate) {
        if (tts == null) return;
        tts.setLanguage(lang == null || lang.isEmpty() ? Locale.UK : Locale.forLanguageTag(lang));
        tts.setSpeechRate(rate > 0 ? rate : 1f);
        tts.speak(text, TextToSpeech.QUEUE_ADD, null, "leafdash" + System.nanoTime());
    }

    @JavascriptInterface
    public void stopSpeaking() { ui.post(() -> { if (tts != null) tts.stop(); }); }

    /** The share sheet, for a file the web app made (recording, report, scan, backup). */
    @JavascriptInterface
    public void share(String id, String name, String mime, String base64) {
        try {
            File dir = new File(activity.getCacheDir(), "shared");
            if (!dir.exists() && !dir.mkdirs()) throw new IOException("no folder");
            // The name comes from the page: keep it a plain file name inside the share folder, nothing else.
            Path base = dir.toPath().toAbsolutePath().normalize();
            Path target = base.resolve(safeName(name)).normalize();
            if (!target.startsWith(base) || target.equals(base)) throw new IOException("bad name");
            File f = target.toFile();
            try (FileOutputStream out = new FileOutputStream(f)) { out.write(Base64.decode(base64, Base64.DEFAULT)); }
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".files", f);
            Intent send = new Intent(Intent.ACTION_SEND).setType(safeMime(mime)).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            ui.post(() -> activity.startActivity(Intent.createChooser(send, name)));
            answer(id, true, "");
        } catch (IOException | IllegalArgumentException e) {
            answer(id, false, "Could not share the file");
        }
    }

    /** Save a file the web app made into Downloads (for "Save backup file" and the like). */
    @JavascriptInterface
    public void save(String id, String name, String mime, String base64) {
        try {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.DISPLAY_NAME, safeName(name));
            v.put(MediaStore.Downloads.MIME_TYPE, safeMime(mime));
            Uri uri = activity.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new IOException("no file");
            try (OutputStream out = activity.getContentResolver().openOutputStream(uri)) {
                if (out == null) throw new IOException("no stream");
                out.write(Base64.decode(base64, Base64.DEFAULT));
            }
            ui.post(() -> Toast.makeText(activity, "Saved to Downloads: " + name, Toast.LENGTH_LONG).show());
            answer(id, true, "");
        } catch (IOException | IllegalArgumentException e) {
            answer(id, false, "Could not save the file");
        }
    }

    /** A plain file name: letters, digits, dot, dash and underscore only, never starting with a dot. */
    private static String safeName(String name) {
        String n = name == null ? "" : name.replaceAll("[^A-Za-z0-9._-]", "_").replaceAll("^\\.+", "");
        if (n.length() > 120) n = n.substring(n.length() - 120);
        return n.isEmpty() ? "leafdash" : n;
    }

    /** Only the kinds of file Leaf Dash makes. */
    private static String safeMime(String mime) {
        switch (mime == null ? "" : mime) {
            case "application/json": case "application/gzip": case "application/x-ndjson":
            case "text/plain": case "text/csv": case "text/html": return mime;
            default: return "application/octet-stream";
        }
    }
}
