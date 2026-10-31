import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MOBILE_LINK_OFF } from './mobile-link-sampler'
import { MobileSessionLinkSheet } from './MobileSessionLinkSheet'

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('../components/BottomDrawer', () => ({ BottomDrawer: () => null }))

function renderSheet(visible: boolean) {
  const setDetailed = vi.fn()
  const monitor = {
    subscribe: () => () => {},
    getSnapshot: () => MOBILE_LINK_OFF,
    setDetailed
  }
  const element = (nextVisible: boolean) =>
    createElement(MobileSessionLinkSheet, { monitor, visible: nextVisible, onClose: () => {} })
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(element(visible))
  })
  return {
    setDetailed,
    setVisible: (next: boolean) => act(() => renderer?.update(element(next))),
    unmount: () => act(() => renderer?.unmount())
  }
}

describe('the link details sheet', () => {
  it('samples faster only while open', () => {
    const sheet = renderSheet(false)
    expect(sheet.setDetailed).toHaveBeenLastCalledWith(false)

    sheet.setVisible(true)
    expect(sheet.setDetailed).toHaveBeenLastCalledWith(true)

    sheet.setVisible(false)
    expect(sheet.setDetailed).toHaveBeenLastCalledWith(false)
    sheet.unmount()
  })

  it('gives the default rate back when it goes away open', () => {
    const sheet = renderSheet(true)
    expect(sheet.setDetailed).toHaveBeenLastCalledWith(true)

    sheet.unmount()

    expect(sheet.setDetailed).toHaveBeenLastCalledWith(false)
  })
})
