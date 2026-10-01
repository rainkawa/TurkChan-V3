# TurkChan — Türkiye’nin topluluk platformu

**Sürüm 2.2.0 — “NPC Simulation”**

Kendi kendine barındırılabilen bir topluluk tartışma platformu — STK programları, gençlik kuruluşları, camiler ve medreseler için. Kullanıcıların oluşturduğu topluluklar, iç içe tartışmalar ve görünürlüğü belirleyen topluluk oylaması; yüzlerce ile birkaç bin kullanıcı ölçeğinde ve bu tür kuruluşların ilk günden ihtiyaç duyduğu moderasyon katmanıyla.

Built as a single deployable monolith: one process, one database file, no external services required to run it.

```
TypeScript · Hono (SSR JSX) · SQLite (node:sqlite, FTS5) · Argon2id · 510 tests · harici servis yok
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

**NPC karakterler (2.2.0)**
- **API'SİZ, tamamen yerel çalışır.** Önceki Groq/LLM entegrasyonu, tüm API istemcileri, anahtar değişkenleri, model listeleme komutları ve araştırma modülü **tamamen kaldırıldı**. Sistem artık hiçbir LLM, ücretli API veya internet bağımlılığı taşımaz; bütün davranış TypeScript + SQLite içinde hesaplanır.
- **50 benzersiz NPC karakteri** (`src/services/npc/personas.ts`): her biri kalıcı profille gelir — kullanıcı adı, görünen ad, avatar, arketip, profil metni, kendine özgü söz kalıbı (tic), ilgi alanları, sevdiği/sevmediği konu türleri, tercih ettiği boardlar ve **20 davranış ekseni** (aktivite, yazı uzunluğu, mizah, tartışmacılık, nezaket, merak, ciddiyet, konuşkanlık, sabır, empati, şüphecilik, özgüven, argo, küfür, emoji, yorum/konu/vote eğilimi, yukarı-aşağı oy eğilimi). Bu sayılar açıklama metni değil, **doğrudan karar girdisidir**.
- **Yerel bağlam analizi** (`lexicon.ts` + `analyze.ts`): Türkçe ek soyutlama (`stem`) ve 16 kavram ailesi (oyun, yazılım, teknoloji, siber, müzik, spor, yemek, eğitim, bilim, ekonomi, siyaset, sağlık, sinema, tarih, hobi, elektronik) üzerinden konu, özne, anahtar kelimeler, duygu (olumlu/olumsuz/nötr) ve niyet (kahkaha, selamlaşma, soru, şikâyet, yardım isteği, haber, deneyim, övgü, alay, konu değişimi…) çıkarılır. **Tek kelime tek başına konu kanıtı sayılmaz** — “telefon” tek başına konu belirlemez, “telefonum çok yavaşladı” belirler.
- **Yedi soruluk karar döngüsü** (`engine.ts`): NPC her gönderiyi okur, anlar ve şu yedi soruya cevap verir — konu ilgi alanımda mı, board tercihimde mi, daha önce gördüm mü, bu kullanıcıyla etkileşimim var mı, deneyimlerimle ilişkili mi, bana uygun mu, yeni konu için bağlam var mı? Her gönderiye cevap vermez; ilgi alanıyla örtüşmeyen gönderiye **yorum yazmaz**.
- **Kalite kapısı** (`quality.ts`): üretilen metin beş skorla değerlendirilir — `contextScore`, `personalityScore`, `repetitionScore`, `coherenceScore`, `topicScore`. Eşiğin altındaysa mesaj **yayınlanmaz** ve yeni bir aday denenir (en fazla 5 deneme); kaynak metnin tek bir köküne bile değinmeyen cümle reddedilir. “HAHAHA bu çok komik 😂” yazıldığında sistem futbol/teknoloji cevabı üretmez — **hiç yazmaz**.
- **Kalıcı hafıza** (`memory.ts`): `npc_memory` kavram/kişi/board/ifade kayıtları (ağırlık + hit + olumlu/olumsuz sayaç), `npc_episodes` önemli olay özetleri, `npc_phrases` kullanılan ifadeler. Hafıza sınırsız büyümez: 120 kayıtta budanır.
- **Davranış öğrenmesi** (`learning.ts`): her yorum/gönderi bir “deneme” olarak kaydedilir, sonraki turlarda ölçülür (alınan oy, gelen cevap) ve davranış ağırlıkları EMA ile **kademeli** kayar (adım ≤ 0.05, ağırlıklar 0.2–2.0). Kişilik birkaç çalıştırmada çökmez.
- **Beş eksenli ilişki** (`relationships.ts`): friendship, respect, trust, dislike, rivalry (+ türetilmiş affinity). Karakter bir kişiye karşı katılıyorsa dostluk, karşı görüyorsa rekabet artar; bu ilişki sonraki cevaplarda tutumu değiştirir.
- **Kontrollü vote**: oy kararı konu ilgisine, karakterin oy eğilimine, içerik duygusuna, şüpheciliğe ve yazar ilişkisine göre hesaplanır; kontrollü rastgelelikle karar verilir.
- **Aktivite seviyeleri ve tek scheduler**: 50 ayrı süreç **yoktur**. Tek `runNpcTick` döngüsü aktivite seviyesine göre NPC seçer (çok aktif → 30 sn, çok seyrek → 30 dk bekleme), onları kontrollü batch'lerde sırayla çalıştırır ve indeksli sorgular kullanır.
- **Zaman döngüsü**: READ → UNDERSTAND → DECIDE → ACT → OBSERVE → UPDATE MEMORY → UPDATE RELATIONSHIP → UPDATE BEHAVIOR. Her tur kalıcı state güncellenir.
- **Güvenlik**: NPC hesapları `users.is_ai = 1` ile ayırt edilir, **oturum açamazlar** ve admin olamazlar; motor mevcut kullanıcı servislerini çağırdığı için rate limit, spam koruması, yetki ve CSRF korumalarını **bypass etmez**.
- **Yönetim paneli** (`/admin?tab=npc`): NPC listesi, aktif/pasif, 20 eksenli profil düzenleme, ilgi alanları ve board tercihleri, **board erişimi** (varsayılan: **tüm boardlar** — sonradan oluşturulanlar da dahil), **“Şimdi bir tur çalıştır”**, davranışı sıfırlama, **hafızayı görüntüleme / sıfırlama**, oluşturduğu içerikler ve denetim izi.
- **Denetim betiği**: `npm run npc:sim` sıfırdan bir dünya kurar ve 20 gönderi analizi, 30 yorum denemesi, 20 vote kararı ve 10 konu üretimini ekrana basarak çıktıları insan gözüyle denetlemeye açar.

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
npm run seed     # demo communities + accounts (see below)
npm run seed:npc # 50 NPC karakter (idempotent, tekrar çalıştırmak güvenli)
npm run npc:sim   # canlı NPC simülasyon denetimi (20 post / 30 yorum / 20 vote / 10 konu)
npm run dev      # → http://localhost:3000
```

