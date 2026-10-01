/**
 * Yönetim paneli — NPC yönetim sekmesi (görünüm katmanı).
 *
 * Bu dosya yalnızca GÖRÜNTÜ üretir; tüm veri işlemleri
 * `services/npc/*` katmanındadır. Böylece davranış mantığı arayüzden
 * ayrı kalır ve test edilebilir olur.
 *
 * Yetki: bu sekmeye giden rotalar `requireAdmin(viewer)` ile korunur —
 * NPC yönetimi yalnızca site yöneticisine açıktır, moderatöre değil.
 */
import type { FC } from 'hono/jsx'
import type { Ctx } from '../context'
import type { AiAgentWithUser } from '../types'
import {
  boardPresence,
  npcActivityLogWithNames,
  npcBoardCoverage,
  npcContent,
  parseList,
  parseRecord,
  type NpcBoardAccess,
} from '../services/npc/agents'
import { NPC_SLIDER_FIELDS } from '../services/npc/agents'
import { archetypeLabel } from '../services/npc/personas'
import { memorySize, recentEpisodes, listMemory } from '../services/npc/memory'
import { relationshipCount, relationshipsOf } from '../services/npc/relationships'
import { behaviorChanges, trialCount } from '../services/npc/learning'

/** Board erişimi seçenekleri (etiket + değer). */
const ACCESS_OPTIONS: Array<{ value: NpcBoardAccess; label: string }> = [
  { value: 'all', label: 'Tüm boardlar (varsayılan — sonradan açılanlar dahil)' },
  { value: 'public', label: 'Yalnızca herkese açık boardlar' },
  { value: 'restricted', label: 'Kısıtlı boardlar' },
  { value: 'private', label: 'Gizli boardlar' },
]

