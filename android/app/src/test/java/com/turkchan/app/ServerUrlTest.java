package com.turkchan.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/**
 * Sunucu adresi normalleştirme kuralları.
 *
 * Bu saf (saf Android bağımlılığı olmayan) mantık MainActivity'de
 * {@code normalizeServerUrl} ile yaşar; test aynı kuralları doğrular.
 * Geçersiz adresin sessizce kabul edilmemesi, düz metin güvenlik kuralının
 * ilk savunma hattıdır.
 */
public class ServerUrlTest {

    private static final String[] LOCAL_HOSTS = {
            "localhost", "127.0.0.1", "10.0.2.2"
    };

    /** MainActivity#isLocalDevHost ile aynı kural. */
    private static boolean isLocalDevHost(String host) {
        if (host == null) return false;
        String h = host.toLowerCase();
        return h.equals("localhost") || h.equals("127.0.0.1") || h.equals("10.0.2.2");
    }

    private static String normalize(String raw) {
        if (raw == null || raw.trim().isEmpty()) return null;
        String value = raw.trim();
        if (value.contains(" ")) return null;
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            int schemeEnd = value.indexOf("://");
            if (schemeEnd > 0) {
                String scheme = value.substring(0, schemeEnd).toLowerCase();
                if (!scheme.equals("http") && !scheme.equals("https")) return null;
            }
            String bare = value;
            int slash = bare.indexOf('/');
            if (slash >= 0) bare = bare.substring(0, slash);
            int colon = bare.indexOf(':');
            if (colon >= 0) bare = bare.substring(0, colon);
            value = (isLocalDevHost(bare) ? "http://" : "https://") + value;
        }
        java.net.URI uri;
        try {
            uri = java.net.URI.create(value);
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

    // ---------------------------------------------------------- yerel geliştirme

    @Test
    public void yerelHostlarDuzMetinKabulEder() {
        for (String host : LOCAL_HOSTS) {
            assertEquals("http://" + host + ":3000", normalize("http://" + host + ":3000"));
        }
    }

    @Test
    public void semasizYerelAdresHttpVarsayilan() {
        assertEquals("http://localhost:3000", normalize("localhost:3000"));
    }

    // ------------------------------------------------------------ canlı sunucu

    @Test
    public void semasizAlanAdiHttpsVarsayilan() {
        assertEquals("https://ornek.site", normalize("ornek.site"));
        assertEquals("https://www.ornek.site/board", normalize("www.ornek.site/board"));
    }

    @Test
    public void httpsAdresOlduguGibiKalir() {
        assertEquals("https://turkchan.app", normalize("https://turkchan.app"));
    }

    // ------------------------------------------------------------- güvenlik

    @Test
    public void yerelOlmayanHosttaDuzMetinReddedilir() {
        assertNull(normalize("http://ornek.site"));
        assertNull(normalize("http://192.168.1.20:3000"));
        assertNull(normalize("http://10.0.0.5:8080"));
    }

    @Test
    public void baskaSchemalarReddedilir() {
        assertNull(normalize("ftp://ornek.site"));
        assertNull(normalize("javascript:alert(1)"));
        assertNull(normalize("file:///etc/passwd"));
    }

    @Test
    public void bosVeBozukGirdiReddedilir() {
        assertNull(normalize(null));
        assertNull(normalize(""));
        assertNull(normalize("   "));
        assertNull(normalize("iki kelime site"));
        assertNull(normalize("https://"));
    }
}
