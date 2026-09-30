# TurkChan kabuğu reflection kullanmaz; WebView'dan JavaScript köprüsü de yoktur.
# Yalnızca manifest'te bildirilen Activity korunur (AGP zaten saklar).
-keepclassmembers class * extends android.app.Activity { public void *(android.view.View); }

# Log satırları release derlemesinde tamamen düşürülür.
-assumenosideeffects class android.util.Log {
    public static boolean isLoggable(java.lang.String, int);
    public static int v(...);
    public static int d(...);
    public static int i(...);
}
