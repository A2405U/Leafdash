package com.a2405.leafdash;

import android.content.Intent;

import androidx.annotation.NonNull;
import androidx.car.app.CarAppService;
import androidx.car.app.Screen;
import androidx.car.app.Session;
import androidx.car.app.SessionInfo;
import androidx.car.app.validation.HostValidator;

/** What Android Auto starts when Leaf Dash is opened on the car screen. */
public final class LeafCarService extends CarAppService {

    @NonNull
    @Override
    public HostValidator createHostValidator() {
        // Only Google's own car hosts (Android Auto, which the desktop simulator also goes through, and Android
        // Automotive): another app on the phone pretending to be a car screen is refused. The list ships with the
        // Car App Library.
        return new HostValidator.Builder(getApplicationContext())
                .addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample)
                .build();
    }

    @NonNull
    @Override
    public Session onCreateSession(@NonNull SessionInfo sessionInfo) {
        return new LeafSession();
    }

    @SuppressWarnings("deprecation")
    @NonNull
    @Override
    public Session onCreateSession() {
        return new LeafSession();
    }

    private static final class LeafSession extends Session {
        @NonNull
        @Override
        public Screen onCreateScreen(@NonNull Intent intent) {
            return new DriveScreen(getCarContext());
        }
    }
}
