// Progressive enhancement: voting, markdown preview, drafts. No frameworks.
(function () {
  'use strict'

  // JS açıksa gizli yedek formlar gizlenir; JS yoksa menüler açılmadan da
  // tüm eylemler (arşivle / sil / yanıtla) çalışır.
  document.documentElement.setAttribute('data-js', '1')

  // --- CSRF jetonu ---
  // Sunucu jetonu sayfaya hem her forma gizli alan olarak hem de meta etiketi
  // olarak gömer. Jetonu okumak bir doğrulama DEĞİLDİR: her durum değiştiren
  // istek sunucu tarafında ayrıca karşılaştırılır. Buradaki tek görev, fetch()
  // ile giden isteklere başlığı eklemektir.
  var csrfMeta = document.querySelector('meta[name="csrf-token"]')
  var csrfValue = csrfMeta ? csrfMeta.getAttribute('content') : ''

  function csrfToken() {
    return csrfValue || ''
  }

  // --- Voting (optimistic UI, server-acknowledged; US-022) ---
  document.addEventListener('click', function (event) {
    var btn = event.target.closest('.vote-btn')
    if (!btn) return
    event.preventDefault()
    if (btn.disabled) return

    var rail = btn.closest('.vote-rail')
    if (rail.dataset.guest === '1') {
      window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname)
      return
    }
    var current = parseInt(rail.dataset.myVote || '0', 10)
    var requested = parseInt(btn.dataset.value, 10)
    var next = current === requested ? 0 : requested

    var scoreEl = rail.querySelector('.vote-score')
    var oldScore = parseInt(scoreEl.dataset.score, 10)
    var optimistic = oldScore + (next - current)
    applyVoteState(rail, next, optimistic)

    fetch('/api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
      body: JSON.stringify({
        targetType: rail.dataset.targetType,
        targetId: rail.dataset.targetId,
        value: next,
      }),
    })
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname)
          return null
        }
        if (!res.ok) return res.json().then(function (data) { throw new Error(data.error || 'Oyun kaydedilemedi') })
        return res.json()
      })
      .then(function (data) {
        if (data) applyVoteState(rail, data.myVote, data.score)
      })
      .catch(function (err) {
        applyVoteState(rail, current, oldScore)
        showToast(err.message)
      })
  })

  function applyVoteState(rail, myVote, score) {
    rail.dataset.myVote = String(myVote)
    var scoreEl = rail.querySelector('.vote-score')
    scoreEl.dataset.score = String(score)
    if (scoreEl.dataset.hidden !== '1') scoreEl.textContent = String(score)
    rail.querySelectorAll('.vote-btn').forEach(function (b) {
      b.dataset.active = parseInt(b.dataset.value, 10) === myVote ? '1' : '0'
    })
  }

  function showToast(message) {
    var toast = document.createElement('div')
    toast.className = 'flash error'
    toast.style.cssText = 'position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);z-index:99;max-width:90vw'
    toast.textContent = message
    document.body.appendChild(toast)
    setTimeout(function () { toast.remove() }, 4000)
  }

  // --- Markdown preview ---
  document.querySelectorAll('[data-md-preview]').forEach(function (button) {
    button.addEventListener('click', function () {
      var textarea = document.getElementById(button.dataset.mdPreview)
      var target = document.getElementById(button.dataset.mdTarget)
      if (!textarea || !target) return
      fetch('/api/markdown-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify({ text: textarea.value }),
      })
        .then(function (res) { return res.json() })
        .then(function (data) {
          target.innerHTML = data.html
          target.style.display = 'block'
        })
    })
  })

  // --- Draft preservation in localStorage (US: posting form) ---
  document.querySelectorAll('form[data-draft-key]').forEach(function (form) {
    var key = 'draft:' + form.dataset.draftKey
    var fields = form.querySelectorAll('input[name="title"], textarea[name="body"], input[name="url"]')
    try {
      var saved = JSON.parse(localStorage.getItem(key) || '{}')
      fields.forEach(function (f) { if (!f.value && saved[f.name]) f.value = saved[f.name] })
    } catch (e) { /* ignore */ }
    fields.forEach(function (f) {
      f.addEventListener('input', function () {
        var data = {}
        fields.forEach(function (g) { data[g.name] = g.value })
        try { localStorage.setItem(key, JSON.stringify(data)) } catch (e) { /* ignore */ }
      })
    })
    form.addEventListener('submit', function () {
      try { localStorage.removeItem(key) } catch (e) { /* ignore */ }
    })
  })

  // --- Confirm dialogs ---
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault()
    })
  })

  // --- Side drawer (hamburger) ---
  var drawer = document.querySelector('[data-drawer]')
  var drawerToggle = document.querySelector('[data-drawer-toggle]')
  if (drawer && drawerToggle) {
    var openDrawer = function (open) {
      drawer.hidden = !open
      drawerToggle.setAttribute('aria-expanded', open ? 'true' : 'false')
      document.body.style.overflow = open ? 'hidden' : ''
    }
    drawerToggle.addEventListener('click', function () { openDrawer(drawer.hidden) })
    drawer.querySelectorAll('[data-drawer-close]').forEach(function (el) {
      el.addEventListener('click', function () { openDrawer(false) })
    })
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !drawer.hidden) openDrawer(false)
    })
  }

  // --- Share: native sheet, clipboard fallback, then a toast ---
  function absoluteUrl(href) {
    return new URL(href, window.location.origin).toString()
  }
  document.querySelectorAll('[data-share]').forEach(function (el) {
    el.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      var url = absoluteUrl(el.dataset.share)
      var done = function () { showToast('Bağlantı kopyalandı.') }
      if (navigator.share) {
        navigator.share({ title: document.title, url: url }).then(done, function () {
          if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, function () {})
          else done()
        })
        return
      }
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, function () {})
      else done()
      // Paylaş panelinin açık kalmasını engelle.
      var menu = el.closest('details')
      if (menu) menu.removeAttribute('open')
    })
  })

  // --- Post ID kopyalama (permalink) ---
  document.querySelectorAll('[data-copy]').forEach(function (el) {
    el.addEventListener('click', function (event) {
      event.preventDefault()
      var text = el.dataset.copy
      var done = function () {
        var label = el.dataset.copiedLabel
        if (!label) return
        var original = el.textContent
        el.textContent = label
        setTimeout(function () { el.textContent = original }, 1400)
      }
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done)
      else done()
    })
  })

  // --- Saved posts (this device only; no server table exists) ---
  var SAVED_KEY = 'turkchan:saved'
  function readSaved() {
    try {
      var raw = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]')
      return Array.isArray(raw) ? raw : []
    } catch (e) { return [] }
  }
  function writeSaved(list) {
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)) } catch (e) { /* kota dolu */ }
  }
  function syncSaveButtons() {
    var ids = readSaved().map(function (item) { return item.id })
    document.querySelectorAll('[data-save-post]').forEach(function (btn) {
      var on = ids.indexOf(btn.dataset.savePost) !== -1
      btn.classList.toggle('is-saved', on)
      var label = btn.querySelector('[data-save-label]')
      if (label) label.textContent = on ? 'Kaydedildi' : 'Kaydet'
    })
  }
  document.addEventListener('click', function (event) {
    var btn = event.target.closest('[data-save-post]')
    if (!btn) return
    event.preventDefault()
    var id = btn.dataset.savePost
    var list = readSaved()
    var index = -1
    for (var i = 0; i < list.length; i += 1) if (list[i].id === id) { index = i; break }
    if (index === -1) {
      list.unshift({
        id: id,
        title: btn.dataset.saveTitle || '',
        href: btn.dataset.saveHref || '',
        community: btn.dataset.saveCommunity || '',
        at: Date.now(),
      })
      showToast('Kaydedildi.')
    } else {
      list.splice(index, 1)
      showToast('Kayıt kaldırıldı.')
    }
    writeSaved(list.slice(0, 50))
    syncSaveButtons()
    var menu = btn.closest('details')
    if (menu) menu.removeAttribute('open')
  })
  syncSaveButtons()

  // --- Saved tab: render the locally stored list ---
  var savedList = document.querySelector('[data-saved-list]')
  if (savedList) {
    var items = readSaved()
    if (items.length > 0) {
      savedList.innerHTML = ''
      items.forEach(function (item) {
        var a = document.createElement('a')
        a.className = 'profile-saved-item'
        a.href = item.href || '#'
        a.textContent = item.title || '(başlıksız)'
        if (item.community) {
          var small = document.createElement('small')
          small.textContent = 'c/' + item.community
          a.appendChild(small)
        }
        savedList.appendChild(a)
      })
    }
  }

  // --- Rank badge images: graceful fallback when an asset is missing ---
  // Kırık resim ikonu yerine metin rozeti gösterilir; görsel yüklendiyse
  // hiçbir şey yapılmaz.
  document.addEventListener(
    'error',
    function (event) {
      var img = event.target
      if (!img || img.tagName !== 'IMG' || !img.classList.contains('rank-img')) return
      var wrap = img.closest('.rank-badge-img')
      if (wrap) wrap.classList.add('rank-img-missing')
    },
    true,
  )
  // Uyarı: `error` olayı yakalanmadan önce tetiklenmiş olabilir (önbellekten
  // gelen kırık görsel), bu yüzden tamamlanmış görselleri bir kez kontrol et.
  document.querySelectorAll('img.rank-img').forEach(function (img) {
    if (img.complete && img.naturalWidth === 0) {
      var wrap = img.closest('.rank-badge-img')
      if (wrap) wrap.classList.add('rank-img-missing')
    }
  })

  /* ======================================================================
     Akış: sonsuz kaydırma, aşağı çekerek yenileme, spoiler
     ====================================================================== */

  // --- Spoiler: içerik "Göster" düğmesine kadar gizli ---
  document.addEventListener('click', function (event) {
    var toggle = event.target.closest('[data-spoiler-toggle]')
    if (!toggle) return
    var wrap = toggle.closest('[data-spoiler]')
    if (!wrap) return
    var body = wrap.querySelector('.spoiler-body')
    if (!body) return
    var revealed = toggle.getAttribute('aria-expanded') === 'true'
    toggle.setAttribute('aria-expanded', revealed ? 'false' : 'true')
    body.hidden = revealed
    wrap.classList.toggle('is-revealed', !revealed)
    var cta = toggle.querySelector('.spoiler-cta')
    if (cta) cta.textContent = revealed ? 'Göster' : 'Gizle'
  })

  // --- Sonsuz kaydırma ---
  var feed = document.querySelector('[data-feed]')
  if (feed) {
    var status = document.querySelector('[data-feed-status]')
    var nextCursor = feed.dataset.nextCursor || ''
    var feedUrl = feed.dataset.feedUrl || window.location.pathname + window.location.search
    var loading = false

    function feedStatus(message) {
      if (!status) return
      var text = status.querySelector('.feed-status-text')
      if (text) text.textContent = message
    }

    function loadMore() {
      if (loading || !nextCursor) return
      loading = true
      feedStatus('Yükleniyor…')
      var sep = feedUrl.indexOf('?') === -1 ? '?' : '&'
      var url = feedUrl + sep + 'partial=1&after=' + encodeURIComponent(nextCursor)
      fetch(url, { headers: { Accept: 'text/html' } })
        .then(function (res) { return res.ok ? res.text() : Promise.reject(new Error('yüklenemedi')) })
        .then(function (html) {
          var holder = document.createElement('div')
          holder.innerHTML = html
          var page = holder.querySelector('[data-feed-page]')
          if (!page) return
          var cards = page.children
          if (cards.length === 0) return
          var fragment = document.createDocumentFragment()
          while (page.firstChild) fragment.appendChild(page.firstChild)
          feed.appendChild(fragment)
          nextCursor = page.dataset.nextCursor || ''
          feed.dataset.nextCursor = nextCursor
          if (!nextCursor) {
            feedStatus('Hepsi bu kadar.')
            if (status) status.classList.add('is-done')
          }
        })
        .catch(function () { feedStatus('Yüklenemedi. Tekrar denemek için kaydırın.') })
        .then(function () { loading = false })
    }

    if ('IntersectionObserver' in window && status) {
      var sentinel = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) loadMore()
      }, { rootMargin: '600px 0px' })
      sentinel.observe(status)
    } else {
      // Observer yoksa "daha fazla" bağlantısı çalışmaya devam eder.
      window.addEventListener('scroll', function () {
        if (nextCursor && window.innerHeight + window.scrollY >= document.body.scrollHeight - 800) loadMore()
      })
    }
  }

  // --- Aşağı çekerek yenileme (pull to refresh) ---
  (function pullToRefresh() {
    if (!document.body || !window.fetch) return
    var THRESHOLD = 72
    var startY = 0
    var pulling = false
    var indicator = document.createElement('div')
    indicator.className = 'pull-indicator'
    indicator.setAttribute('aria-hidden', 'true')
    indicator.innerHTML = '<span class="pull-spinner"></span>'
    document.body.appendChild(indicator)

    function atTop() {
      return window.scrollY <= 0
    }

    document.addEventListener('touchstart', function (event) {
      if (!atTop() || event.touches.length !== 1) return
      startY = event.touches[0].clientY
      pulling = true
    }, { passive: true })

    document.addEventListener('touchmove', function (event) {
      if (!pulling || event.touches.length !== 1) return
      var dy = event.touches[0].clientY - startY
      if (dy <= 0) {
        indicator.style.transform = 'translateY(-100%)'
        return
      }
      var shift = Math.min(90, dy * 0.5)
      indicator.style.transform = 'translateY(' + (shift - 40) + 'px)'
      indicator.classList.toggle('is-ready', dy >= THRESHOLD)
    }, { passive: true })

    document.addEventListener('touchend', function () {
      if (!pulling) return
      var ready = indicator.classList.contains('is-ready')
      pulling = false
      if (ready) {
        indicator.classList.add('is-loading')
        window.location.reload()
        return
      }
      indicator.classList.remove('is-ready', 'is-loading')
      indicator.style.transform = 'translateY(-100%)'
    }, { passive: true })
  })()

  // --- Close open overflow menus on outside tap ---
  document.addEventListener('click', function (event) {
    document.querySelectorAll('details.overflow-menu[open]').forEach(function (menu) {
      if (!menu.contains(event.target)) menu.removeAttribute('open')
    })
  })

  /* ======================================================================
     Özel mesajlaşma (DM)
     - Uzun basma → işlem menüsü (arşivle / sil / yanıtla / beğen / şikayet)
     - Sola kaydırma → yanıtlama
     - Çift dokunma → beğeni
     - Yoklama → yeni mesaj, okundu, çevrimiçi ve "yazıyor"
     Her etkileşimin JS'siz çalışan bir form karşılığı vardır.
     ====================================================================== */
  var dmPage = document.querySelector('[data-dm-page]')
  var dmChat = document.querySelector('[data-dm-chat]')

  function closeDmMenus(except) {
    document.querySelectorAll('[data-dm-menu]').forEach(function (menu) {
      if (menu === except) return
      menu.hidden = true
      var fallback = menu.parentElement.querySelector('[data-dm-fallback]')
      if (fallback) fallback.hidden = true
    })
  }

  function openDmMenu(row) {
    var menu = row.querySelector('[data-dm-menu]')
    if (!menu) return false
    closeDmMenus(menu)
    menu.hidden = false
    var fallback = row.querySelector('[data-dm-fallback]')
    if (fallback) fallback.hidden = false
    return true
  }

  // Uzun basma (basılı tutma) menüsü
  var LONG_PRESS_MS = 450
  var pressTimer = null
  var pressMoved = false
  // Menü açıldıktan sonra parmak kalkınca tarayıcı bir "click" üretir; bu
  // menüyü hemen kapatırdı. O tıklamayı yutuyoruz.
  var swallowClick = false

  function startPress(row) {
    pressMoved = false
    clearTimeout(pressTimer)
    pressTimer = setTimeout(function () {
      if (pressMoved) return
      if (openDmMenu(row)) {
        swallowClick = true
        // Tarayıcı bir tıklama üretmezse bayrak takılı kalmasın.
        setTimeout(function () { swallowClick = false }, 700)
        if (navigator.vibrate) navigator.vibrate(12)
      }
    }, LONG_PRESS_MS)
  }
  function cancelPress() {
    clearTimeout(pressTimer)
    pressTimer = null
  }

  document.addEventListener('touchstart', function (event) {
    var row = event.target.closest('.dm-row, .dm-bubble-row')
    if (!row) return
    pressMoved = false
    startPress(row)
  }, { passive: true })

  document.addEventListener('touchmove', function () { pressMoved = true; cancelPress() }, { passive: true })
  document.addEventListener('touchend', cancelPress, { passive: true })
  document.addEventListener('touchcancel', cancelPress, { passive: true })

  document.addEventListener('mousedown', function (event) {
    if (event.button !== 0) return
    var row = event.target.closest('.dm-row, .dm-bubble-row')
    if (!row) return
    pressMoved = false
    startPress(row)
  })
  document.addEventListener('mouseup', cancelPress)
  document.addEventListener('mouseleave', cancelPress)
  document.addEventListener('mouseout', function (event) {
    if (event.relatedTarget) return
    cancelPress()
  })

  // Menü eylemleri
  document.addEventListener('click', function (event) {
    if (swallowClick) {
      // Uzun basmanın ardından gelen sentetik tıklama menüyü kapatmasın.
      swallowClick = false
      return
    }
    var item = event.target.closest('[data-dm-action]')
    if (!item) {
      if (!event.target.closest('[data-dm-menu]')) closeDmMenus(null)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    var action = item.dataset.dmAction
    var row = item.closest('.dm-row, .dm-bubble-row')
    var fallback = row ? row.querySelector('[data-dm-fallback]') : null
    var conversationId = dmChat ? dmChat.dataset.conversation : ''

    // Sohbet satırı eylemleri (arşivle / arşivden çıkar / sil)
    if (row && row.classList.contains('dm-row') && fallback) {
      var intent = action === 'delete-chat' ? 'delete' : action === 'unarchive' ? 'unarchive' : 'archive'
      var hidden = fallback.querySelector('input[name="intent"]')
      if (hidden) hidden.value = intent
      if (!confirmDm(intent)) return
      closeDmMenus(null)
      fallback.submit()
      return
    }

    // Mesaj eylemleri
    var messageId = row ? row.dataset.dmMessage : ''
    if (action === 'reply') {
      window.location.href = (window.location.pathname.split('?')[0]) + '?reply=' + encodeURIComponent(messageId)
      return
    }
    if (action === 'like') {
      likeMessage(row, messageId)
      closeDmMenus(null)
      return
    }
    if (action === 'report') {
      window.location.href = '/messages/report/' + encodeURIComponent(messageId)
      return
    }
    if (!fallback) return
    if (action === 'delete-everyone' || action === 'delete-self') {
      var mode = action === 'delete-everyone' ? 'delete-everyone' : 'delete-self'
      if (!confirmDm(mode)) return
      closeDmMenus(null)
      var intentInput = fallback.querySelector('input[name="intent"]')
      if (intentInput) intentInput.value = mode
      var back = fallback.querySelector('input[name="back"]')
      if (!back) {
        back = document.createElement('input')
        back.type = 'hidden'
        back.name = 'back'
        fallback.appendChild(back)
      }
      back.value = conversationId
      fallback.submit()
    }
  })

  function confirmDm(intent) {
    if (intent === 'delete' || intent === 'delete-everyone' || intent === 'delete-self') {
      return window.confirm('Bu işlemi yapmak istediğinize emin misiniz?')
    }
    return true
  }

  /* --- Beğeni (çift dokunma ve menü) --- */
  function likeMessage(row, messageId) {
    if (!row || !messageId) return
    fetch('/api/dm/like', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
      body: JSON.stringify({ messageId: messageId }),
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {} }).then(function (data) {
            throw new Error(data.error || 'Beğeni kaydedilemedi')
          })
        }
        return res.json()
      })
      .then(function (data) {
        var bubble = row.querySelector('.dm-bubble')
        if (bubble) {
          bubble.classList.remove('just-liked')
          void bubble.offsetWidth
          bubble.classList.add('just-liked')
        }
        var like = row.querySelector('[data-dm-like]')
        if (data.liked) {
          row.dataset.liked = '1'
          if (!like) {
            like = document.createElement('span')
            like.className = 'dm-bubble-like'
            like.setAttribute('data-dm-like', '')
            row.querySelector('.dm-bubble-body').appendChild(like)
          }
          like.textContent = '❤'
        } else {
          row.dataset.liked = '0'
          if (like) like.remove()
        }
      })
      .catch(function () { showToast('Beğeni kaydedilemedi.') })
  }

  // --- Soldan sağa kaydırarak yanıtlama ---
  var SWIPE_TRIGGER = 64
  document.addEventListener('touchstart', function (event) {
    var bubble = event.target.closest('.dm-bubble-row')
    if (!bubble) return
    var touch = event.touches[0]
    bubble._swipe = { x: touch.clientX, y: touch.clientY, active: false }
  }, { passive: true })

  document.addEventListener('touchmove', function (event) {
    var bubble = event.target.closest('.dm-bubble-row')
    if (!bubble || !bubble._swipe) return
    var touch = event.touches[0]
    var dx = touch.clientX - bubble._swipe.x
    var dy = touch.clientY - bubble._swipe.y
    if (!bubble._swipe.active) {
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy)) return
      bubble._swipe.active = true
      bubble.classList.add('swiping')
    }
    var shift = Math.max(-140, Math.min(0, dx))
    bubble.style.setProperty('--dm-swipe', Math.abs(shift) + 'px')
    bubble.style.setProperty('--dm-swipe-opacity', String(Math.min(1, Math.abs(shift) / SWIPE_TRIGGER)))
  }, { passive: true })

  document.addEventListener('touchend', function (event) {
    var bubble = event.target.closest('.dm-bubble-row')
    if (!bubble || !bubble._swipe) return
    var state = bubble._swipe
    bubble._swipe = null
    bubble.classList.remove('swiping')
    var shift = parseFloat(bubble.style.getPropertyValue('--dm-swipe')) || 0
    bubble.style.removeProperty('--dm-swipe')
    bubble.style.removeProperty('--dm-swipe-opacity')
    if (!state.active) return
    if (Math.abs(shift) >= SWIPE_TRIGGER) {
      var base = window.location.pathname.split('?')[0]
      window.location.href = base + '?reply=' + encodeURIComponent(bubble.dataset.dmMessage)
    }
  }, { passive: true })

  // --- Gelen kutusu: arama düğmesi ve bölüm katlama ---
  if (dmPage) {
    var searchToggle = dmPage.querySelector('[data-dm-search-toggle]')
    var searchForm = dmPage.querySelector('[data-dm-search]')
    if (searchToggle && searchForm) {
      searchToggle.addEventListener('click', function () {
        var open = searchForm.classList.toggle('is-open')
        searchToggle.setAttribute('aria-expanded', open ? 'true' : 'false')
        if (open) {
          var input = searchForm.querySelector('input')
          if (input) input.focus()
        }
      })
      if (searchForm.classList.contains('is-open')) {
        var first = searchForm.querySelector('input')
        if (first) first.focus()
      }
    }
    dmPage.querySelectorAll('[data-dm-toggle]').forEach(function (button) {
      button.addEventListener('click', function () {
        var section = button.closest('.dm-section')
        if (!section) return
        var collapsed = section.dataset.collapsed === 'true'
        section.dataset.collapsed = collapsed ? 'false' : 'true'
        button.setAttribute('aria-expanded', collapsed ? 'true' : 'false')
      })
    })
  }

  /* --- Sohbet: yazıyor göstergesi, çift dokunma, yoklama --- */
  if (dmChat) {
    var conversationId = dmChat.dataset.conversation
    var thread = dmChat.querySelector('[data-dm-thread]')
    var since = parseInt(thread ? thread.dataset.since || '0' : '0', 10) || 0
    var composer = dmChat.querySelector('[data-dm-composer]')
    var input = dmChat.querySelector('[data-dm-input]')
    var typingEl = dmChat.querySelector('[data-dm-typing]')
    var presenceEl = dmChat.querySelector('[data-dm-presence]')
    var typingTimer = null
    var typingSent = false
    var POLL_MS = 5000

    if (input) {
      input.addEventListener('input', function () {
        input.style.height = 'auto'
        input.style.height = Math.min(120, input.scrollHeight) + 'px'
        if (typingSent) return
        typingSent = true
        postJson('/api/dm/typing', { conversation: conversationId, typing: true })
      })
      input.addEventListener('keydown', function (event) {
        // Enter gönderir, Shift+Enter satır atlar.
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          if (composer) composer.submit()
        }
      })
    }

    // Yanıt kutusu
    var replyInput = dmChat.querySelector('[data-dm-reply-input]')
    var replyBar = dmChat.querySelector('[data-dm-reply-bar]')
    var cancelReply = dmChat.querySelector('[data-dm-cancel-reply]')
    if (cancelReply && replyInput) {
      cancelReply.addEventListener('click', function () {
        replyInput.value = ''
        if (replyBar) replyBar.remove()
        if (input) input.focus()
      })
    }

    function postJson(url, payload) {
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify(payload),
      }).catch(function () {})
    }

    // Çift dokunma: iki dokunuş aynı balonda ve kısa sürede yapılırsa beğenilir.
    // `touch-action: manipulation` CSS sayesinde tarayıcı çift dokunuşla
    // yakınlaştırmayı dener ve ikinci dokunuşu yutması engellenir.
    var lastTapAt = 0
    var lastTapId = ''
    var DOUBLE_TAP_MS = 400
    dmChat.addEventListener('touchend', function (event) {
      var row = event.target.closest('.dm-bubble-row')
      if (!row) return
      var now = Date.now()
      if (lastTapId === row.dataset.dmMessage && now - lastTapAt < DOUBLE_TAP_MS) {
        cancelPress()
        likeMessage(row, row.dataset.dmMessage)
        lastTapAt = 0
        lastTapId = ''
        return
      }
      lastTapAt = now
      lastTapId = row.dataset.dmMessage
    }, { passive: true })

    // Masaüstünde çift tıklama.
    dmChat.addEventListener('dblclick', function (event) {
      var row = event.target.closest('.dm-bubble-row')
      if (row) likeMessage(row, row.dataset.dmMessage)
    })

    function renderMessage(message) {
      var row = document.createElement('li')
      row.className = 'dm-bubble-row' + (message.mine ? ' is-mine' : '')
      row.dataset.dmMessage = message.id
      row.dataset.dmMine = message.mine ? '1' : '0'
      row.dataset.deleted = message.deleted ? '1' : '0'
      row.dataset.liked = message.liked ? '1' : '0'

      var body = document.createElement('div')
      body.className = 'dm-bubble-body'

      if (message.replyTo) {
        var quote = document.createElement('p')
        quote.className = 'dm-bubble-reply'
        var quoteText = document.createElement('span')
        quoteText.className = 'dm-bubble-reply-text'
        quoteText.textContent = message.replyTo.body
        quote.appendChild(quoteText)
        body.appendChild(quote)
      }

      var text = document.createElement('p')
      text.className = 'dm-bubble-text' + (message.deleted ? ' is-deleted' : '')
      text.textContent = message.deleted ? 'Silinmiş mesaj' : message.body
      body.appendChild(text)

      var meta = document.createElement('span')
      meta.className = 'dm-bubble-meta'
      var time = document.createElement('time')
      time.className = 'dm-bubble-time'
      time.textContent = formatClock(message.createdAt)
      meta.appendChild(time)
      if (message.mine && !message.deleted) {
        var read = document.createElement('span')
        read.className = 'dm-bubble-read' + (message.readByPeer ? ' is-read' : '')
        read.dataset.dmRead = message.readByPeer ? '1' : '0'
        meta.appendChild(read)
      }
      body.appendChild(meta)

      if (message.liked) {
        var like = document.createElement('span')
        like.className = 'dm-bubble-like'
        like.setAttribute('data-dm-like', '')
        like.textContent = '❤'
        body.appendChild(like)
      }

      var bubble = document.createElement('div')
      bubble.className = 'dm-bubble'
      bubble.appendChild(body)

      var menu = document.createElement('div')
      menu.className = 'dm-msg-menu'
      menu.setAttribute('data-dm-menu', '')
      menu.hidden = true
      menu.appendChild(menuItem('Yanıtla', 'reply'))
      menu.appendChild(menuItem('Beğen', 'like'))
      menu.appendChild(menuItem('Şikayet et', 'report'))
      if (message.mine) menu.appendChild(menuItem('Herkes için sil', 'delete-everyone', true))
      menu.appendChild(menuItem('Benden sil', 'delete-self', true))

      var fallback = document.createElement('form')
      fallback.method = 'post'
      fallback.action = '/messages/message/' + message.id
      fallback.className = 'dm-msg-fallback'
      fallback.setAttribute('data-dm-fallback', '')
      fallback.hidden = true
      var hidden = document.createElement('input')
      hidden.type = 'hidden'
      hidden.name = 'intent'
      hidden.value = 'delete-self'
      fallback.appendChild(hidden)

      row.appendChild(bubble)
      row.appendChild(menu)
      row.appendChild(fallback)
      return row
    }

    function menuItem(label, action, danger) {
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'dm-menu-item' + (danger ? ' danger' : '')
      button.dataset.dmAction = action
      button.textContent = label
      return button
    }

    function formatClock(ms) {
      var date = new Date(ms)
      return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
    }

    function poll() {
      var visible = document.visibilityState !== 'hidden'
      var url = '/api/dm/thread?conversation=' + encodeURIComponent(conversationId) +
        '&since=' + encodeURIComponent(String(since)) + (visible ? '&read=1' : '')
      fetch(url, { headers: { Accept: 'application/json' } })
        .then(function (res) { return res.ok ? res.json() : null })
        .then(function (data) {
          if (!data) return
          if (typingEl) {
            typingEl.classList.toggle('is-typing', !!data.typing)
            typingEl.hidden = !data.typing
          }
          if (presenceEl) presenceEl.classList.toggle('is-online', !!data.online)
          if (data.reads) {
            Object.keys(data.reads).forEach(function (id) {
              var read = document.querySelector('[data-dm-message="' + id + '"] .dm-bubble-read')
              if (read) {
                read.classList.toggle('is-read', !!data.reads[id])
                read.dataset.dmRead = data.reads[id] ? '1' : '0'
              }
            })
          }
          if (!thread || !data.messages || data.messages.length === 0) return
          var added = false
          data.messages.forEach(function (message) {
            if (message.createdAt < since) return
            if (document.querySelector('[data-dm-message="' + message.id + '"]')) return
            thread.appendChild(renderMessage(message))
            since = Math.max(since, message.createdAt)
            added = true
          })
          if (added) {
            thread.dataset.since = String(since)
            thread.scrollIntoView({ block: 'end' })
            if (typingSent) {
              postJson('/api/dm/typing', { conversation: conversationId, typing: false })
              typingSent = false
            }
          }
        })
        .catch(function () { /* ağ yoksa bir sonraki turda yeniden dener */ })
    }

    if (composer) {
      composer.addEventListener('submit', function () {
        clearTimeout(typingTimer)
        postJson('/api/dm/typing', { conversation: conversationId, typing: false })
        typingSent = false
      })
    }
    typingTimer = setInterval(function () {
      if (typingSent && input && input.value === '') {
        postJson('/api/dm/typing', { conversation: conversationId, typing: false })
        typingSent = false
      }
    }, 3000)

    poll()
    var pollTimer = setInterval(poll, POLL_MS)
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') poll()
    })
    window.addEventListener('pagehide', function () { clearInterval(pollTimer) })
  }
})()
