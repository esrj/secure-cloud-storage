/**
 * Which links the app is willing to hand to the operating system.
 *
 * `shell.openExternal` asks the OS to open a URL with whatever program is registered for
 * its scheme. For `https:` that is the browser; for `file:`, `smb:` or an application's own
 * scheme it can be a local program. A link that reaches the window-open handler comes from
 * page content, so only ordinary web links are passed on.
 *
 * No Electron imports here so the module can be unit-tested with `node --test`
 * (see test/window/externalUrl.test.mjs).
 */
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:'])

/**
 * @param {unknown} url
 * @returns {boolean} true only for a well-formed http(s) URL
 */
export function isSafeExternalUrl(url) {
  if (typeof url !== 'string') return false
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false // not a URL at all
  }
}
