package com.turkchan.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SafeBrowsingResponse;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.util.ArrayList;
import java.util.Locale;

/**
 * TurkChan Android kabuğu.
 *
 * Sunucu, veritabanı ve güvenlik kuralları web tarafında yaşamaya devam eder;
 * bu sınıf yalnızca onu bir WebView içinde barındırır ve Android'e özgü
 * davranışları (geri tuşu, güvenli alan, dosya seçimi, paylaşım) sağlar.
 *
 * JavaScript köprüsü YOKTUR: uygulama hiçbir şekilde sayfaya kod enjekte
 * etmez, bu yüzden saldırgan içeriği yerel bir köprü üzerinden çalıştıramaz.
 * Safe-area değerleri yalnızca CSS değişkeni olarak ayarlanır.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "turkchan";
    private static final String KEY_SERVER = "server_url";
    private static final long EXIT_DELAY_MS = 2000L;

    private WebView web;
    private FrameLayout root;
    private ValueCallback<Uri[]> pendingFileCallback;
    private Uri pendingCameraUri;
    private SharedPreferences prefs;
    private long lastBackPress = 0L;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        configureEdgeToEdge();

        root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.setBackgroundColor(Color.BLACK);

        web = new WebView(this);
        web.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setBackgroundColor(Color.BLACK);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        root.addView(web);
        setContentView(root);

        configureWebView();

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(serverUrl());
        }

        applyInsets();
        handleIncomingIntent(getIntent());
    }

    // ------------------------------------------------------------ pencere --

    /**
     * Kenardan kenara (edge-to-edge) düzen.
     *
     * WebView sistem çubuklarının arkasına uzanır; içerik kaymasın diye
     * güvenli alan değerleri CSS'e aktarılır.
     */
    private void configureEdgeToEdge() {
        Window window = getWindow();
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.getAttributes().layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
        } else {
            // API 30 altında decor'a bayrak ekleyerek aynı sonuca ulaşılır.
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        // Klavye açılınca düzen bozulmasın.
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    }

    /**
     * Sistem çubuğu / çentik / klavye alanlarını ölçüp CSS değişkeni olarak
     * sayfaya verir. Sayfanın kendi düzeni değişmez; yalnızca kenarlardaki
     * boşluklar gerçek sistem ölçülerine göre ayarlanır.
     */
    private void applyInsets() {
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int top, bottom, left, right;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                top = bars.top;
                left = bars.left;
                right = bars.right;
                bottom = Math.max(bars.bottom, ime.bottom);
            } else {
                top = insets.getSystemWindowInsetTop();
                left = insets.getSystemWindowInsetLeft();
                right = insets.getSystemWindowInsetRight();
                bottom = insets.getSystemWindowInsetBottom();
            }
            pushSafeArea(top, right, bottom, left);
            return insets;
        });
        root.requestApplyInsets();
    }

    /**
     * Güvenli alanı CSS'e aktarır.
     *
     * `document.documentElement.classList.add('tc-android')` ile yalnızca
     * Android kabuğunda etkinleşen bir sınıf eklenir; web sürümü etkilenmez.
     */
    private void pushSafeArea(int top, int right, int bottom, int left) {
        final String js =
                "(function(){try{"
                        + "var r=document.documentElement;"
                        + "if(!r)return;"
                        + "r.classList.add('tc-android');"
                        + "r.style.setProperty('--tc-safe-top','" + top + "px');"
                        + "r.style.setProperty('--tc-safe-right','" + right + "px');"
                        + "r.style.setProperty('--tc-safe-bottom','" + bottom + "px');"
                        + "r.style.setProperty('--tc-safe-left','" + left + "px');"
                        + "}catch(e){}})();";
        web.evaluateJavascript(js, null);
    }

    // ------------------------------------------------------------ webview --

    private void configureWebView() {
        WebSettings s = web.getSettings();
        // Sunucu tarafı zaten CSP ile satır içi script'i yasaklıyor; burada
        // yalnızca uygulamanın ihtiyaç duyduğu motor özellikleri açılır.
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " TurkChanAndroid/" + BuildConfig.VERSION_NAME);

        // JavaScript köprüsü açılmaz; dışarıdan çağrılmış hiçbir yöntem yok.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1) {
            web.removeJavascriptInterface("*");
        }
        CookieManager.getInstance().setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // Sayfa yeniden çizildiğinde güvenli alan yeniden uygulanır.
                root.requestApplyInsets();
            }

            @Override
            public void onSafeBrowsingHit(WebView view, WebResourceRequest request, int threatType,
                                          SafeBrowsingResponse callback) {
                // Tehdit algılanırsa yüklemeyi iptal et.
                callback.backToSafety(true);
                Toast.makeText(MainActivity.this, R.string.app_name + ": güvenli olmayan bağlantı engellendi",
                        Toast.LENGTH_LONG).show();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                openFileChooser(callback, params);
                return true;
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Uygulama kamera/mikrofon izni istemez; istekler reddedilir.
                request.deny();
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                                                            android.webkit.GeolocationPermissions.Callback callback) {
                callback.invoke(origin, false, false);
            }
        });

        // Sunucu ayarı: herhangi bir yere uzun basıldığında açılır. Böylece
        // uygulamaya menü çubuğu eklemeden de adres değiştirilebilir.
        web.setOnLongClickListener(v -> {
            showServerDialog();
            return true;
        });
    }
    private boolean handleUrl(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (scheme.equals("http") || scheme.equals("https")) {
            if (isSameHost(uri)) return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.server_error_invalid, Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private boolean isSameHost(Uri uri) {
        String active = web.getUrl();
        if (active == null) return false;
        String host = Uri.parse(active).getHost();
        return host != null && host.equalsIgnoreCase(uri.getHost());
    }

    // ------------------------------------------------ dosya / kamera seçimi --

    /**
     * `<input type="file">` için seçici.
     *
     * Önce galeri/OTA dosya seçici, kullanıcı galeriyi seçmezse kamera.
     * Kamera yolu ACTION_IMAGE_CAPTURE kullanır; bu yol çalışma zamanı
     * kamera izni gerektirmez (uygulama CAMERA izni bildirmez).
     */
    private void openFileChooser(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        if (pendingFileCallback != null) {
            pendingFileCallback.onReceiveValue(null);
        }
        pendingFileCallback = callback;

        Intent content = new Intent(params.createIntent());
        content.addCategory(Intent.CATEGORY_OPENABLE);
        content.setType("*/*");

        Intent chooser = Intent.createChooser(content, null);
        chooser.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE);
        chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, buildInitialIntents());
        try {
            startActivityForResult(chooser, REQ_PICK);
        } catch (ActivityNotFoundException e) {
            pendingFileCallback = null;
            Toast.makeText(this, R.string.server_error_invalid, Toast.LENGTH_SHORT).show();
        }
    }

    private Intent[] buildInitialIntents() {
        ArrayList<Intent> extras = new ArrayList<>();

        // Kamera
        File dir = new File(getCacheDir(), "captures");
        if (!dir.exists() && !dir.mkdirs()) return new Intent[0];
        File image = new File(dir, "capture-" + System.currentTimeMillis() + ".jpg");
        pendingCameraUri = FileProvider.getUriForFile(
                this, getPackageName() + ".fileprovider", image);
        Intent capture = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        capture.putExtra(MediaStore.EXTRA_OUTPUT, pendingCameraUri);
        capture.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if (capture.resolveActivity(getPackageManager()) != null) {
            extras.add(capture);
        }
        return extras.toArray(new Intent[0]);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_PICK) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (pendingFileCallback == null) return;

        Uri[] results = null;
        if (resultCode == RESULT_OK) {
            if (data != null && data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int i = 0; i < count; i++) {
                    results[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data != null && data.getData() != null) {
                results = new Uri[]{data.getData()};
            } else if (pendingCameraUri != null) {
                results = new Uri[]{pendingCameraUri};
            }
        }
        pendingFileCallback.onReceiveValue(results);
        pendingFileCallback = null;
    }

    private static final int REQ_PICK = 1001;

    // ------------------------------------------------------------- geri tuşu --

    /**
     * Android geri tuşu davranışı:
     *
     *  1. Sayfada geçmiş varsa bir geri gider.
     *  2. Ana sayfada ilk geri "çıkmak için tekrar bas" ipucu verir,
     *     ikinci geri (2 sn içinde) uygulamayı kapatır.
     */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_DOWN) {
            if (web.canGoBack()) {
                web.goBack();
                return true;
            }
            long now = System.currentTimeMillis();
            if (now - lastBackPress < EXIT_DELAY_MS) {
                finish();
                return true;
            }
            lastBackPress = now;
            Toast.makeText(this, R.string.exit_hint, Toast.LENGTH_SHORT).show();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    // -------------------------------------------------------- sunucu ayarı --

    private String serverUrl() {
        String saved = prefs.getString(KEY_SERVER, null);
        if (saved != null && !saved.isEmpty()) return saved;
        return BuildConfig.SERVER_URL;
    }

    /**
     * Paylaşım/bağlantı intent'lerini karşılar.
     *
     * Paylaşılan bir TurkChan bağlantısı uygulamada açılır; başka bağlantılar
     * dışarıda bırakılır.
     */
    private void handleIncomingIntent(Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String shared = null;
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            shared = intent.getStringExtra(Intent.EXTRA_TEXT);
        } else if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            shared = intent.getDataString();
        }
        if (shared == null) return;
        String trimmed = shared.trim();
        Uri uri = Uri.parse(trimmed);
        if (("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme()))
                && isSameHost(uri)) {
            web.loadUrl(trimmed);
        }
    }

    /**
     * Sunucu adresi penceresi.
     *
     * Yalnızca HTTPS adresleri kabul edilir; uygulamanın güvenliği sunucu
     * tarafında olduğu için düz metin adres asla kabul edilmez.
     */
    private void showServerDialog() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad, pad, pad);
        box.setBackgroundResource(R.drawable.rounded_dialog);

        TextView message = new TextView(this);
        message.setText(R.string.server_dialog_message);
        message.setTextColor(Color.WHITE);
        message.setPadding(0, 0, 0, pad / 2);
        box.addView(message);

        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setTextColor(Color.WHITE);
        input.setHintTextColor(Color.GRAY);
        input.setText(serverUrl());
        box.addView(input);

        android.app.AlertDialog dialog = new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.server_dialog_title)
                .setView(box)
                .setPositiveButton(R.string.server_dialog_save, (d, which) -> {
                    String value = input.getText().toString().trim();
                    String error = validateServerUrl(value);
                    if (error != null) {
                        Toast.makeText(this, error, Toast.LENGTH_LONG).show();
                        return;
                    }
                    prefs.edit().putString(KEY_SERVER, value).apply();
                    web.clearHistory();
                    web.loadUrl(value);
                })
                .setNegativeButton(R.string.server_dialog_cancel, null)
                .create();
        dialog.setOnShowListener(d -> {
            // Uzun basışla erişilen ayarda düz metin adres kabul edilmez.
            dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setTextColor(Color.WHITE);
            dialog.getButton(android.app.AlertDialog.BUTTON_NEGATIVE).setTextColor(Color.LTGRAY);
        });
        dialog.show();
    }

    private String validateServerUrl(String value) {
        if (value.isEmpty()) return getString(R.string.server_error_empty);
        Uri uri;
        try {
            uri = Uri.parse(value);
        } catch (Exception e) {
            return getString(R.string.server_error_invalid);
        }
        String scheme = uri.getScheme();
        if (scheme == null || !scheme.equalsIgnoreCase("https")) {
            return getString(R.string.server_error_insecure);
        }
        if (uri.getHost() == null || uri.getHost().isEmpty()) {
            return getString(R.string.server_error_invalid);
        }
        return null;
    }

    // ------------------------------------------------------------ yaşam döngüsü --

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Arka plandayken medya sesi sürdürülmez (pil).
        web.onPause();
        web.pauseTimers();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        web.resumeTimers();
        root.requestApplyInsets();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}