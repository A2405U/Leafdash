package com.a2405.leafdash;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothProfile;
import android.content.Context;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Locale;
import java.util.UUID;

/**
 * One Bluetooth LE connection to the OBD adapter (an ELM327 over a BLE serial service, like the LELink²).
 *
 * The web app talks to it through NativeBridge exactly as it would through Chrome's Web Bluetooth. Every command
 * is held back until it's complete (it ends with a carriage return), checked by ReadOnlyGuard, and only then
 * written to the adapter, in pieces of at most 20 bytes, one at a time.
 */
@SuppressLint("MissingPermission")   // NativeBridge checks the Bluetooth permissions before using this
final class BleLink {
    interface Listener {
        void onNotify(String service, String characteristic, byte[] value);
        void onDisconnected();
    }
    interface Result { void done(boolean ok, String data); }

    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final int CHUNK = 20;

    private final Context context;
    private final Listener listener;
    private BluetoothGatt gatt;
    private Result pendingConnect, pendingNotify;
    private final ArrayDeque<byte[]> writes = new ArrayDeque<>();
    private BluetoothGattCharacteristic writeChar;
    private int writeType;
    private boolean writing;
    private Result writesDone;
    private final StringBuilder held = new StringBuilder();   // a command still being assembled

    BleLink(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    synchronized void connect(BluetoothDevice device, Result result) {
        close();
        pendingConnect = result;
        gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE);
        if (gatt == null) { pendingConnect = null; result.done(false, "Could not start the Bluetooth connection"); }
    }

    synchronized void disconnect() {
        if (gatt != null) gatt.disconnect();
    }

    synchronized void close() {
        if (gatt != null) { try { gatt.close(); } catch (RuntimeException ignored) { } gatt = null; }
        writes.clear(); writing = false; held.setLength(0); writesDone = null;
    }

