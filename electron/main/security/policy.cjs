'use strict';
function localURL(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password;
  } catch { return false; }
}
function navigationAllowed(value, origin) {
  if (!localURL(value, origin)) return false;
  const url = new URL(value);
  return ['/', '/classic', '/stage6/file'].includes(url.pathname)
    || url.pathname === '/stage6/result-download' && resultDownloadAllowed(value, origin);
}
function resultPreviewAllowed(value, origin) {
  if (!localURL(value, origin)) return false;
  const url = new URL(value);
  return !url.search && !url.hash && /^\/stage6\/result-preview\/[A-Za-z0-9_-]{32}\/[A-Za-z0-9_.+\/-]+$/.test(url.pathname)
    && url.pathname.split('/').every(part => part !== '.' && part !== '..');
}
function resultDownloadAllowed(value, origin) {
  if (!localURL(value, origin)) return false;
  const url = new URL(value);
  return url.pathname === '/stage6/file' || url.pathname === '/stage6/result-download'
    && !url.hash && [...url.searchParams.keys()].length === 1 && /^[A-Za-z0-9_-]{32}$/.test(url.searchParams.get('ticket') || '')
    || resultPreviewAllowed(value, origin) && /\.pdf$/.test(url.pathname);
}
module.exports = {localURL, navigationAllowed, resultPreviewAllowed, resultDownloadAllowed};
