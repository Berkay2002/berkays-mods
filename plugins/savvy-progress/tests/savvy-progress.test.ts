import { describe, expect, test } from 'claude-code/testing'

import { crab, tierOf } from '../hooks/register'

describe('claude-config crew', () => {
  test('scout, builder and reviewer are tiers of their own; savvy tiers still work; anything else is other', async () => {
    expect(tierOf('scout')).toBe('scout')
    expect(tierOf('builder')).toBe('builder')
    expect(tierOf('reviewer')).toBe('reviewer')
    expect(tierOf('some-plugin:reviewer')).toBe('reviewer')
    expect(tierOf('savvy-careful')).toBe('careful')
    expect(tierOf('careful')).toBe('other')
    expect(tierOf('Explore')).toBe('other')
  })

  test('each crew crab wears its own costume', async () => {
    const drawn = ['scout', 'builder', 'reviewer', 'other'].map(c => crab(0, 0, c))
    expect(new Set(drawn).size).toBe(4)
    expect(crab(0, 0, 'builder', false, true)).toContain('class="c-builder run"')
  })
})
