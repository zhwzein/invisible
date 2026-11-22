package com.invisible.assistant;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import androidx.core.app.NotificationCompat;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

public class FloatingOverlayService extends Service {
    public static final String ACTION_START = "com.invisible.assistant.ACTION_START";
    public static final String ACTION_STOP = "com.invisible.assistant.ACTION_STOP";
    public static final String EXTRA_RESULT_CODE = "result_code";
    public static final String EXTRA_RESULT_DATA = "result_data";

    private static final String CHANNEL_ID = "invisible_overlay_channel";
    private static final int NOTIFICATION_ID = 4201;
    private static final int MAX_CAPTURE_EDGE = 1440;

    private static volatile boolean running = false;
    private static volatile FloatingOverlayService instance;

    private WindowManager windowManager;
    private View rootView;
    private LinearLayout menuContainer;
    private WindowManager.LayoutParams overlayParams;

    private View answerPopupView;
    private TextView answerTextView;
    private TextView answerTitleView;
    private ScrollView answerScrollView;
    private String lastAnswerText = "";

    private MediaProjection mediaProjection;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private boolean menuExpanded = false;
    private boolean capturing = false;

    public static boolean isRunning() {
        return running;
    }

    public static void updateAnswerPopup(String text, boolean streaming) {
        FloatingOverlayService svc = instance;
        if (svc == null) return;
        svc.mainHandler.post(() -> svc.showAnswerPopupInternal(text, streaming));
    }

    public static void hideAnswerPopup() {
        FloatingOverlayService svc = instance;
        if (svc == null) return;
        svc.mainHandler.post(svc::removeAnswerPopupInternal);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        createNotificationChannel();
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            );
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        if (intent != null) {
            int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED);
            Intent resultData = intent.getParcelableExtra(EXTRA_RESULT_DATA);
            if (resultCode == Activity.RESULT_OK && resultData != null) {
                MediaProjectionManager mpm =
                    (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
                if (mpm != null) {
                    if (mediaProjection != null) {
                        mediaProjection.stop();
                    }
                    mediaProjection = mpm.getMediaProjection(resultCode, resultData);
                    if (mediaProjection != null) {
                        mediaProjection.registerCallback(new MediaProjection.Callback() {
                            @Override
                            public void onStop() {
                                mainHandler.post(() -> stopSelf());
                            }
                        }, mainHandler);
                    }
                }
            }
        }

        if (rootView == null) {
            showOverlayBubble();
        }

        running = true;
        instance = this;
        FloatingOverlayPlugin.emitOverlayState(true);
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (instance == this) instance = null;
        FloatingOverlayPlugin.emitOverlayState(false);

