package com.invisible.assistant;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "FloatingOverlay")
public class FloatingOverlayPlugin extends Plugin {
    private static FloatingOverlayPlugin activeInstance;
    private static String pendingScreenshotBase64;

    @Override
    public void load() {
        super.load();
        activeInstance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (activeInstance == this) {
            activeInstance = null;
        }
        super.handleOnDestroy();
    }

    public static void emitCapturedScreen(String base64) {
        pendingScreenshotBase64 = base64;
        FloatingOverlayPlugin inst = activeInstance;
        if (inst != null) {
            JSObject data = new JSObject();
            data.put("base64", base64);
            inst.notifyListeners("screenCaptured", data, true);
        }
    }

    public static void emitOverlayState(boolean active) {
        FloatingOverlayPlugin inst = activeInstance;
        if (inst != null) {
            JSObject data = new JSObject();
            data.put("active", active);
            inst.notifyListeners("overlayStateChanged", data, true);
        }
    }

    @PluginMethod
    public void checkPermissions(PluginCall call) {
        boolean canOverlay = Settings.canDrawOverlays(getContext());
        JSObject ret = new JSObject();
        ret.put("overlay", canOverlay);
        ret.put("active", FloatingOverlayService.isRunning());
        call.resolve(ret);
    }

    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        Context ctx = getContext();
        if (Settings.canDrawOverlays(ctx)) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        Intent intent = new Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:" + ctx.getPackageName())
        );
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(intent);
        JSObject ret = new JSObject();
        ret.put("granted", false);
        ret.put("openedSettings", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void startFloatingOverlay(PluginCall call) {
        Context ctx = getContext();
        if (!Settings.canDrawOverlays(ctx)) {
            Intent intent = new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + ctx.getPackageName())
            );
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("needsOverlayPermission", true);
            call.resolve(ret);
            return;
        }

        if (FloatingOverlayService.isRunning()) {
            Activity act = getActivity();
            if (act != null) {
                act.moveTaskToBack(true);
            }
            JSObject ret = new JSObject();
            ret.put("started", true);
            call.resolve(ret);
            return;
        }

        MediaProjectionManager mpm =
            (MediaProjectionManager) ctx.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null) {
            call.reject("MediaProjectionManager unavailable");
            return;
        }
        Intent captureIntent = mpm.createScreenCaptureIntent();
        startActivityForResult(call, captureIntent, "handleMediaProjectionResult");
    }

    @ActivityCallback
    private void handleMediaProjectionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }

        Context ctx = getContext();
        Intent serviceIntent = new Intent(ctx, FloatingOverlayService.class);
        serviceIntent.setAction(FloatingOverlayService.ACTION_START);
        serviceIntent.putExtra(FloatingOverlayService.EXTRA_RESULT_CODE, result.getResultCode());
        serviceIntent.putExtra(FloatingOverlayService.EXTRA_RESULT_DATA, result.getData());

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(serviceIntent);
        } else {
            ctx.startService(serviceIntent);
        }

        Activity act = getActivity();
        if (act != null) {
            act.moveTaskToBack(true);
        }

        JSObject ret = new JSObject();
        ret.put("started", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void stopFloatingOverlay(PluginCall call) {
        Context ctx = getContext();
        Intent serviceIntent = new Intent(ctx, FloatingOverlayService.class);
        serviceIntent.setAction(FloatingOverlayService.ACTION_STOP);
        ctx.stopService(serviceIntent);
        JSObject ret = new JSObject();
        ret.put("stopped", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void consumePendingScreenshot(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("base64", pendingScreenshotBase64);
        pendingScreenshotBase64 = null;
        call.resolve(ret);
    }

    @PluginMethod
    public void updateFloatingAnswer(PluginCall call) {
        String text = call.getString("text", "");
        boolean streaming = Boolean.TRUE.equals(call.getBoolean("streaming", false));
        FloatingOverlayService.updateAnswerPopup(text, streaming);
        call.resolve();
    }

    @PluginMethod
    public void hideFloatingAnswer(PluginCall call) {
        FloatingOverlayService.hideAnswerPopup();
        call.resolve();
    }
}
