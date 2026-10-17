/**
 * @fileoverview The admin sidebar: every section links to a page that exists,
 * and the active-section match does not bleed into sibling paths.
 */
import { describe, it, expect, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('next/navigation', () => ({ usePathname: () => '/admin/markets' }))
vi.mock('next/link', () => ({ default: () => null }))

import { ADMIN_SECTIONS, isActiveSection } from '../AdminNav'

describe('ADMIN_SECTIONS', () => {
  it('includes the market, stock and trader sections', () => {
    expect(ADMIN_SECTIONS.map((s) => s.href)).toEqual([
      '/admin/users',
      '/admin/markets',
      '/admin/stocks',
      '/admin/traders',
      '/admin/database',
    ])
  })

  it.each(ADMIN_SECTIONS.map((s) => [s.href]))('%s has a page', (href) => {
    const page = resolve(__dirname, '..', href.replace('/admin/', ''), 'page.tsx')
    expect(existsSync(page)).toBe(true)
  })

  it('gives every section a name and description', () => {
    for (const section of ADMIN_SECTIONS) {
      expect(section.name.length).toBeGreaterThan(0)
      expect(section.description.length).toBeGreaterThan(0)
    }
  })
})

describe('isActiveSection', () => {
  it('matches the section and its subpaths', () => {
    expect(isActiveSection('/admin/markets', '/admin/markets')).toBe(true)
    expect(isActiveSection('/admin/database/users', '/admin/database')).toBe(true)
  })

  it('does not match a sibling that shares a prefix', () => {
    expect(isActiveSection('/admin/marketsx', '/admin/markets')).toBe(false)
    expect(isActiveSection('/admin/users', '/admin/markets')).toBe(false)
  })
})
