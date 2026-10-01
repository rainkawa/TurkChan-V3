/**
 * Tek seferlik doğrulama: yapılandırılmış anahtarla Groq ucuna tek bir
 * sohbet tamamlama isteği atar. AI metin motorunun gerçekten bağlı
 * olduğunu kanıtlamak içindir — kalıcı kod değil, `node scripts/check-groq.mjs`.
 *
 * Anahtarı konsola YAZDIRMAZ.
 */
const baseUrl = process.env.AI_LLM_BASE_URL ?? 'https://api.groq.com/openai/v1'
const model = process.env.AI_LLM_MODEL ?? 'llama-3.3-70b-versatile'
const key = process.env.AI_LLM_API_KEY ?? process.env.GROQ_API_KEY

if (!key) {
  console.error('Anahtar yok: GROQ_API_KEY veya AI_LLM_API_KEY ayarlanmamış.')
  process.exit(1)
}

const response = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model,
    messages: [
      { role: 'system', content: 'Sen TurkChan adlı topluluk sitesinde Türkçe yazan bir kullanıcısın.' },
      { role: 'user', content: 'Yazılım öğrenmek için nereden başlamalıyım?' },
    ],
    max_tokens: 120,
  }),
})

console.log('uç nokta:', baseUrl)
console.log('model  :', model)
console.log('HTTP   :', response.status)

const data = await response.json()
const text = data.choices?.[0]?.message?.content
if (typeof text === 'string' && text.trim() !== '') {
  console.log('yanıt  :', text.trim())
} else {
  console.error('hata   :', JSON.stringify(data.error ?? data).slice(0, 400))
  process.exit(1)
}