İlk **kayıt olan kullanıcı site yöneticisi olur**. Seed ile gelen demo hesaplar:

| Hesap | Parola | Rol |
|---|---|---|
| `admin` | `seed-admin-pass-1` | Site yöneticisi |
| `ustazah_f` | `seed-mod-pass-1` | Topluluk moderatörü |
| `aisyah`, `rahim`, `nurul` | `seed-user-pass-{1,2,3}` | Üyeler |

```bash
npm test           # 510 tests: unit + full HTTP integration
npm run typecheck  # strict TypeScript, no emit
```

> **Önemli:** NPC karakterleri ilk kullanıcıdan sonra oluşturulmalı — ilk kayıt olan kullanıcı site yöneticisi olur. Bu yüzden `npm run seed:npc` komutunu **ilk kayıttan sonra** çalıştırın.
>
> Karakterler varsayılan olarak **tüm boardlarda** paylaşır (herkese açık, kısıtlı ve gizli; sonradan oluşturulan boardlar da dahil). Gizli boardlarda otomatik onaylı üye olurlar. Erişimi daraltmak isterseniz **Admin → NPC Karakterler → Board erişimi** ayarını kullanın. Motor 5 dakikada bir tur çalışır; beklemeden test etmek için aynı ekrandaki **“Şimdi bir tur çalıştır”** düğmesini kullanın.

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
│   └── npc/           # NPC simülasyonu: lexicon + analyze (bağlam),
│                      #   personas (50 karakter), memory, relationships,
│                      #   learning (davranış ağırlıkları), quality (kapı),
│                      #   compose (metin), engine (tek scheduler)
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

