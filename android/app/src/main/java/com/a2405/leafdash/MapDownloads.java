package com.a2405.leafdash;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * Offline maps: downloads the list of county map packs, and a pack, from this project's "maps" release on GitHub
 * (built every week by .github/workflows/maps.yml). The page can't fetch those itself: GitHub doesn't let other
 * sites read release files. A pack is saved in the app's own files (maps/), where WebHost serves it to the page at
 * /maps/<id>.ldmap for offmap.js to unpack; the page then asks for the file to be deleted.
 *
 * Only that one release can be reached, and only names made of a–z, 0–9 and dashes, so the page can't use this to
 * download anything else or write anywhere else. Downloads run on their own thread, so the Bluetooth link keeps
 * working meanwhile.
 */
final class MapDownloads {
    static final String DIR = "maps";
    private static final String RELEASE = "https://github.com/A2405U/Leafdash/releases/download/maps/";
    private static final Pattern NAME = Pattern.compile("[a-z0-9-]{1,60}");
    private static final long MAX_PACK = 400L * 1024 * 1024, MAX_INDEX = 1024 * 1024;

    private final Context context;
    private final Consumer<String> js;       // runs JavaScript in the page
    private volatile boolean busy;

    MapDownloads(Context context, Consumer<String> js) {
        this.context = context.getApplicationContext();
        this.js = js;
    }

    static File dir(Context c) { return new File(c.getFilesDir(), DIR); }

    private void answer(String id, boolean ok, String data) {
        js.accept("window.__leafMapCb&&window.__leafMapCb(" + JSONObject.quote(id) + "," + ok + "," + JSONObject.quote(data == null ? "" : data) + ")");
    }

    /** The list of packs (index.json), as text. */
    void index(String id) {
        new Thread(() -> {
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                fetch(RELEASE + "index.json", out, MAX_INDEX, null);
                answer(id, true, out.toString(StandardCharsets.UTF_8.name()));
            } catch (IOException e) {
                answer(id, false, e.getMessage());
            }
        }, "leafdash-map-index").start();
    }

    /** Download one pack; answers with the address the page can read it from. */
    void download(String id, String name) {
        if (name == null || !NAME.matcher(name).matches()) { answer(id, false, "Unknown map"); return; }
        if (busy) { answer(id, false, "Another map is still downloading"); return; }
        busy = true;
        new Thread(() -> {
            File d = dir(context), part = new File(d, name + ".part"), done = new File(d, name + ".ldmap");
            try {
                if (!d.exists() && !d.mkdirs()) throw new IOException("Couldn't make the maps folder");
                try (OutputStream out = new FileOutputStream(part)) {
                    fetch(RELEASE + name + ".ldmap", out, MAX_PACK, (got, total) ->
                            js.accept("window.__leafMapProgress&&window.__leafMapProgress(" + JSONObject.quote(name) + "," + got + "," + total + ")"));
                }
                if (done.exists() && !done.delete()) throw new IOException("Couldn't replace the old file");
                if (!part.renameTo(done)) throw new IOException("Couldn't save the map");
                answer(id, true, "/" + DIR + "/" + name + ".ldmap");
            } catch (IOException e) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                answer(id, false, e.getMessage());
            } finally {
                busy = false;
            }
        }, "leafdash-map-download").start();
    }

    /** Delete a downloaded pack file once the page has unpacked it. */
    void delete(String name) {
        if (name == null || !NAME.matcher(name).matches()) return;
        //noinspection ResultOfMethodCallIgnored
        new File(dir(context), name + ".ldmap").delete();
    }

    interface Progress { void at(long got, long total); }

    private static void fetch(String address, OutputStream out, long max, Progress progress) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(address).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true);                 // GitHub sends release files from another https address
        c.setRequestProperty("User-Agent", "LeafDash-Android");
        try {
            int code = c.getResponseCode();
            if (code == 404) throw new IOException("Not available yet (the maps haven't been published)");
            if (code != 200) throw new IOException("Download failed (HTTP " + code + ")");
            if (!c.getURL().getProtocol().equals("https")) throw new IOException("Insecure download refused");
            long total = c.getContentLengthLong(), got = 0, lastShown = 0;
            if (total > max) throw new IOException("The file is too big");
            try (InputStream in = c.getInputStream()) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    got += n;
                    if (got > max) throw new IOException("The file is too big");
                    out.write(buf, 0, n);
                    if (progress != null && got - lastShown > 256 * 1024) { lastShown = got; progress.at(got, total); }
                }
            }
            if (progress != null) progress.at(got, total);
        } finally {
            c.disconnect();
        }
    }
}
