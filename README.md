# TurkChan — Türkiye’nin topluluk platformu

Kendi kendine barındırılabilen bir topluluk tartışma platformu — STK programları, gençlik kuruluşları, camiler ve medreseler için. Kullanıcıların oluşturduğu topluluklar, iç içe tartışmalar ve görünürlüğü belirleyen topluluk oylaması; yüzlerce ile birkaç bin kullanıcı ölçeğinde ve bu tür kuruluşların ilk günden ihtiyaç duyduğu moderasyon katmanıyla.

Built as a single deployable monolith: one process, one database file, no external services required to run it.

```
TypeScript · Hono (SSR JSX) · SQLite (node:sqlite, FTS5) · Argon2id · 204 tests
```

## Features

**Çekirdek mekanikler**
- Communities with three visibility types: **public** (anyone reads, members post), **restricted** (anyone reads, approved members post), **private** (approved members only — zero content leakage, enforced server-side everywhere: pages, feeds, search, profiles, OG tags, exports)
- Three post types: **text** (sanitised Markdown), **link** (server-side OG preview fetch with SSRF guard + duplicate-URL warning), **image** (pre-signed upload flow, magic-byte validation, EXIF/GPS stripped before storage)
- **Nested comments** to depth 8 (deeper replies flatten), materialized-path trees, permalinks with ancestor context, `[deleted]` placeholders that preserve thread structure
- **Voting** — one vote per user per item (DB unique constraint), idempotent, flip/remove, no self-votes; scores denormalised transactionally
- **Ranked feeds** — Reddit's hot formula with a configurable decay constant, New, Top (day/week/month/all), cursor-based pagination that stays stable while new content arrives
- **Best comment sort** — Wilson score lower bound, the right algorithm for few-vote small communities
- **Karma**, full-text **search** (FTS5, visibility-aware), in-app **notifications** (replies + mod actions, withdrawn if the reply is removed before you see it)
- **Karma ranks and staff roles** — six karma ranks (New User → God) derived from total karma, four staff roles (Moderator → Admin) assigned by the site admin, and a single badge next to every username. A staff role replaces the karma badge (never both), a restriction shows a dark "BANNED" badge, and lifting the restriction restores the previous badge automatically. Badges are animated GIF forum rank banners in `public/assets/ranks/`, regenerated with `npm run rank:assets`: a chevron-cut metal plate (100–180 × 30 px at 2× resolution) built from seven layers — base gradient, brushed-metal and diagonal texture, inlay with a separate icon plate, metallic icon emblem, embossed typography, double frame and an animated light sweep that crosses icon, then text, then exits. Higher ranks add corner studs, ribbons and a second frame, so the set reads as a progression

**Güvenlik ve yönetim**
- Reporting with community rules in the dialog, silent duplicate absorption, anonymous reporters, and an optional auto-hide-after-N-reports threshold
- Moderation per community: remove (with karma reversal + author notification), timed/permanent bans that lift automatically, pin up to 2 posts, moderator appointment with oldest-moderator removal rules, immutable mod log
- Site admin dashboard: suspend/unsuspend accounts, archive or soft-delete communities (typed confirmation, 30-day recovery window), registration policy (open / invite-only with expiring invite links / closed), community-creation policy, live-editable rate limits, JSON export per community with 24-hour download links
- Rate limiting on posts, comments, votes, reports, registration, and login; account lockout after repeated failed logins
- PDPA-minded: minimal collection (email + username), account self-deletion with anonymisation, privacy notice page, image metadata stripping

## Hızlı başlangıç

Requires **Node.js ≥ 22.5** (uses the built-in `node:sqlite`).

```bash
npm install
npm run seed   # demo communities + accounts (see below)
npm run dev    # → http://localhost:3000
```

İlk **kayıt olan kullanıcı site yöneticisi olur**. Seed ile gelen demo hesaplar:

| Hesap | Parola | Rol |
|---|---|---|
| `admin` | `seed-admin-pass-1` | Site yöneticisi |
| `ustazah_f` | `seed-mod-pass-1` | Topluluk moderatörü |
| `aisyah`, `rahim`, `nurul` | `seed-user-pass-{1,2,3}` | Üyeler |

```bash
npm test           # 204 tests: unit + full HTTP integration
npm run typecheck  # strict TypeScript, no emit
```

## Mimari

One web application, server-rendered, with a thin vanilla-JS enhancement layer (optimistic voting, Markdown preview, local-storage drafts). No client framework, no build step for the frontend.

```
src/
├── app.tsx            # Hono app assembly, session middleware, error pages
├── server.ts          # entrypoint (static files, maintenance sweep)
├── config.ts          # process config; runtime policies live in the DB
├── db/                # schema (portable SQL), seed script
├── lib/               # ranking math, markdown, rate limiter, cursors,
│                      #   EXIF stripper, SSRF guard, passwords, mailer port
├── services/          # all domain logic — auth, communities, posts,
│                      #   comments, votes, feeds, reports, moderation,
│                      #   admin, notifications, search, uploads, access
├── routes/            # thin HTTP handlers per area (+ JSON API)
├── views/             # JSX layout + components (mobile-first)
└── i18n/tr.ts         # tüm arayüz metinleri tek dosyada (Türkçe)
```

