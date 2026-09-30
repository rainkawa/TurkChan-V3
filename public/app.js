// Progressive enhancement: voting, markdown preview, drafts. No frameworks.
(function () {
  'use strict'

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
      headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
})()
