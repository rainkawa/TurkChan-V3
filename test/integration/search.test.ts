import { beforeEach, describe, expect, test } from 'vitest'
import {
  Agent,
  createCommunityVia,
  createPostVia,
  createTestWorld,
  registerUser,
  type TestWorld,
} from '../testUtils'

let world: TestWorld

beforeEach(() => {
  world = createTestWorld()
})

describe('US-028 search', () => {
  test('matches post titles and bodies, and community names/descriptions', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'quran_class')
    await createPostVia(agent, 'quran_class', 'Bring your own mushaf?', 'Question about the tajweed schedule')

    const guest = agent
    let res = await guest.get('/search?q=mushaf')
    expect(await res.text()).toContain('Bring your own mushaf?')

    res = await guest.get('/search?q=tajweed') // body match
    expect(await res.text()).toContain('Bring your own mushaf?')

    res = await guest.get('/search?q=quran') // community name match
    expect(await res.text()).toContain('c/quran_class')
  })

  test('edited posts are re-indexed; deleted/removed posts drop out', async () => {
    const { agent: mod } = await registerUser(world)
    await createCommunityVia(mod, 'library')
    const { agent: author } = await registerUser(world)
    const postId = await createPostVia(author, 'library', 'Searchable title', 'original findme-alpha text')

    await author.post(`/posts/${postId}/edit`, { body: 'now with findme-beta instead' })
    const guest = mod
    expect(await (await guest.get('/search?q=findme-beta')).text()).toContain('Searchable title')
    expect(await (await guest.get('/search?q=findme-alpha')).text()).not.toContain('Searchable title')

    await mod.post(`/mod/remove/post/${postId}`)
    expect(await (await guest.get('/search?q=findme-beta')).text()).not.toContain('Searchable title')
  })

  test('community-scoped search filters to that community', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'alpha_zone')
    await createCommunityVia(agent, 'beta_zone')
    await createPostVia(agent, 'alpha_zone', 'Shared keyword banana in alpha')
    world.tick(10 * 60 * 1000)
    await createPostVia(agent, 'beta_zone', 'Shared keyword banana in beta')

    const res = await agent.get('/search?q=banana&community=alpha_zone')
    const text = await res.text()
    expect(text).toContain('banana in alpha')
    expect(text).not.toContain('banana in beta')
  })

  test('empty results prompt posting the question', async () => {
    const { agent } = await registerUser(world)
    const res = await agent.get('/search?q=zzzunfindable')
    expect(await res.text()).toContain('ilgili bir boardda sorunuzu paylaşın')
  })

  test('search is safe against FTS syntax injection', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'sturdy')
    await createPostVia(agent, 'sturdy', 'Regular post')
    const guest = agent
    for (const q of ['"unclosed', 'a AND OR NOT', 'col:val', '(((', '*']) {
      const res = await guest.get(`/search?q=${encodeURIComponent(q)}`)
      expect(res.status).toBe(200) // never a raw error
    }
  })
})