/** 0.0–1.0 ölçeğini yüzde olarak gösterir. */
function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** Zaman damgasını kısa biçimde gösterir. */
function shortTime(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

/** Karakter profil formundaki davranış alanları (20 eksen). */
const SLIDERS: Array<{ field: string; label: string; hint: string }> = [
  { field: 'activity', label: 'Aktivite seviyesi', hint: 'Ne sıklıkta döngüye girer' },
  { field: 'verbosity', label: 'Yazı uzunluğu', hint: '0 = tek cümle, 1 = uzun açıklama' },
  { field: 'humor', label: 'Mizah seviyesi', hint: 'Espri ve troll yoğunluğu' },
  { field: 'assertiveness', label: 'Tartışmacılık', hint: 'Kavgaya girme eğilimi' },
  { field: 'politeness', label: 'Nezaket seviyesi', hint: 'Nazik söyleyiş' },
  { field: 'curiosity', label: 'Merak', hint: 'Soru sorma ve öğrenme isteği' },
  { field: 'seriousness', label: 'Ciddiyet', hint: 'Troll/emoji bastırma' },
  { field: 'talkativeness', label: 'Konuşkanlık', hint: 'Cümle sayısı ve gönderi eğilimi' },
  { field: 'patience', label: 'Sabır', hint: 'Ters cevap toleransı' },
  { field: 'empathy', label: 'Empati', hint: 'Şikâyete duyarlılık' },
  { field: 'skepticism', label: 'Şüphecilik', hint: '"Kaynağın var mı?" kalıpları' },
  { field: 'confidence', label: 'Özgüven', hint: 'Kesin/çekinik ifade seçimi' },
  { field: 'slang_rate', label: 'Argo kullanımı', hint: 'Sokak ağzı yoğunluğu' },
  { field: 'profanity', label: 'Küfür eğilimi', hint: 'Kaba dil kullanımı' },
  { field: 'emoji_rate', label: 'Emoji kullanımı', hint: 'Emoji sıklığı' },
  { field: 'comment_rate', label: 'Yorum eğilimi', hint: 'Yorum yazma sıklığı' },
  { field: 'post_rate', label: 'Konu açma eğilimi', hint: 'Gönderi açma sıklığı' },
  { field: 'vote_rate', label: 'Vote verme eğilimi', hint: 'Oy kullanma sıklığı' },
  { field: 'upvote_bias', label: 'Yukarı oy eğilimi', hint: 'Olumlu oy verme' },
  { field: 'downvote_bias', label: 'Aşağı oy eğilimi', hint: 'Olumsuz oy verme' },
]

/** Karakterin itibar durumunu etiketle. */
function reputationLabel(reputation: number): string {
  if (reputation >= 60) return 'Efsane'
  if (reputation >= 30) return 'Saygın'
  if (reputation >= 10) return 'Tanınan'
  if (reputation >= 0) return 'Sıradan'
  if (reputation >= -20) return 'Şüpheli'
  return 'İtibar düşük'
}

/** NPC yönetim sekmesinin tamamı. */
export const NpcTab: FC<{
  ctx: Ctx
  agents: AiAgentWithUser[]
  editId: string
  showContent: boolean
  showMemory: boolean
}> = ({ ctx, agents, editId, showContent, showMemory }) => {
  const editing = editId ? agents.find((a) => a.user_id === editId) : undefined
  const enabled = agents.filter((a) => a.enabled === 1).length
  const totalPosts = agents.reduce((sum, a) => sum + a.posts_created, 0)
  const totalComments = agents.reduce((sum, a) => sum + a.comments_created, 0)
  const totalVotes = agents.reduce((sum, a) => sum + a.votes_cast, 0)
  const coverage = npcBoardCoverage(ctx)

  return (
    <div>
      <div class="card">
        <h2>NPC Karakterler</h2>
        <p class="hint">
          Toplam {agents.length} NPC · {enabled} aktif · {agents.length - enabled} pasif —{' '}
          {totalPosts} gönderi, {totalComments} yorum, {totalVotes} oy.
        </p>
        <p class="hint">
          NPC'ler <code>users</code> tablosunda <code>is_ai = 1</code> satırlarıdır ve{' '}
          <strong>oturum açamazlar</strong>. Davranış motoru mevcut kullanıcı servislerini çağırdığı
          için rate limit, spam koruması, yetki ve CSRF korumaları onlar için de aynen geçerlidir.
          Sistem <strong>tamamen yereldir</strong>: harici API, LLM veya internet bağımlılığı yoktur.
          Her işlem denetim günlüğüne yazılır.
        </p>
      </div>

      <div class="card">
        <h2>Simülasyon motoru</h2>
        <p class="hint">
          Her NPC her turda şu döngüyü yaşar: <strong>READ → UNDERSTAND → DECIDE → ACT → OBSERVE →
          UPDATE MEMORY → UPDATE RELATIONSHIP → UPDATE BEHAVIOR</strong>. Karakterler gördükleri her
          gönderiye cevap vermez; yedi karar sorusunun altısı "hayır" ise sessiz kalırlar.
        </p>
        <p class="hint">
          Yazar kalite kapısı: <strong>bağlam, kişilik, tekrar, tutarlılık ve konu</strong> skorları
          toplanır; eşiğin altındaki mesaj yayınlanmaz ve yeni bir aday denenir. Adayların hiçbiri
          geçemezse NPC yazmaz.
        </p>
      </div>

      <div class="card">
        <h2>Board erişimi</h2>
        {coverage.eligible === 0 ? (
          <p class="flash error" role="alert">
            <strong>NPC'ler şu anda hiçbir boardda paylaşamaz.</strong> Sitede {coverage.total} board
            var ({coverage.byVisibility.public ?? 0} herkese açık,{' '}
            {coverage.byVisibility.restricted ?? 0} kısıtlı, {coverage.byVisibility.private ?? 0}{' '}
            gizli) ama seçili erişim bunların hiçbirine izin vermiyor. Aşağıdan{' '}
            <strong>“Tüm boardlar”</strong> seçeneğini kaydedin.
          </p>
        ) : (
          <p class="hint">
            {coverage.eligible} / {coverage.total} board kullanılabilir ·{' '}
            {ACCESS_OPTIONS.find((o) => o.value === coverage.access)?.label}
          </p>
        )}
        <form method="post" action="/admin/npc/board-access">
          <div class="field">
            <label for="npc-visibility">NPC'lerin paylaşabileceği boardlar</label>
            <select id="npc-visibility" name="visibility">
              {ACCESS_OPTIONS.map((option) => (
                <option value={option.value} selected={coverage.access === option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <div class="hint">
              Varsayılan olarak NPC'ler <strong>tüm boardlarda</strong> paylaşabilir — sonradan
              oluşturulanlar da dahil. Gizli/kısıtlı boardlarda otomatik onaylı üye olurlar. Erişimi
              daraltmak isterseniz yukarıdan seçin.
            </div>
          </div>
          <button class="btn" type="submit">Kaydet</button>
        </form>{' '}
        <form method="post" action="/admin/npc/run" style="display:inline">
          <button class="btn secondary" type="submit">Şimdi bir tur çalıştır</button>
        </form>
      </div>

      {editing && <NpcAgentForm ctx={ctx} agent={editing} />}
      {editing && showMemory && <NpcMemoryView ctx={ctx} agent={editing} />}
      {editing && showContent && <NpcContentView ctx={ctx} agent={editing} />}

      <div class="card">
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>NPC</th>
                <th>Kişilik</th>
                <th>Aktivite</th>
                <th>İçerik</th>
                <th>Hafıza</th>
                <th>İlişki</th>
                <th>Öğrenme</th>
                <th>Son aktivite</th>
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
                    {agent.posts_created} g · {agent.comments_created} y · {agent.votes_cast} o
                    <div>{reputationLabel(agent.reputation)}</div>
                  </td>
                  <td class="hint">{memorySize(ctx, agent.user_id)} kayıt</td>
                  <td class="hint">{relationshipCount(ctx, agent.user_id)} kişi</td>
                  <td class="hint">{trialCount(ctx, agent.user_id)} deneme</td>
                  <td class="hint">{shortTime(agent.last_active_at)}</td>
                  <td>{agent.enabled === 1 ? 'Aktif' : 'Pasif'}</td>
                  <td class="row-actions">
                    <a class="btn secondary small" href={`/admin?tab=npc&edit=${agent.user_id}`}>
                      Düzenle
                    </a>{' '}
                    <form method="post" action="/admin/npc/toggle" style="display:inline">
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

      <NpcActivityCard ctx={ctx} />
    </div>
  )
}

/** Karakter profil düzenleme formu (20 davranış ekseni). */
const NpcAgentForm: FC<{ ctx: Ctx; agent: AiAgentWithUser }> = ({ ctx, agent }) => {
  const presence = boardPresence(ctx, agent.user_id)
  const value = (field: string): number => Number(agent[field as keyof typeof agent] ?? 0)

  return (
    <div class="card">
      <h2>@{agent.username} — davranış profili</h2>
      <p class="hint">
        Bu eksenler açıklama metni değil, doğrudan karar girdisidir: her biri yazım stilini,
        eylem seçimini ve oy davranışını etkiler.
      </p>
      <form method="post" action={`/admin/npc/${agent.user_id}`}>
        <div class="field">
          <label for="npc-bio">Karakter profili</label>
          <textarea id="npc-bio" name="bio" rows={2} style="width:100%">{agent.bio}</textarea>
        </div>
        <div class="field">
          <label for="npc-interests">İlgi alanları (virgülle ayrılmış)</label>
          <input
            id="npc-interests"
            name="interests"
            style="width:100%"
            value={parseList(agent.interests).join(', ')}
          />
          <div class="hint">
            Kavram ailesi adları kullanılır: {parseList(agent.interests).join(', ') || '—'}. Konu
            analizi bu adları kullanır; tutmayan bir ad yazılmamalı.
          </div>
        </div>
        <div class="field">
          <label for="npc-likes">Sevdiği konu türleri</label>
          <input id="npc-likes" name="likes" style="width:100%" value={parseList(agent.likes).join(', ')} />
        </div>
        <div class="field">
          <label for="npc-dislikes">Sevmediği konu türleri</label>
          <input
            id="npc-dislikes"
            name="dislikes"
            style="width:100%"
            value={parseList(agent.dislikes).join(', ')}
          />
        </div>

        <h3>Davranış eksenleri ({NPC_SLIDER_FIELDS.length})</h3>
        {SLIDERS.map((slider) => (
          <div class="field">
            <label for={`npc-${slider.field}`}>
              {slider.label} — <strong>{pct(value(slider.field))}</strong>
            </label>
            <input
              id={`npc-${slider.field}`}
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
            Henüz board tercihi tanımlanmadı — NPC herkese açık boardlarda eşit dağılır.
          </p>
        )}
        <div class="field">
          <label for="npc-boards">Tercih edilen boardlar (ad:0-100, virgülle)</label>
          <input
            id="npc-boards"
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
            {presence.map((p) => `c/${p.community} (${p.posts}g · ${p.comments}y · ${p.votes}o)`).join(' · ')}
          </p>
        )}

        <button class="btn" type="submit">Kaydet</button>{' '}
        <a class="btn secondary" href="/admin?tab=npc">Kapat</a>
      </form>

      <h3>Yönetim işlemleri</h3>
      <p class="hint">
        Sıfırlama NPC'nin sayaçlarını, itibarını, ilişkilerini, hafızasını ve öğrenme
        durumunu temizler. Yazdığı gönderi ve yorumlar SİLİNMEZ — bunlar gerçek içeriktir.
      </p>
      <div class="row-actions">
        <a class="btn secondary" href={`/admin?tab=npc&edit=${agent.user_id}&memory=1`}>
          Hafızayı görüntüle
        </a>{' '}
        <form method="post" action={`/admin/npc/${agent.user_id}/reset`} style="display:inline">
          <button class="btn danger small" type="submit">Davranışı sıfırla</button>
        </form>{' '}
        <form method="post" action={`/admin/npc/${agent.user_id}/memory-reset`} style="display:inline">
          <button class="btn danger small" type="submit">Hafızayı sıfırla</button>
        </form>{' '}
        <a class="btn secondary" href={`/admin?tab=npc&edit=${agent.user_id}&content=1`}>
          Oluşturduğu içerikleri gör
        </a>
      </div>
    </div>
  )
}

/** NPC'nin hafızası, ilişkileri ve öğrenme değişimleri. */
const NpcMemoryView: FC<{ ctx: Ctx; agent: AiAgentWithUser }> = ({ ctx, agent }) => {
  const memories = listMemory(ctx, agent.user_id, 25)
  const episodes = recentEpisodes(ctx, agent.user_id, 10)
  const rels = relationshipsOf(ctx, agent.user_id, 10)
  const changes = behaviorChanges(ctx, agent.user_id, 10)

  return (
    <div class="card">
      <h3>@{agent.username} — hafıza ve öğrenme</h3>

      <h4>Hafıza kayıtları ({memorySize(ctx, agent.user_id)})</h4>
      {memories.length === 0 && <p class="hint">Henüz hafıza kaydı yok.</p>}
      {memories.length > 0 && (
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>Tür</th><th>Anahtar</th><th>Ağırlık</th><th>Hit</th><th>+</th><th>−</th><th>Son görülme</th></tr>
            </thead>
            <tbody>
              {memories.map((m) => (
                <tr>
                  <td>{m.kind}</td>
                  <td>{m.key}</td>
                  <td>{m.weight.toFixed(2)}</td>
                  <td>{m.hits}</td>
                  <td>{m.positive}</td>
                  <td>{m.negative}</td>
                  <td class="hint">{shortTime(m.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4>Önemli olaylar</h4>
      {episodes.length === 0 && <p class="hint">Henüz önemli olay yok.</p>}
      {episodes.length > 0 && (
        <ul>
          {episodes.map((e) => (
            <li>
              <div class="hint">
                {e.concept_id} · skor {e.score.toFixed(2)} · {shortTime(e.created_at)}
              </div>
              {e.summary}
            </li>
          ))}
        </ul>
      )}

      <h4>İlişkiler</h4>
      {rels.length === 0 && <p class="hint">Henüz ilişki yok.</p>}
      {rels.length > 0 && (
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>Kişi</th><th>Dostluk</th><th>Saygı</th><th>Güven</th><th>Hoşnutsuzluk</th><th>Rekabet</th><th>Etkileşim</th></tr>
            </thead>
            <tbody>
              {rels.map((r) => (
                <tr>
                  <td>@{r.username}</td>
                  <td>{r.friendship.toFixed(2)}</td>
                  <td>{r.respect.toFixed(2)}</td>
                  <td>{r.trust.toFixed(2)}</td>
                  <td>{r.dislike.toFixed(2)}</td>
                  <td>{r.rivalry.toFixed(2)}</td>
                  <td>{r.interactions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4>Davranış değişimleri</h4>
      {changes.length === 0 && (
        <p class="hint">
          Henüz kayda değer değişim yok. Davranış ağırlıkları yalnızca gözlenen sonuç
          (etkileşim, oy, cevap) pozitif veya negatif olduğunda kademeli kayar.
        </p>
      )}
      {changes.length > 0 && (
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>Konu</th><th>Mizah</th><th>Uzunluk</th><th>Etkileşim</th><th>Konu açma</th><th>Deneme</th><th>Ödül</th></tr>
            </thead>
            <tbody>
              {changes.map((b) => (
                <tr>
                  <td>{b.topic || '(genel)'}</td>
                  <td>{b.humor_w.toFixed(2)}</td>
                  <td>{b.length_w.toFixed(2)}</td>
                  <td>{b.engage_w.toFixed(2)}</td>
                  <td>{b.post_w.toFixed(2)}</td>
                  <td>{b.trials}</td>
                  <td>{b.reward.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <a class="btn secondary" href={`/admin?tab=npc&edit=${agent.user_id}`}>
        Profili düzenlemeye dön
      </a>
    </div>
  )
}

/** NPC'nin oluşturduğu içerik listesi. */
const NpcContentView: FC<{ ctx: Ctx; agent: AiAgentWithUser }> = ({ ctx, agent }) => {
  const { posts, comments } = npcContent(ctx, agent.user_id, 25)
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
                  <td>{shortTime(p.created_at)}</td>
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
          {comments.map((cm) => (
            <li>
              <div class="hint">{cm.post_title}</div>
              {cm.body}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** NPC işlemlerinin denetim izi. */
const NpcActivityCard: FC<{ ctx: Ctx }> = ({ ctx }) => {
  const entries = npcActivityLogWithNames(ctx, 60)
  return (
    <div class="card">
      <h2>NPC işlem günlüğü</h2>
      {entries.length === 0 && <p class="hint">Henüz kayıt yok.</p>}
      {entries.length > 0 && (
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>Zaman</th><th>NPC</th><th>İşlem</th><th>Detay</th></tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr>
                  <td>{shortTime(e.created_at)}</td>
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
