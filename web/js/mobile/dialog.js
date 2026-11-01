/** Focus, background isolation and ownership for the shared personal-app sheet. */
export function createDialogController({ dialog, backdrop, title, body, getBackground = () => [], getFallbackFocus = () => null }) {
  const doc = dialog.ownerDocument
  let serial = 0
  let session = null
  let background = new Map()
  const focusSelector = 'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

  function usable(element) {
    return !!(element && element.isConnected && !element.disabled &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]') && element.getClientRects().length)
  }

  function focusables() {
    return Array.from(dialog.querySelectorAll(focusSelector)).filter((element) => element.tabIndex >= 0 && usable(element))
  }

  function focusInside() {
    if (!session) return
    const preferred = dialog.querySelector('[autofocus], [data-initial-focus]')
    const target = usable(preferred) ? preferred : focusables()[0] || dialog
    target.focus({ preventScroll: true })
  }

  function notify(closed, reason) {
    if (typeof closed?.onClose !== 'function') return
    // Settle ownership first; a queue continuation may open another sheet.
    const callback = closed.onClose
    closed.onClose = null
    try { callback(reason) } catch (error) { console.error('[Ava] 弹窗关闭回调失败', error) }
  }

  function writeContent(nextTitle, html) {
    if (title) title.textContent = nextTitle || '提示'
    if (body) body.innerHTML = html == null ? '' : String(html)
  }

  function open(nextTitle, html, options = {}) {
    const previous = session
    const returnFocus = previous ? previous.returnFocus : doc.activeElement
    if (!previous) {
      background = new Map()
      for (const element of getBackground()) {
        if (!element || element === dialog || element.contains(dialog)) continue
        background.set(element, element.inert)
        element.inert = true
      }
    }
    const id = ++serial
    session = { id, returnFocus, onClose: options.onClose }
    writeContent(nextTitle, html)
    dialog.hidden = false
    if (backdrop) backdrop.hidden = false
    dialog.setAttribute('aria-modal', 'true')
    if (title?.id) dialog.setAttribute('aria-labelledby', title.id)
    dialog.tabIndex = -1
    focusInside()
    notify(previous, 'replaced')
    return id
  }

  function isCurrent(id) {
    return !!session && session.id === id
  }

  function update(id, nextTitle, html) {
    if (!isCurrent(id)) return false
    const focused = doc.activeElement
    const hadFocus = dialog.contains(focused)
    writeContent(nextTitle, html)
    // Keep a surviving header control focused; move only if its node was replaced.
    if (hadFocus && !usable(focused)) focusInside()
    return true
  }

  function close(id, reason = 'dismissed') {
    if (!session || (id !== undefined && !isCurrent(id))) return false
    const closed = session
    session = null
    dialog.hidden = true
    if (backdrop) backdrop.hidden = true
    for (const [element, original] of background) element.inert = original
    background.clear()
    const target = usable(closed.returnFocus) ? closed.returnFocus : getFallbackFocus()
    if (usable(target)) target.focus({ preventScroll: true })
    notify(closed, reason)
    return true
  }

  dialog.addEventListener('keydown', (event) => {
    if (!session || event.defaultPrevented || event.key !== 'Tab') return
    const items = focusables()
    const first = items[0]
    const last = items.at(-1)
    if (!first) {
      event.preventDefault()
      dialog.focus({ preventScroll: true })
    } else if (event.shiftKey && (doc.activeElement === first || doc.activeElement === dialog)) {
      event.preventDefault()
      last.focus({ preventScroll: true })
    } else if (!event.shiftKey && (doc.activeElement === last || doc.activeElement === dialog)) {
      event.preventDefault()
      first.focus({ preventScroll: true })
    }
  })
  doc.addEventListener('focusin', (event) => {
    if (session && !dialog.contains(event.target)) focusInside()
  })

  return { open, update, close, isCurrent, get currentId() { return session?.id ?? null } }
}
