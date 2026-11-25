package com.a2405.leafdash;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * The read-only rule, a second time, in the app's own code.
 *
 * The web app already refuses anything that isn't read-only (isReadOnly() in app.js). This is the same list,
 * checked again just before a command is written to the adapter, so even a fault in the web code can't send the
 * car anything that could change it. Keep the two lists identical: only adapter set-up and information commands,
 * 21xx (battery group reads) and 22xxxx (read data by identifier). Never add write or control services
 * (2E, 2F, 31, 27, 10, 11, 14, 28, 85 ...).
 */
final class ReadOnlyGuard {
    private ReadOnlyGuard() {}

    private static final Pattern[] AT_ALLOWED = {
            p("ATZ"), p("ATWS"), p("ATI"), p("AT@1"), p("ATDPN?"), p("ATRV"),
            p("ATE0"), p("ATL0"), p("ATS0"), p("ATH[01]"), p("ATSP6"), p("ATCAF1"), p("ATAT[012]"),
            p("ATST[0-9A-F]{2}"), p("ATSH[0-9A-F]{3}"), p("ATCRA([0-9A-F]{3})?"),
            p("ATFCSH[0-9A-F]{3}"), p("ATFCSD300000"), p("ATFCSM1"),
            p("ATCSM1"),            // silent monitoring on (listen without acknowledging)
            p("ATMA"),              // monitor all (only used once silent mode is confirmed)
    };
    private static final Pattern GROUP_READ = p("21[0-9A-F]{2}");
    private static final Pattern DID_READ = p("22[0-9A-F]{4}");

    private static Pattern p(String re) { return Pattern.compile(re); }

    /** True only for a command that can't change anything in the car. */
    static boolean allowed(String raw) {
        if (raw == null) return false;
        String c = raw.toUpperCase(Locale.ROOT).replaceAll("\\s+", "");
        if (c.isEmpty()) return false;
        if (c.startsWith("AT")) {
            for (Pattern at : AT_ALLOWED) if (at.matcher(c).matches()) return true;
            return false;
        }
        return GROUP_READ.matcher(c).matches() || DID_READ.matcher(c).matches();
    }
}