Design decisions worth knowing:

- **SQLite via `node:sqlite`** — zero native dependencies, FTS5 included, ideal for the single-VPS target and hermetic tests. The schema uses plain SQL types and epoch-ms timestamps so it ports to PostgreSQL without redesign.
- **Dependency-injected context** (`db`, `clock`, `mailer`, `storage`, `fetch`, rate limiter) — tests control time, mail, and the network; timed bans and token expiry are tested by advancing a fake clock.
- **Authorisation is centralised** in `services/access.ts` and enforced in the service layer, never only in views. The test suite includes an access-matrix sweep: every role attempts every restricted action.
- **Markdown is safe by construction** — raw HTML is disabled entirely (escaped, not sanitised after the fact); links get `rel="nofollow noopener"`; `javascript:`/`data:` URLs are neutralised.
- **Vote counting** — individual vote rows retained (auditable), score denormalised in the same transaction. No queues; this platform will never see Reddit's write volume.
- **Hot ranking decay is a site setting** (default 90 000 s vs Reddit's 45 000) so a small community's front page doesn't empty out on slow days.

## Testler

204 tests across 20 files, all runnable offline in ~2 s:

- **Unit** — hot/Wilson ranking math, Markdown XSS safety, sliding-window rate limiter, cursor codec, JPEG/PNG/WebP metadata stripping, SSRF address classification
- **Integration (through the real HTTP app)** — registration/login/lockout/reset/deletion, membership approval flows, all three post types (including multipart image upload with EXIF verification), comment nesting and depth-cap flattening, vote idempotency and flips, feed ordering and cursor stability, reporting/auto-hide/removal/bans/pins/mod-log, admin suspension/archival/purge/exports/invites, search visibility, notifications and withdrawal
- **Hardening** — CSRF origin rejection, open-redirect guard, malformed cursor/sort resilience, archived-community lockdown, private-community zero-leakage checks

## Yapılandırma

| Ayar | Nerede |
|---|---|
| `PORT`, `DB_PATH`, `UPLOAD_DIR`, `BASE_URL` | environment variables |
| Registration mode, community-creation policy | Admin → Settings (live) |
| Hot decay constant, all rate limits | Admin → Settings (live) |
| Auto-hide threshold, hidden comment scores | per-community settings (moderators) |

## Üretim notları

- Run behind **Caddy** (or any TLS-terminating proxy); set `NODE_ENV=production` to enable `Secure` cookies.
- Implement the `Mailer` interface (`src/lib/mailer.ts`) with a real provider (Resend/Postmark/SES) for password resets.
- Swap `LocalObjectStorage` for an S3-compatible implementation of the `ObjectStorage` interface and serve images via CDN.
- Back up nightly (`sqlite3 data/app.db ".backup ..."`) to off-server encrypted storage, and test restores. Or host the schema on PostgreSQL — it ports cleanly.
- Single-node by design: availability strategy is fast redeploy + backups, not HA.

## Android uygulaması (APK)

TurkChan’ın web uygulaması, arayüzü olduğu gibi yükleyen native bir WebView kabuğu
(`android/`) ile Android’e paketlenir. Backend, veritabanı ve güvenlik sistemi
aynı sunucuda çalışmaya devam eder; APK yalnızca istemcidir.

- **Package ID:** `com.turkchan.app` · **Uygulama adı:** TurkChan
- **minSdk 24 (Android 7.0) · targetSdk/compileSdk 34**
- **İzinler:** yalnızca `INTERNET` ve `ACCESS_NETWORK_STATE` (kamera izni yok —
  kamera `ACTION_IMAGE_CAPTURE` intent’i üzerinden çalışır, sistem izni istemez)
- **Güvenlik:** `usesCleartextTraffic="false"` + network security config; internetteki
  herhangi bir host için düz metin (HTTP) reddedilir (tek istisna: aşağıdaki
  loopback), JS köprüsü (`addJavascriptInterface`) yoktur, dosya sistemi erişimi
  kapalı, üçüncü taraf çerezler kapalı
- **Boyut:** R8 + kaynak küçültme ile ~200 KB

### Gereksinimler

JDK 17, Android SDK (platform 34 + build-tools 34.0.0) ve Gradle. Lokal SDK yolunu
`android/local.properties` içine yazın (`sdk.dir=/path/to/android-sdk`) ya da
`ANDROID_HOME` tanımlayın. GitHub Actions için `.github/workflows/android.yml`
hazırdır.

### Sunucu adresi

APK bir **istemcidir**; veriyi kendi sunucusundan çeker. Adres build zamanında
verilir:

```bash
# Yerel geliştirme (telefonun kendi localhost'u → bilgisayarınız)
./gradlew :app:assembleRelease -PserverUrl=http://localhost:3000

# Canlı sunucu
./gradlew :app:assembleRelease -PserverUrl=https://alan-adiniz

# Hiçbir şey vermezseniz: uygulama ilk açılışta adresi sorar
./gradlew :app:assembleRelease
```

Ayarlanan adres uygulamada kalıcıdır; değiştirmek için ekranın herhangi bir
yerine **uzun basın** (menü çubuğu eklenmez), hata ekranından **“Sunucu
adresini değiştir”** düğmesiyle veya geri tuşuyla erişilir.

> **Önemli — telefonda `localhost`:** Telefonda `localhost` **telefonun kendisidir**,
> bilgisayarınız değil. Bu yüzden `adb reverse` ile yönlendirme gerekir:
>
> ```bash
> npm run dev            # sunucuyu başlatın (3000)
> npm run android:link   # telefonun 3000'ünü bilgisayarın 3000'üne bağlar
> adb reverse --list     # doğrulama
> ```
>
> Alternatif: bilgisayarınızın LAN adresini kullanın (örn. `http://192.168.1.20:3000`)
> ve **debug** derlemesi alın — özel ağ adreslerine düz metin izni yalnızca
> `src/dev` içinde, `release` APK’sında yoktur.

### Sorun giderme

Uygulama siyah ekranla değil, **nedenini yazan bir hata ekranıyla** açılır
(DNS, bağlantı, zaman aşımı, HTTP kodu, TLS). Gerçek nedeni `adb logcat`
üzerinden de görebilirsiniz:

```bash
adb logcat -s TurkChan:* chromium:E
```

| Belirti | Sebep / Çözüm |
|---|---|
| “Sunucu adresi çözümlenemedi” | Adres yanlış ya da `adb reverse` kurulmamış |
| “Sunucuya bağlanılamadı” | Sunucu çalışmıyor veya telefon aynı ağda değil |
| “Sunucu HTTP 502 döndürdü” | Sunucu arka planda hata veriyor |
| TLS doğrulanamadı | Geçersiz sertifika — bağlantı bilerek iptal edilir |
| Hata ekranı hiç gelmiyor | Sunucu 25 sn yanıt vermedi (yükleme zaman aşımı) |

Bu ekran bir “yükleme animasyonu” değildir: WebView sessizce boş kaldığında
nedenini, denenen adresi ve ne yapılması gerektiğini gösterir.

### Komutlar

```bash
# 1) Marka varlıklarını üret (ikon, adaptive ikon, splash) — isteğe bağlı,
#    dosyalar depoda hazır.
npm run android:assets

# 2) Release APK derle (sunucu adresi verilir)
cd android
./gradlew :app:assembleRelease -PserverUrl=http://localhost:3000   # yerel
./gradlew :app:assembleRelease -PserverUrl=https://alan-adiniz    # canlı
# Çıktı: android/app/build/outputs/apk/release/app-release.apk

# Veya proje kökünden
npm run android:apk
```

Release imzalı APK üretmek için `android/keystore/turkchan-release.jks` dosyası
gereklidir (bu dosya depoya **girmez**, `.gitignore`’dadır). Anahtar yoksa APK
imzasız derlenir — dağıtım için `keytool` ile kendi anahtarınızı oluşturun:

```bash
keytool -genkeypair -v -keystore android/keystore/turkchan-release.jks \
  -alias turkchan -keyalg RSA -keysize 2048 -validity 10000
cd android && ./gradlew :app:assembleRelease \
  -PserverUrl=https://... -PstorePassword=... -PkeyAlias=... -PkeyPassword=...
```

### Davranış notları

- **Geri tuşu:** uygulama içindeki sayfalarda önce WebView geçmişi geri gider;
  ana sayfada tekrar geri basılırsa uygulama kapanır. Hata ekranı açıksa geri
  tuşu adres ayarını açar.
- **Güvenli alan:** sistem çentik/status bar/nav bar inset’leri
  `--tc-safe-*` CSS değişkenleri olarak sayfaya aktarılır; `html.tc-android`
  bloğu bunları kullanır. Web sürümü etkilenmez.
- **Dosya/görsel:** galeri seçici + kamera intent’i (`onShowFileChooser`),
  URI’ler `FileProvider` üzerinden paylaşılır; `content://` URI’ler de
  `<input type="file">` ile uyumludur.
- **Paylaşım/dış linkler:** sunucu dışı bağlantılar uygulama dışında açılır;
  `text/plain` paylaşım intent’i desteklenir.
- **Splash:** koyu zemin üzerinde TurkChan monogramı, tema arka planıyla birebir aynı.
- **Oturum:** çerezler `onPause` anında diske yazılır, uygulama kill edilse bile
  giriş korunur. Üçüncü taraf çerezler kapalı (site tek origin’de çalışır).

## Lisans

[MIT](LICENSE)
