package com.a2405.leafdash;

import android.content.Intent;

import androidx.annotation.NonNull;
import androidx.car.app.CarAppService;
import androidx.car.app.Screen;
import androidx.car.app.Session;
import androidx.car.app.SessionInfo;
import androidx.car.app.validation.HostValidator;

/** What Android Auto starts when Leaf Dash Test is opened on the car screen. */
public final class LeafCarService extends CarAppService {

    @NonNull
    @Override
    public HostValidator createHostValidator() {
        // A private test build: accept whichever Android Auto (or desktop simulator) asks.
        return HostValidator.ALLOW_ALL_HOSTS_VALIDATOR;
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
