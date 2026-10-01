/**
 * Tek seferlik doğrulama: yapılandırılmış anahtarla sağlayıcının model
 * listesini çeker. `AI_LLM_MODEL` değerini doğrulamak içindir.
 *
 * Anahtarı konsola YAZDIRMAZ.
 */
const baseUrl = process.env.AI_LLM_BASE_URL ?? 'https://api.groq.com/openai/v1'
const key = process.env.AI_LLM_API_KEY ?? process.env.GROQ_API_KEY

if (!key) {
  console.error('Anahtar yok: GROQ_API_KEY veya AI_LLM_API_KEY ayarlanmamış.')
  process.exit(1)
}

const response = await fetch(`${baseUrl}/models`, {
  headers: { Authorization: `Bearer ${key}` },
})
console.log('HTTP:', response.status)
const data = await response.json()
const ids = (data.data ?? []).map((m) => m.id).sort()
console.log(ids.join('\n'))
