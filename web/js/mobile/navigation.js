/** One browser-history entry for the current overlay stack, not one per opening. */
export function createOverlayHistory({ history, getOverlay, onBack }) {
  const marker = '__avaOverlay'
  let pendingBack = false
  let handlingPop = false

  function owned() { return !!history.state?.[marker] }

  function open(kind) {
    if (!kind || pendingBack || handlingPop) return
    try {
      const state = { ...(history.state || {}), [marker]: kind }
      if (owned()) history.replaceState(state, '')
      else history.pushState(state, '')
    } catch {
      // The controls must still work when browser history is unavailable.
    }
  }

  function sync() {
    if (pendingBack || handlingPop) return
    const kind = getOverlay()
    if (kind) return open(kind)
    if (!owned()) return
    pendingBack = true
    try {
      history.back()
    } catch {
      pendingBack = false
      try {
        const state = { ...history.state }
        delete state[marker]
        history.replaceState(Object.keys(state).length ? state : null, '')
      } catch { /* Browser navigation is optional. */ }
    }
  }

  function onPopState() {
    if (pendingBack) {
      // A close button already dismissed the overlay. Do not dismiss the next one.
      pendingBack = false
      sync()
      return
    }
    handlingPop = true
    try {
      if (getOverlay()) onBack()
    } finally {
      handlingPop = false
      // A nested sheet may have closed while the call or knowledge panel remains.
      sync()
    }
  }

  return { open, sync, onPopState }
}