    synchronized void startNotifications(String service, String characteristic, Result result) {
        BluetoothGattCharacteristic c = find(service, characteristic);
        if (c == null) { result.done(false, "No such characteristic"); return; }
        gatt.setCharacteristicNotification(c, true);
        BluetoothGattDescriptor d = c.getDescriptor(CCCD);
        if (d == null) { result.done(true, ""); return; }
        byte[] on = (c.getProperties() & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0
                ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE : BluetoothGattDescriptor.ENABLE_INDICATION_VALUE;
        pendingNotify = result;
        boolean started;
        if (Build.VERSION.SDK_INT >= 33) started = gatt.writeDescriptor(d, on) == BluetoothGatt.GATT_SUCCESS;
        else { d.setValue(on); started = gatt.writeDescriptor(d); }
        if (!started) { pendingNotify = null; result.done(false, "Could not turn on notifications"); }
    }

    /**
     * Bytes from the web app. Complete commands are checked and queued; a refused one is dropped and reported.
     * Nothing reaches the adapter until it has passed ReadOnlyGuard.
     */
    synchronized void write(String service, String characteristic, byte[] data, boolean withoutResponse, Result result) {
        BluetoothGattCharacteristic c = find(service, characteristic);
        if (c == null) { result.done(false, "No such characteristic"); return; }
        held.append(new String(data, StandardCharsets.US_ASCII));
        int cr;
        boolean queued = false;
        while ((cr = held.indexOf("\r")) >= 0) {
            String cmd = held.substring(0, cr);
            held.delete(0, cr + 1);
            if (!ReadOnlyGuard.allowed(cmd)) {
                held.setLength(0);
                result.done(false, "Blocked (not read-only): " + cmd.trim());
                return;
            }
            byte[] bytes = (cmd + "\r").getBytes(StandardCharsets.US_ASCII);
            for (int i = 0; i < bytes.length; i += CHUNK) writes.add(Arrays.copyOfRange(bytes, i, Math.min(bytes.length, i + CHUNK)));
            queued = true;
        }
        if (held.length() > 64) { held.setLength(0); result.done(false, "Command too long"); return; }
        if (!queued) { result.done(true, ""); return; }   // part of a command: held until the rest arrives
        writeChar = c;
        writeType = withoutResponse && (c.getProperties() & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0
                ? BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE : BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT;
        writesDone = result;
        if (!writing) nextWrite();
    }

    private synchronized void nextWrite() {
        byte[] piece = writes.poll();
        if (piece == null || gatt == null) {
            writing = false;
            Result r = writesDone; writesDone = null;
            if (r != null) r.done(piece == null, piece == null ? "" : "Not connected");
            return;
        }
        writing = true;
        boolean started;
        if (Build.VERSION.SDK_INT >= 33) started = gatt.writeCharacteristic(writeChar, piece, writeType) == BluetoothGatt.GATT_SUCCESS;
        else { writeChar.setWriteType(writeType); writeChar.setValue(piece); started = gatt.writeCharacteristic(writeChar); }
        if (!started) {
            writes.clear(); writing = false;
            Result r = writesDone; writesDone = null;
            if (r != null) r.done(false, "Write failed");
        }
    }

    private BluetoothGattCharacteristic find(String service, String characteristic) {
        if (gatt == null) return null;
        BluetoothGattService s = gatt.getService(UUID.fromString(service));
        return s == null ? null : s.getCharacteristic(UUID.fromString(characteristic));
    }

    /** The services and characteristics, for the web app's getPrimaryService / getCharacteristics. */
    private static String describe(BluetoothGatt g) throws JSONException {
        JSONArray out = new JSONArray();
        for (BluetoothGattService s : g.getServices()) {
            JSONArray chars = new JSONArray();
            for (BluetoothGattCharacteristic c : s.getCharacteristics()) {
                int p = c.getProperties();
                chars.put(new JSONObject()
                        .put("uuid", c.getUuid().toString().toLowerCase(Locale.ROOT))
                        .put("props", new JSONObject()
                                .put("read", (p & BluetoothGattCharacteristic.PROPERTY_READ) != 0)
                                .put("write", (p & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0)
                                .put("writeWithoutResponse", (p & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0)
                                .put("notify", (p & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0)
                                .put("indicate", (p & BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0)));
            }
            out.put(new JSONObject().put("uuid", s.getUuid().toString().toLowerCase(Locale.ROOT)).put("chars", chars));
        }
        return out.toString();
    }

    private final BluetoothGattCallback callback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            synchronized (BleLink.this) {
                if (g != gatt) return;
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    if (!g.discoverServices() && pendingConnect != null) { Result r = pendingConnect; pendingConnect = null; r.done(false, "Could not read the adapter's services"); }
                    return;
                }
                if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    Result r = pendingConnect; pendingConnect = null;
                    close();
                    if (r != null) r.done(false, "Connection attempt failed (status " + status + ")");
                    else listener.onDisconnected();
                }
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            Result r;
            String json = null;
            synchronized (BleLink.this) {
                r = pendingConnect; pendingConnect = null;
                if (r == null) return;
                if (status == BluetoothGatt.GATT_SUCCESS) { try { json = describe(g); } catch (JSONException ignored) { } }
            }
            if (json != null) r.done(true, json); else r.done(false, "Could not read the adapter's services");
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) {
            Result r;
            synchronized (BleLink.this) { r = pendingNotify; pendingNotify = null; }
            if (r != null) r.done(status == BluetoothGatt.GATT_SUCCESS, status == BluetoothGatt.GATT_SUCCESS ? "" : "Notifications refused");
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            synchronized (BleLink.this) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    writes.clear(); writing = false;
                    Result r = writesDone; writesDone = null;
                    if (r != null) r.done(false, "Write failed (status " + status + ")");
                    return;
                }
                nextWrite();
            }
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {   // Android 13+
            listener.onNotify(c.getService().getUuid().toString().toLowerCase(Locale.ROOT), c.getUuid().toString().toLowerCase(Locale.ROOT), value);
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {               // Android 12
            if (Build.VERSION.SDK_INT >= 33) return;
            listener.onNotify(c.getService().getUuid().toString().toLowerCase(Locale.ROOT), c.getUuid().toString().toLowerCase(Locale.ROOT), c.getValue());
        }
    };
}
