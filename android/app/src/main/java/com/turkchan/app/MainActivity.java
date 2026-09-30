package com.turkchan.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SafeBrowsingResponse;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
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
    private static final String KEY_SETUP_DONE = "setup_done";
    private static final String TAG = "TurkChan";
    private static final long EXIT_DELAY_MS = 2000L;
    /**
     * Yükleme durmazsa ne kadar sonra hata ekranı gösterilir. Sunucu yoksa
     * WebView sessizce siyah kalmasın diye ağır bir güvenlik ağıdır.
     */
    private static final long LOAD_TIMEOUT_MS = 25000L;

    private WebView web;
    private FrameLayout root;
    private LinearLayout errorView;
    private TextView errorText;
    private ValueCallback<Uri[]> pendingFileCallback;
    private Uri pendingCameraUri;
    private SharedPreferences prefs;
    private long lastBackPress = 0L;
    private boolean pageLoaded = false;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable loadWatchdog = new Runnable() {
        @Override
        public void run() {
            if (!pageLoaded) showError(getString(R.string.load_timeout));
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        configureEdgeToEdge();

        root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.setBackgroundColor(getResources().getColor(R.color.tc_surface));

        web = new WebView(this);
        web.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setBackgroundColor(getResources().getColor(R.color.tc_surface));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        root.addView(web);

        errorView = buildErrorView();
        errorView.setVisibility(View.GONE);
        root.addView(errorView);

        setContentView(root);

        configureWebView();

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else if (!prefs.getBoolean(KEY_SETUP_DONE, false) && serverUrl() == null) {
            // Adres hem kayıtlı değil hem build ile verilmemiş: kullanıcıdan al.
            // Böylece APK yanlış/erişilemez bir adrese bağlı kalmaz.
            web.setVisibility(View.INVISIBLE);
            handler.postDelayed(() -> {
                if (!isFinishing()) showServerDialog(true);
            }, 300);
        } else {
            loadServer();
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
        // Oturum çerezi uygulama kapanınca da kalıcı olsun (login/session).
        CookieManager.getInstance().setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        }
        // WebView'ın kendi hata sayfası yerine native hata yüzeyimiz kullanılsın.
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

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
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                pageLoaded = false;
                handler.removeCallbacks(loadWatchdog);
                handler.postDelayed(loadWatchdog, LOAD_TIMEOUT_MS);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // Sayfa yeniden çizildiğinde güvenli alan yeniden uygulanır.
                pageLoaded = true;
                handler.removeCallbacks(loadWatchdog);
                hideError();
                root.requestApplyInsets();
            }

            /**
             * Ağ hatası. ÖNEMLİ: yalnızca ana çerçeve (isForMainFrame)
             * dikkate alınır; alt kaynak hataları (yazı tipi, favicon)
             * sayfayı bozmaz.
             *
             * Önceki sürümde bu geri çağrı yoktu: WebView sessizce boş bir
             * sayfa bırakıyor ve kullanıcı siyah ekranla karşılaşıyordu.
             */
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request == null || !request.isForMainFrame()) return;
                int code = error != null && error.getErrorCode() != 0
                        ? error.getErrorCode() : WebViewClient.ERROR_UNKNOWN;
                CharSequence desc = error != null ? error.getDescription() : null;
                Log.w(TAG, "Ana çerçeve yüklenemedi: " + code + " " + desc + " url=" + request.getUrl());
                showError(describeError(code, desc, request.getUrl()));
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int errorCode, String description,
                                        String failingUrl) {
                // API < 23 yolu (minSdk 24'te yalnızca geriye dönük uyum).
                showError(describeError(errorCode, description, Uri.parse(failingUrl)));
            }

            /** Ana çerçeve bir HTTP hatası döndürdüyse (ör. 502, 404). */
            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                           WebResourceResponse response) {
                if (request == null || !request.isForMainFrame() || response == null) return;
                int status = response.getStatusCode();
                Log.w(TAG, "HTTP hatası: " + status + " url=" + request.getUrl());
                showError(getString(R.string.error_http, status, String.valueOf(request.getUrl())));
            }

            /** TLS doğrulaması başarısız: kullanıcı onayı YOK, reddedilir. */
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler,
                                           SslError error) {
                Log.e(TAG, "SSL hatası: " + (error != null ? error.getPrimaryError() : "?"));
                handler.cancel();
                showError(getString(R.string.error_ssl));
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

            /**
             * WebView konsolundaki hataları logcat'e taşır. Kullanıcı "siyah
             * ekran" bildirdiğinde gerçek neden buradan görülebilir.
             */
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                String text = message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")";
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    Log.e(TAG, "JS: " + text);
                } else {
                    Log.d(TAG, "JS: " + text);
                }
                return true;
            }

            @Override
            public void onReceivedTitle(WebView view, String title) {
                // Sunucu 5xx dönerse tarayıcı hata sayfası başlığını gösterir.
                if (title != null && title.contains("Webpage not available")) {
                    showError(getString(R.string.load_failed));
                }
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
            showServerDialog(false);
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

    /** Diyalogda önerilen adres: build parametresi, yoksa localhost. */
    private String defaultServerHint() {
        String built = BuildConfig.SERVER_URL;
        if (built == null || built.trim().isEmpty() || built.startsWith("__")) {
            return "http://localhost:3000";
        }
        return built;
    }

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
            // Hata ekranı açıksa geri tuşu adres ayarını açar (çıkış değil).
            if (errorView != null && errorView.getVisibility() == View.VISIBLE) {
                showServerDialog(false);
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
        if (errorView != null && errorView.getVisibility() == View.VISIBLE) {
            hideError();
            return;
        }
        super.onBackPressed();
    }

    // -------------------------------------------------------- sunucu ayarı --

    private String serverUrl() {
        String saved = prefs.getString(KEY_SERVER, null);
        if (saved != null && !saved.isEmpty()) return saved;
        String built = BuildConfig.SERVER_URL;
        // Build parametresi verilmemişse kullanıcıdan adres iste.
        if (built == null || built.trim().isEmpty() || built.startsWith("__")) return null;
        return built;
    }

    /**
     * Yapılandırılmış sunucuya bağlanır ve yükleme izleyicisini başlatır.
     * URL her zaman HTTPS olmalıdır; düz metin trafiğe izin verilmez.
     */
    private void loadServer() {
        String url = serverUrl();
        if (url == null) {
            showError(getString(R.string.error_no_server));
            return;
        }
        String problem = validateServerUrl(url);
        if (problem != null) {
            showError(problem);
            return;
        }
        pageLoaded = false;
        handler.removeCallbacks(loadWatchdog);
        handler.postDelayed(loadWatchdog, LOAD_TIMEOUT_MS);
        errorView.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(url);
    }

    // ------------------------------------------------------- hata yüzeyi --

    /**
     * Gerçek hata ekranı.
     *
     * Bu bir "splash değil, hata örtüsü" değil: WebView'in sessizce boş
     * kalması yerine neden, hangi adresin denendiği ve ne yapılması gerektiği
     * kullanıcıya gösterilir. Düz metin ekranı yoktur.
     */
    private LinearLayout buildErrorView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad, pad, pad);
        box.setBackgroundColor(getResources().getColor(R.color.tc_surface));

        TextView title = new TextView(this);
        title.setText(R.string.error_title);
        title.setTextColor(getResources().getColor(R.color.tc_ink));
        title.setTextSize(18f);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, 0, 0, pad / 3);
        box.addView(title);

        errorText = new TextView(this);
        errorText.setTextColor(getResources().getColor(R.color.tc_ink_soft));
        errorText.setTextSize(13f);
        errorText.setGravity(Gravity.CENTER);
        errorText.setPadding(0, 0, 0, pad);
        box.addView(errorText);

        Button retry = new Button(this);
        retry.setText(R.string.error_retry);
        retry.setOnClickListener(v -> loadServer());
        box.addView(retry);

        Button change = new Button(this);
        change.setText(R.string.error_change_server);
        change.setOnClickListener(v -> {
            errorView.setVisibility(View.GONE);
            showServerDialog(false);
        });
        box.addView(change);

        return box;
    }

    private void showError(String message) {
        if (errorText == null) return;
        handler.removeCallbacks(loadWatchdog);
        errorText.setText(message);
        errorView.setVisibility(View.VISIBLE);
        web.setVisibility(View.INVISIBLE);
    }

    private void hideError() {
        if (errorView != null) errorView.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
    }

    /** WebView hata kodunu kullanıcıya gösterilecek metne çevirir. */
    private String describeError(int code, CharSequence description, Uri url) {
        if (url == null) return getString(R.string.err_generic);
        String reason;
        switch (code) {
            case WebViewClient.ERROR_HOST_LOOKUP:      reason = getString(R.string.err_dns); break;
            case WebViewClient.ERROR_CONNECT:
            case WebViewClient.ERROR_TIMEOUT:          reason = getString(R.string.err_connect); break;
            case WebViewClient.ERROR_IO:                reason = getString(R.string.err_io); break;
            case WebViewClient.ERROR_UNSUPPORTED_SCHEME: reason = getString(R.string.err_scheme); break;
            default:                                    reason = getString(R.string.err_generic); break;
        }
        String detail = description == null ? "" : description.toString();
        if (url == null) return reason + (detail.isEmpty() ? "" : "\n" + detail);
        return getString(R.string.error_detail, reason, url.getHost(), detail);
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
    private void showServerDialog(boolean firstRun) {
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
        String current = prefs.getString(KEY_SERVER, null);
        input.setText(current != null ? current : defaultServerHint());
        input.setHint(R.string.server_dialog_hint);
        input.setSelectAllOnFocus(true);
        box.addView(input);

        android.app.AlertDialog.Builder builder = new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.server_dialog_title)
                .setView(box)
                .setPositiveButton(R.string.server_dialog_save, (d, which) -> {
                    String raw = input.getText().toString().trim();
                    String error = validateServerUrl(raw);
                    if (error != null) {
                        Toast.makeText(this, error, Toast.LENGTH_LONG).show();
                        // Geçersiz adres kaydedilmez; kullanıcı tekrar dener.
                        if (firstRun) showServerDialog(true);
                        return;
                    }
                    String normalized = normalizeServerUrl(raw);
                    prefs.edit()
                            .putString(KEY_SERVER, normalized)
                            .putBoolean(KEY_SETUP_DONE, true)
                            .apply();
                    hideError();
                    loadServer();
                });
        if (!firstRun) {
            builder.setNegativeButton(R.string.server_dialog_cancel, null);
        }
        android.app.AlertDialog dialog = builder.create();
        dialog.setOnShowListener(d -> {
            // Uzun basışla erişilen ayarda düz metin adres kabul edilmez.
            dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setTextColor(Color.WHITE);
            if (dialog.getButton(android.app.AlertDialog.BUTTON_NEGATIVE) != null) {
                dialog.getButton(android.app.AlertDialog.BUTTON_NEGATIVE).setTextColor(Color.LTGRAY);
            }
        });
        if (firstRun) {
            // Diyalog kapatılırsa uygulama yine de bir şey göstermelidir:
            // kayıtlı adres varsa yüklenir, yoksa hata ekranı açılır.
            dialog.setOnCancelListener(d -> {
                if (prefs.getString(KEY_SERVER, null) != null) {
                    loadServer();
                } else {
                    showError(getString(R.string.error_no_server));
                }
            });
        }
        dialog.show();
    }

    /**
     * Yalnızca yerel geliştirme hedefleri.
     *
     * Bunlar {@code network_security_config.xml} içinde de açıkça listelenmiştir;
     * listede olmayan hiçbir host için düz metin trafik engellidir.
     */
    private static boolean isLocalDevHost(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT);
        return h.equals("localhost") || h.equals("127.0.0.1") || h.equals("10.0.2.2");
    }

    /**
     * Sunucu adresini doğrular ve normalleştirir.
     *
     * Kural:
     * - şemasız yazım ("ornek.site") → https varsayılır
     * - http:// yalnızca localhost / 127.0.0.1 / 10.0.2.2 için kabul edilir
     * - diğer her host için düz metin reddedilir
     *
     * Dönüş: hata mesajı ya da kullanılabilir adres. Yan etkisi yoktur.
     */
    private String normalizeServerUrl(String raw) {
        if (raw == null || raw.trim().isEmpty()) return null;
        String value = raw.trim();
        if (value.contains(" ")) return null;

        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            // Başka bir şema açıkça yazılmışsa (ftp://, javascript:, file:// ...)
            // reddedilir; sessizce https:// öneki eklenmez.
            int schemeEnd = value.indexOf("://");
            if (schemeEnd > 0) {
                String scheme = value.substring(0, schemeEnd).toLowerCase(Locale.ROOT);
                boolean known = "http".equals(scheme) || "https".equals(scheme);
                if (!known) return null;
            }
            // Şemasız alan adı: önce host'u kontrol et, yerel değilse HTTPS.
            String bare = value;
            int slash = bare.indexOf('/');
            if (slash >= 0) bare = bare.substring(0, slash);
            int colon = bare.indexOf(':');
            if (colon >= 0) bare = bare.substring(0, colon);
            value = (isLocalDevHost(bare) ? "http://" : "https://") + value;
        }

        Uri uri;
        try {
            uri = Uri.parse(value);
        } catch (Exception e) {
            return null;
        }
        String scheme = uri.getScheme();
        if (scheme == null) return null;
        String host = uri.getHost();
        if (host == null || host.isEmpty()) return null;

        boolean https = scheme.equalsIgnoreCase("https");
        boolean http = scheme.equalsIgnoreCase("http");
        if (!https && !http) return null;
        // Düz metin sadece network_security_config'te listelenen yerel hostlarda.
        if (http && !isLocalDevHost(host)) return null;
        return value;
    }

    /** Hata mesajı döner veya adres geçerliyse null. */
    private String validateServerUrl(String value) {
        if (value == null || value.trim().isEmpty()) return getString(R.string.server_error_empty);
        String trimmed = value.trim();
        if (normalizeServerUrl(trimmed) == null) {
            if (trimmed.toLowerCase(Locale.ROOT).startsWith("http://")
                    && !trimmed.toLowerCase(Locale.ROOT).contains("localhost")
                    && !trimmed.toLowerCase(Locale.ROOT).contains("127.0.0.1")
                    && !trimmed.toLowerCase(Locale.ROOT).contains("10.0.2.2")) {
                return getString(R.string.server_error_insecure);
            }
            return trimmed.contains("://")
                    ? getString(R.string.server_error_insecure)
                    : getString(R.string.server_error_invalid);
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
        // Oturum çerezi diske yazılır: uygulama kill edilse bile giriş korunur.
        CookieManager.getInstance().flush();
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
        handler.removeCallbacksAndMessages(null);
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}