        removeAnswerPopupInternal();
        if (rootView != null && windowManager != null) {
            try {
                windowManager.removeView(rootView);
            } catch (Exception ignored) {}
            rootView = null;
        }
        if (mediaProjection != null) {
            try {
                mediaProjection.stop();
            } catch (Exception ignored) {}
            mediaProjection = null;
        }
        super.onDestroy();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Invisible Floating Overlay",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Allows Invisible to float over other apps and read screen content");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPending = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent stopIntent = new Intent(this, FloatingOverlayService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Invisible Overlay Active")
            .setContentText("Tap the floating bubble to scan any app on screen")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(openPending)
            .addAction(0, "Stop", stopPending)
            .setOngoing(true)
            .build();
    }

    private int dp(int value) {
        return Math.round(
            TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP,
                value,
                getResources().getDisplayMetrics()
            )
        );
    }

    private void showOverlayBubble() {
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        if (windowManager == null) return;

        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.HORIZONTAL);
        container.setGravity(Gravity.CENTER_VERTICAL);

        // Main floating bubble button
        StarBubbleView bubble = new StarBubbleView(this);
        LinearLayout.LayoutParams bubbleLp = new LinearLayout.LayoutParams(dp(50), dp(50));
        bubble.setLayoutParams(bubbleLp);
        bubble.setElevation(dp(8));

        // Expandable pill menu next to bubble
        menuContainer = new LinearLayout(this);
        menuContainer.setOrientation(LinearLayout.HORIZONTAL);
        menuContainer.setGravity(Gravity.CENTER_VERTICAL);
        menuContainer.setPadding(dp(6), dp(5), dp(6), dp(5));
        menuContainer.setVisibility(View.GONE);

        GradientDrawable menuBg = new GradientDrawable();
        menuBg.setColor(Color.parseColor("#EE131318"));
        menuBg.setCornerRadius(dp(24));
        menuBg.setStroke(dp(1), Color.parseColor("#33FFFFFF"));
        menuContainer.setBackground(menuBg);

        LinearLayout.LayoutParams menuLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        menuLp.setMarginStart(dp(8));
        menuContainer.setLayoutParams(menuLp);

        TextView scanBtn = createMenuChip("Scan", "#4d9cff", "#ffffff");
        scanBtn.setOnClickListener(v -> {
            collapseMenu();
            captureScreenNow();
        });

        TextView openBtn = createMenuChip("Open", "#1f2029", "#f3f4f8");
        openBtn.setOnClickListener(v -> {
            collapseMenu();
            bringAppToFront();
        });

        TextView closeBtn = createMenuChip("×", "#2a1619", "#ff6b6b");
        closeBtn.setOnClickListener(v -> stopSelf());

        menuContainer.addView(scanBtn);
        menuContainer.addView(openBtn);
        menuContainer.addView(closeBtn);

        container.addView(bubble);
        container.addView(menuContainer);
        rootView = container;

        int layoutType = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;

        overlayParams = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            layoutType,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_SECURE,
            PixelFormat.TRANSLUCENT
        );
        overlayParams.gravity = Gravity.TOP | Gravity.START;
        overlayParams.x = dp(12);
        overlayParams.y = dp(180);

        bubble.setOnTouchListener(new View.OnTouchListener() {
            private int startX, startY;
            private float touchX, touchY;
            private boolean moved;

            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        startX = overlayParams.x;
                        startY = overlayParams.y;
                        touchX = event.getRawX();
                        touchY = event.getRawY();
                        moved = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        int dx = Math.round(event.getRawX() - touchX);
                        int dy = Math.round(event.getRawY() - touchY);
                        if (Math.abs(dx) > dp(5) || Math.abs(dy) > dp(5)) {
                            moved = true;
                        }
                        overlayParams.x = startX + dx;
                        overlayParams.y = startY + dy;
                        if (rootView != null && windowManager != null) {
                            windowManager.updateViewLayout(rootView, overlayParams);
                        }
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (!moved) {
                            toggleMenu();
                        }
                        return true;
                }
                return false;
            }
        });

        windowManager.addView(rootView, overlayParams);
    }

    private TextView createMenuChip(String label, String bgHex, String textHex) {
        TextView tv = new TextView(this);
        tv.setText(label);
        tv.setTextColor(Color.parseColor(textHex));
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        tv.setPadding(dp(12), dp(7), dp(12), dp(7));

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor(bgHex));
        bg.setCornerRadius(dp(18));
        tv.setBackground(bg);

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        lp.setMarginEnd(dp(4));
        tv.setLayoutParams(lp);
        return tv;
    }

    private void toggleMenu() {
        menuExpanded = !menuExpanded;
        if (menuContainer != null) {
            menuContainer.setVisibility(menuExpanded ? View.VISIBLE : View.GONE);
        }
    }

    private void collapseMenu() {
        menuExpanded = false;
        if (menuContainer != null) {
            menuContainer.setVisibility(View.GONE);
        }
    }

    private void bringAppToFront() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
        );
        startActivity(intent);
    }

    private void captureScreenNow() {
        if (capturing || mediaProjection == null) {
            bringAppToFront();
            return;
        }
        capturing = true;

        // Briefly hide bubble so it never obstructs the captured app
        if (rootView != null) {
            rootView.setVisibility(View.INVISIBLE);
        }

        mainHandler.postDelayed(() -> {
            DisplayMetrics metrics = getResources().getDisplayMetrics();
            int width = metrics.widthPixels;
            int height = metrics.heightPixels;
            int density = metrics.densityDpi;

            // Scale down for fast upload & low memory
            int longEdge = Math.max(width, height);
            float scale = longEdge > MAX_CAPTURE_EDGE ? (float) MAX_CAPTURE_EDGE / longEdge : 1f;
            int capW = Math.max(1, Math.round(width * scale));
            int capH = Math.max(1, Math.round(height * scale));

            ImageReader reader = ImageReader.newInstance(capW, capH, PixelFormat.RGBA_8888, 2);
            VirtualDisplay virtualDisplay = mediaProjection.createVirtualDisplay(
                "InvisibleCapture",
                capW,
                capH,
                density,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                reader.getSurface(),
                null,
                mainHandler
            );

            reader.setOnImageAvailableListener(r -> {
                Image image = null;
                try {
                    image = r.acquireLatestImage();
                    if (image == null) return;

                    r.setOnImageAvailableListener(null, null);

                    Image.Plane[] planes = image.getPlanes();
                    ByteBuffer buffer = planes[0].getBuffer();
                    int pixelStride = planes[0].getPixelStride();
                    int rowStride = planes[0].getRowStride();
                    int rowPadding = rowStride - pixelStride * capW;

                    Bitmap raw = Bitmap.createBitmap(
                        capW + rowPadding / pixelStride,
                        capH,
                        Bitmap.Config.ARGB_8888
                    );
                    raw.copyPixelsFromBuffer(buffer);
                    Bitmap cropped = Bitmap.createBitmap(raw, 0, 0, capW, capH);
                    raw.recycle();

                    ByteArrayOutputStream baos = new ByteArrayOutputStream();
                    cropped.compress(Bitmap.CompressFormat.JPEG, 82, baos);
                    cropped.recycle();

                    String base64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
                    showAnswerPopupInternal("Analyzing screen...", true);
                    FloatingOverlayPlugin.emitCapturedScreen(base64);
                } catch (Exception ignored) {
                } finally {
                    if (image != null) image.close();
                    virtualDisplay.release();
                    reader.close();
                    if (rootView != null) {
                        rootView.setVisibility(View.VISIBLE);
                    }
                    capturing = false;
                }
            }, mainHandler);
        }, 90);
    }

    private void showAnswerPopupInternal(String text, boolean streaming) {
        if (windowManager == null) {
            windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        }
        if (windowManager == null) return;

        lastAnswerText = text != null ? text : "";

        if (answerPopupView == null) {
            DisplayMetrics dm = getResources().getDisplayMetrics();
            int cardWidth = Math.min(dm.widthPixels - dp(28), dp(360));
            int maxBodyHeight = Math.round(dm.heightPixels * 0.34f);

            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setPadding(dp(14), dp(10), dp(14), dp(12));

            GradientDrawable cardBg = new GradientDrawable();
            cardBg.setColor(Color.parseColor("#EB101218"));
            cardBg.setCornerRadius(dp(16));
            cardBg.setStroke(dp(1), Color.parseColor("#4D4d9cff"));
            card.setBackground(cardBg);
            card.setElevation(dp(12));

            // Header row
            LinearLayout header = new LinearLayout(this);
            header.setOrientation(LinearLayout.HORIZONTAL);
            header.setGravity(Gravity.CENTER_VERTICAL);
            header.setPadding(0, 0, 0, dp(8));

            answerTitleView = new TextView(this);
            answerTitleView.setText("Invisible");
            answerTitleView.setTextColor(Color.parseColor("#4d9cff"));
            answerTitleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
            answerTitleView.setTypeface(null, Typeface.BOLD);
            LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            answerTitleView.setLayoutParams(titleLp);

            TextView copyBtn = createMenuChip("Copy", "#1a1a22", "#f3f4f8");
            copyBtn.setOnClickListener(v -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (cm != null && lastAnswerText != null && !lastAnswerText.isEmpty()) {
                    cm.setPrimaryClip(ClipData.newPlainText("Invisible Answer", lastAnswerText));
                    Toast.makeText(this, "Copied", Toast.LENGTH_SHORT).show();
                }
            });

            TextView openBtn = createMenuChip("Open", "#1a1a22", "#f3f4f8");
            openBtn.setOnClickListener(v -> {
                removeAnswerPopupInternal();
                bringAppToFront();
            });

            TextView closeBtn = createMenuChip("×", "#2a1619", "#ff6b6b");
            closeBtn.setOnClickListener(v -> removeAnswerPopupInternal());

            header.addView(answerTitleView);
            header.addView(copyBtn);
            header.addView(openBtn);
            header.addView(closeBtn);

            answerScrollView = new ScrollView(this);
            LinearLayout.LayoutParams scrollLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            );
            answerScrollView.setLayoutParams(scrollLp);

            answerTextView = new TextView(this);
            answerTextView.setTextColor(Color.parseColor("#f3f4f8"));
            answerTextView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
            answerTextView.setLineSpacing(dp(3), 1f);
            answerTextView.setMaxHeight(maxBodyHeight);
            answerScrollView.addView(answerTextView);

            card.addView(header);
            card.addView(answerScrollView);
            answerPopupView = card;

            int layoutType = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;

            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                cardWidth,
                WindowManager.LayoutParams.WRAP_CONTENT,
                layoutType,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                    | WindowManager.LayoutParams.FLAG_SECURE,
                PixelFormat.TRANSLUCENT
            );
            lp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
            lp.y = dp(48);

            windowManager.addView(answerPopupView, lp);
        }

        if (answerTitleView != null) {
            answerTitleView.setText(streaming ? "Invisible · Live" : "Invisible");
        }
        if (answerTextView != null) {
            answerTextView.setText(lastAnswerText);
        }
        if (answerScrollView != null) {
            answerScrollView.post(() -> answerScrollView.fullScroll(View.FOCUS_DOWN));
        }
    }

    private void removeAnswerPopupInternal() {
        if (answerPopupView != null && windowManager != null) {
            try {
                windowManager.removeView(answerPopupView);
            } catch (Exception ignored) {}
            answerPopupView = null;
            answerTextView = null;
            answerTitleView = null;
            answerScrollView = null;
        }
    }

    /** Custom drawn obsidian floating bubble with Invisible 4-point star icon. */
    private static class StarBubbleView extends View {
        private final Paint bgPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint borderPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint starPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path starPath = new Path();

        StarBubbleView(Context context) {
            super(context);
            bgPaint.setColor(Color.parseColor("#E6101218"));
            bgPaint.setStyle(Paint.Style.FILL);

            borderPaint.setColor(Color.parseColor("#804d9cff"));
            borderPaint.setStyle(Paint.Style.STROKE);
            borderPaint.setStrokeWidth(3f);

            starPaint.setColor(Color.parseColor("#4d9cff"));
            starPaint.setStyle(Paint.Style.FILL);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float cx = getWidth() / 2f;
            float cy = getHeight() / 2f;
            float radius = Math.min(cx, cy) - 3f;

            canvas.drawCircle(cx, cy, radius, bgPaint);
            canvas.drawCircle(cx, cy, radius, borderPaint);

            float r = radius * 0.48f;
            starPath.reset();
            starPath.moveTo(cx, cy - r);
            starPath.quadTo(cx, cy, cx + r, cy);
            starPath.quadTo(cx, cy, cx, cy + r);
            starPath.quadTo(cx, cy, cx - r, cy);
            starPath.quadTo(cx, cy, cx, cy - r);
            starPath.close();
            canvas.drawPath(starPath, starPaint);
        }
    }
}
