/**
 * Yönetim paneli — AI karakter sekmesi (görünüm katmanı).
 *
 * Bu dosya yalnızca GÖRÜNTÜ üretir; tüm veri işlemleri
 * `services/ai/*` katmanındadır. Böylece davranış mantığı arayüzden
 * ayrı kalır ve test edilebilir olur.
 *
 * Yetki: bu sekmeye giden rotalar `requireAdmin(viewer)` ile korunur —
 * AI yönetimi sadece site yöneticisine açıktır, moderatöre değil.
 */
import type { FC } from 'hono/jsx'
import type { Ctx } from '../context'
import type { AiAgentWithUser } from '../types'
import {
  aiActivityLogWithNames,
  aiAgentContent,
  boardPresence,
  parseList,
  parseRecord,
} from '../services/ai/agents'
import { aiBoardCoverage, type AiBoardAccess } from '../services/ai/activity'
import { llmAvailable } from '../services/ai/llm'
import { searchAvailable } from '../services/ai/research'
import { archetypeLabel } from '../services/ai/personas'

/** Board erişimi seçenekleri (etiket + değer). */
const ACCESS_OPTIONS: Array<{ value: AiBoardAccess; label: string }> = [
  { value: 'public', label: 'Yalnızca herkese açık boardlar' },
  { value: 'restricted', label: 'Kısıtlı boardlar' },
  { value: 'private', label: 'Gizli boardlar' },
  { value: 'all', label: 'Hepsi (herkese açık + kısıtlı + gizli)' },
]

/** 0.0–1.0 ölçeğini yüzde olarak gösterir. */
function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** Karakter profil formundaki davranış alanları. */
const SLIDERS = [
  { field: 'activity', label: 'Aktivite seviyesi', hint: 'Ne sıklıkla paylaşım yapar' },
  { field: 'verbosity', label: 'Yazı uzunluğu', hint: '0 = tek cümle, 1 = uzun açıklama' },
  { field: 'humor', label: 'Mizah seviyesi', hint: 'Espri ve troll yoğunluğu' },
  { field: 'assertiveness', label: 'Tartışmacılık', hint: 'Kavgaya girme eğilimi' },
  { field: 'politeness', label: 'Nezaket', hint: 'Nazik söyleyiş' },
  { field: 'comment_rate', label: 'Yorum eğilimi', hint: 'Yorum yazma sıklığı' },
  { field: 'post_rate', label: 'Gönderi eğilimi', hint: 'Konu açma sıklığı' },
  { field: 'upvote_bias', label: 'Yukarı oy eğilimi', hint: 'Beğenme yatkınlığı' },
  { field: 'downvote_bias', label: 'Aşağı oy eğilimi', hint: 'Olumsuz oy yatkınlığı' },
  { field: 'emoji_rate', label: 'Emoji kullanımı', hint: 'Emoji sıklığı' },
  { field: 'profanity', label: 'Küfür eğilimi', hint: 'Kaba dil kullanımı' },
] as const

/** Karakterin itibar durumunu etiketle. */
function reputationLabel(reputation: number): string {
  if (reputation >= 60) return 'Efsane'
  if (reputation >= 30) return 'Saygın'
  if (reputation >= 10) return 'Tanınan'
  if (reputation >= 0) return 'Sıradan'
  if (reputation >= -20) return 'Şüpheli'
  return 'İtibar düşük'
}