510 tests across 37 files, all runnable offline in ~4 s:

- **Unit** — hot/Wilson ranking math, Markdown XSS safety, sliding-window rate limiter, cursor codec, JPEG/PNG/WebP metadata stripping, SSRF address classification
- **Integration (through the real HTTP app)** — registration/login/lockout/reset/deletion, membership approval flows, all three post types (including multipart image upload with EXIF verification), comment nesting and depth-cap flattening, vote idempotency and flips, feed ordering and cursor stability, reporting/auto-hide/removal/bans/pins/mod-log, admin suspension/archival/purge/exports/invites, search visibility, notifications and withdrawal
- **Hardening** — CSRF origin rejection, open-redirect guard, malformed cursor/sort resilience, archived-community lockdown, private-community zero-leakage checks
- **NPC karakterler** (64 test) — 50 benzersiz hesap, persona ayrışması, Türkçe kök/ek soyutlaması, konu ve bağlam analizi, uygun konu/yorum seçimi, **anlamsız yorum engelleme** (“HAHAHA bu çok komik” → futbol cevabı üretilmez), **konu dışı cevap engelleme** (“Telefonum çok yavaşladı” → oyun cevabı üretilmez), tekrar engelleme, hafıza + hafıza güncellemesi, ilişki güncellemesi, davranış adaptasyonu, vote davranışı, tek scheduler, aktivite seviyeleri, yetki izolasyonu ve **API'siz çalışma**

## Yapılandırma

| Ayar | Nerede |
|---|---|
| `PORT`, `DB_PATH`, `UPLOAD_DIR`, `BASE_URL` | environment variables |
| `NPC_ENABLED=0` (eski adı: `AI_ENABLED=0`) | NPC simülasyon motorunu tamamen kapatır |
| `NPC_TICK_MINUTES` | Motor tur süresi (varsayılan 5 dakika) |
| `NPC_MAX_ACTIONS` | Tur başına en fazla işlem (varsayılan 12) — tek scheduler'ın yük sınırı |
| `NPC_POSTS_SCANNED` | NPC başına turda okunacak gönderi sayısı (varsayılan 40) |
| `npm run seed:npc` / `npm run npc:sim` | 50 NPC oluşturur / canlı simülasyon denetimi |
| ~~`GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `AI_LLM_*`, `AI_SEARCH_*`, `EXA_API_KEY`~~ | **Kaldırıldı.** Artık hiçbir API anahtarı veya harici model kullanılmaz |
| Registration mode, community-creation policy | Admin → Settings (live) |
| Hot decay constant, all rate limits | Admin → Settings (live) |
| Auto-hide threshold, hidden comment scores | per-community settings (moderators) |
| NPC board erişimi (varsayılan `all`; public / restricted / private / all) | Admin → NPC Karakterler |

## Üretim notları

- Run behind **Caddy** (or any TLS-terminating proxy); set `NODE_ENV=production` to enable `Secure` cookies.
- Implement the `Mailer` interface (`src/lib/mailer.ts`) with a real provider (Resend/Postmark/SES) for password resets.
- Swap `LocalObjectStorage` for an S3-compatible implementation of the `ObjectStorage` interface and serve images via CDN.
- Back up nightly (`sqlite3 data/app.db ".backup ..."`) to off-server encrypted storage, and test restores. Or host the schema on PostgreSQL — it ports cleanly.
- Single-node by design: availability strategy is fast redeploy + backups, not HA.

## Lisans

[MIT](LICENSE)
