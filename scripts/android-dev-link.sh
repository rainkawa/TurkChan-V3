#!/usr/bin/env bash
#
# TurkChan Android — yerel geliştirme bağlantısı
#
# Telefonda `http://localhost:3000` adresi TELEFONUN KENDİSİNİ gösterir,
# bilgisayarınızı değil. Bu betik, telefonun 3000 portunu bilgisayarınızın
# 3000 portuna yönlendirir (adb reverse). Böylece APK'daki localhost adresi
# doğrudan geliştirme sunucunuza gider.
#
# Kullanım:
#   sh ./scripts/android-dev-link.sh            # yönlendirmeyi kur
#   sh ./scripts/android-dev-link.sh --status   # durumu göster
#   sh ./scripts/android-dev-link.sh --remove   # yönlendirmeyi kaldır
#
# Ön koşul: USB kablosu ile bağlı cihazda "USB debugging" açık olmalı.
# Kablosuz da çalışır (adb pair / adb connect sonrası).

set -euo pipefail

PORT="${PORT:-3000}"
ACTION="${1:-setup}"

if ! command -v adb >/dev/null 2>&1; then
  echo "HATA: 'adb' bulunamadı." >&2
  echo "Android SDK platform-tools kurulu olmalı ya da PATH'e eklenmeli." >&2
  exit 1
fi

if ! adb start-server >/dev/null 2>&1; then
  echo "HATA: adb sunucusu başlatılamadı." >&2
  exit 1
fi

# Bağlı cihaz var mı?
DEVICE_COUNT="$(adb devices | awk 'NR>1 && $2=="device" {count++} END {print count+0}')"
if [ "$DEVICE_COUNT" -eq 0 ]; then
  echo "HATA: bağlı Android cihaz bulunamadı." >&2
  echo "  - Telefonu USB ile bağlayın" >&2
  echo "  - Geliştirici seçeneklerinde USB debugging'i açın" >&2
  echo "  - 'adb devices' ile doğrulayın" >&2
  exit 1
fi

case "$ACTION" in
  --status|status)
    echo "Mevcut yönlendirmeler:"
    adb reverse --list
    ;;
  --remove|remove)
    adb reverse --remove "tcp:$PORT" 2>/dev/null || true
    echo "tcp:$PORT yönlendirmesi kaldırıldı."
    ;;
  *)
    # Sunucu gerçekten ayakta mı? Yönlendirme kurmadan önce doğrula.
    if command -v curl >/dev/null 2>&1; then
      if curl -sS -m 5 -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
        echo "Yerel sunucu http://127.0.0.1:$PORT yanıt veriyor."
      else
        echo "UYARI: http://127.0.0.1:$PORT yanıt vermiyor." >&2
        echo "Önce 'npm run dev' ile sunucuyu başlatın." >&2
      fi
    fi

    adb reverse "tcp:$PORT" "tcp:$PORT"
    echo "Kuruldu: telefon tcp:$PORT  ->  bilgisayar tcp:$PORT"
    echo
    echo "Artık APK'yı şu parametreyle derleyebilirsiniz:"
    echo "  ./gradlew :app:assembleRelease -PserverUrl=http://localhost:$PORT"
    echo
    echo "Doğrulama:"
    echo "  adb reverse --list"
    echo "  adb shell curl -s http://127.0.0.1:$PORT/ | head -c 200"
    ;;
esac