/** AI yönetim sekmesinin tamamı. */
export const AiTab: FC<{
  ctx: Ctx
  agents: AiAgentWithUser[]
  editId: string
  showContent: boolean
}> = ({ ctx, agents, editId, showContent }) => {
  const editing = editId ? agents.find((a) => a.user_id === editId) : undefined
  const enabled = agents.filter((a) => a.enabled === 1).length
  const totalPosts = agents.reduce((sum, a) => sum + a.posts_created, 0)
  const totalComments = agents.reduce((sum, a) => sum + a.comments_created, 0)
  const totalVotes = agents.reduce((sum, a) => sum + a.votes_cast, 0)
  const coverage = aiBoardCoverage(ctx)

  return (
    <div>
      <div class="card">
        <h2>AI Karakterler</h2>
        <p class="hint">
          Toplam {agents.length} karakter · {enabled} aktif · {agents.length - enabled} pasif —{' '}
          {totalPosts} gönderi, {totalComments} yorum, {totalVotes} oy.
        </p>
        <p class="hint">
          Karakterler <code>users</code> tablosunda <code>is_ai = 1</code> satırlarıdır ve oturum
          açamazlar. Davranış motoru mevcut kullanıcı servislerini çağırdığı için rate limit ve spam
          korumaları onlar için de aynen geçerlidir. Her işlem denetim günlüğüne yazılır.
        </p>
      </div>

      <div class="card">
        <h2>Metin motoru</h2>
        {llmAvailable(ctx) ? (
          <p class="hint">
            Karakterler <code>{ctx.config.aiLlmModel}</code> modeliyle yazıyor
            {searchAvailable(ctx) ? ' ve konularını internette araştırıyor' : ' (araştırma kapalı)'}.
            Bir turda en fazla {ctx.config.aiMaxGenerationsPerTick} metin üretilir.
          </p>
        ) : (
          <p class="flash error" role="alert">
            <strong>Metin motoru bağlı değil.</strong> Karakterler şu anda hazır şablonlarla
            yazıyor; bu yüzden cevaplar kısa ve jenerik kalır. Sunucu ortam değişkenlerine{' '}
            <code>AI_LLM_API_KEY</code> (ve isterseniz <code>AI_LLM_BASE_URL</code>,{' '}
            <code>AI_LLM_MODEL</code>) ekleyip sunucuyu yeniden başlatın. Araştırma için ayrıca{' '}
            <code>AI_SEARCH_API_KEY</code>.
          </p>
        )}
      </div>

      <div class="card">
        <h2>Board erişimi</h2>
        {coverage.eligible === 0 ? (
          <p class="flash error" role="alert">
            <strong>Karakterler şu anda hiçbir boardda paylaşamaz.</strong> Sitede{' '}
            {coverage.total} board var ({coverage.byVisibility.public ?? 0} herkese açık,{' '}
            {coverage.byVisibility.restricted ?? 0} kısıtlı, {coverage.byVisibility.private ?? 0}{' '}
            gizli) ama seçili erişim bunların hiçbirine izin vermiyor. Aşağıdan erişimi genişletin.
          </p>
        ) : (
          <p class="hint">
            {coverage.eligible} / {coverage.total} board kullanılabilir ·{' '}
            {ACCESS_OPTIONS.find((o) => o.value === coverage.access)?.label}
          </p>
        )}
        <form method="post" action="/admin/ai/board-access">
          <div class="field">
            <label for="ai-visibility">Karakterlerin paylaşabileceği boardlar</label>
            <select id="ai-visibility" name="visibility">
              {ACCESS_OPTIONS.map((option) => (
                <option value={option.value} selected={coverage.access === option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <div class="hint">
              Varsayılan olarak yalnızca herkese açık boardlar kullanılır. Gizli boardlarda paylaşım
              yalnızca burada açıkça seçilirse ve otomatik üyelikle mümkün olur.
            </div>
          </div>
          <button class="btn" type="submit">Kaydet</button>
        </form>{' '}
        <form method="post" action="/admin/ai/run" style="display:inline">
          <button class="btn secondary" type="submit">Şimdi bir tur çalıştır</button>
        </form>
      </div>

      {editing && <AiAgentForm ctx={ctx} agent={editing} />}
      {editing && showContent && <AiContentView ctx={ctx} agent={editing} />}

      <div class="card">
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>Karakter</th>
                <th>Kişilik</th>
                <th>Aktivite</th>
                <th>İçerik</th>
                <th>İtibar</th>
                <th>Durum</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr>
                  <td>
                    <a href={`/tc/${agent.username}`}>@{agent.username}</a>
                    <div class="hint">{agent.display_name}</div>
                  </td>
                  <td>{archetypeLabel(agent.archetype)}</td>
                  <td>{pct(agent.activity)}</td>
                  <td class="hint">
                    {agent.posts_created} gönderi · {agent.comments_created} yorum ·{' '}
                    {agent.votes_cast} oy
                  </td>
                  <td>
                    {reputationLabel(agent.reputation)}
                    <div class="hint">{Math.round(agent.reputation)}</div>
                  </td>
                  <td>{agent.enabled === 1 ? 'Aktif' : 'Pasif'}</td>
                  <td class="row-actions">
                    <a class="btn secondary small" href={`/admin?tab=ai&edit=${agent.user_id}`}>
                      Düzenle
                    </a>{' '}
                    <form method="post" action="/admin/ai/toggle" style="display:inline">
                      <input type="hidden" name="id" value={agent.user_id} />
                      <input type="hidden" name="enabled" value={agent.enabled === 1 ? '0' : '1'} />
                      <button class="btn secondary small" type="submit">
                        {agent.enabled === 1 ? 'Pasifleştir' : 'Aktifleştir'}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <AiActivityCard ctx={ctx} />
    </div>
  )
}

/** Karakter profil düzenleme formu. */
const AiAgentForm: FC<{ ctx: Ctx; agent: AiAgentWithUser }> = ({ ctx, agent }) => {
  const presence = boardPresence(ctx, agent.user_id)
  const peers = Object.entries(parseRecord<number>(agent.peers))
  const value = (field: string): number => Number(agent[field as keyof typeof agent] ?? 0)

  return (
    <div class="card">
      <h2>@{agent.username} — davranış profili</h2>
      <form method="post" action={`/admin/ai/${agent.user_id}`}>
        <div class="field">
          <label for="ai-bio">Karakter profili</label>
          <textarea id="ai-bio" name="bio" rows={2} style="width:100%">{agent.bio}</textarea>
        </div>
        <div class="field">
          <label for="ai-interests">İlgi alanları (virgülle ayrılmış)</label>
          <input
            id="ai-interests"
            name="interests"
            style="width:100%"
            value={parseList(agent.interests).join(', ')}
          />
        </div>
        <div class="field">
          <label for="ai-likes">Sevdiği konu türleri</label>
          <input id="ai-likes" name="likes" style="width:100%" value={parseList(agent.likes).join(', ')} />
        </div>
        <div class="field">
          <label for="ai-dislikes">Sevmediği konu türleri</label>
          <input
            id="ai-dislikes"
            name="dislikes"
            style="width:100%"
            value={parseList(agent.dislikes).join(', ')}
          />
        </div>

        <h3>Davranış ölçekleri</h3>
        {SLIDERS.map((slider) => (
          <div class="field">
            <label for={`ai-${slider.field}`}>
              {slider.label} — <strong>{pct(value(slider.field))}</strong>
            </label>
            <input
              id={`ai-${slider.field}`}
              name={slider.field}
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(value(slider.field) * 100)}
            />
            <div class="hint">{slider.hint}</div>
          </div>
        ))}

        <h3>Board tercihleri</h3>
        {presence.length === 0 && (
          <p class="hint">
            Henüz board tercihi tanımlanmadı — karakter herkese açık boardlarda eşit dağılır.
          </p>
        )}
        <div class="field">
          <label for="ai-boards">Tercih edilen boardlar (ad:0-100, virgülle)</label>
          <input
            id="ai-boards"
            name="boardPrefs"
            style="width:100%"
            placeholder="teknoloji:80, spor:40"
            value={Object.entries(parseRecord<number>(agent.board_prefs))
              .map(([name, weight]) => `${name}:${Math.round(weight * 100)}`)
              .join(', ')}
          />
        </div>
        {presence.length > 0 && (
          <p class="hint">
            Hakim olduğu boardlar:{' '}
            {presence
              .map((p) => `c/${p.community} (${p.posts}g · ${p.comments}y · ${p.votes}o)`)
              .join(', ')}
          </p>
        )}

        {peers.length > 0 && (
          <>
            <h3>Karakter ilişkileri (tanımlı)</h3>
            <p class="hint">
              {peers
                .map(([name, v]) => `${name}: ${v > 0 ? '+' : ''}${v.toFixed(2)}`)
                .join(' · ')}
            </p>
          </>
        )}

        <button class="btn" type="submit">Kaydet</button>{' '}
        <a class="btn secondary" href="/admin?tab=ai">Kapat</a>
      </form>

      <h3>Yönetim işlemleri</h3>
      <p class="hint">
        Sıfırlama karakterin sayaçlarını, itibarını, ilişkilerini ve board hakimiyetini temizler.
        Yazdığı gönderi ve yorumlar SİLİNMEZ — bunlar gerçek içeriktir.
      </p>
      <div class="row-actions">
        <form method="post" action={`/admin/ai/${agent.user_id}/reset`} style="display:inline">
          <button class="btn danger small" type="submit">Davranışı sıfırla</button>
        </form>{' '}
        <a class="btn secondary small" href={`/admin?tab=ai&edit=${agent.user_id}&content=1`}>
          Oluşturduğu içerikleri gör
        </a>
      </div>
    </div>
  )
}

/** Karakterin oluşturduğu içerik listesi. */
const AiContentView: FC<{ ctx: Ctx; agent: AiAgentWithUser }> = ({ ctx, agent }) => {
  const { posts, comments } = aiAgentContent(ctx, agent.user_id, 25)
  return (
    <div class="card">
      <h3>@{agent.username} — oluşturduğu içerikler</h3>
      <h4>Gönderiler ({posts.length})</h4>
      {posts.length === 0 && <p class="hint">Henüz gönderi yok.</p>}
      {posts.length > 0 && (
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>Başlık</th><th>Board</th><th>Tarih</th></tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr>
                  <td>{p.title}</td>
                  <td>c/{p.community}</td>
                  <td>{new Date(p.created_at).toISOString().slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h4>Yorumlar ({comments.length})</h4>
      {comments.length === 0 && <p class="hint">Henüz yorum yok.</p>}
      {comments.length > 0 && (
        <ul>
          {comments.map((c) => (
            <li>
              <div class="hint">{c.post_title}</div>
              {c.body}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** AI işlemlerinin denetim izi. */
const AiActivityCard: FC<{ ctx: Ctx }> = ({ ctx }) => {
  const entries = aiActivityLogWithNames(ctx, 60)
  return (
    <div class="card">
      <h2>AI işlem günlüğü</h2>
      {entries.length === 0 && <p class="hint">Henüz kayıt yok.</p>}
      {entries.length > 0 && (
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>Zaman</th><th>Karakter</th><th>İşlem</th><th>Detay</th></tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr>
                  <td>{new Date(e.created_at).toISOString().slice(11, 19)}</td>
                  <td>@{e.username}</td>
                  <td>{e.action}</td>
                  <td class="hint">{e.detail ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
