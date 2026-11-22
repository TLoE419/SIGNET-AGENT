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
  return ['/', '/classic'].includes(url.pathname) || resultDownloadAllowed(value, origin);
}
function resultPreviewAllowed(value, origin) {
  if (!localURL(value, origin)) return false;
  const url = new URL(value);
  return !url.search && !url.hash && (resultPreviewPath(url.pathname) ||
    /^\/stage6\/result-preview\/[A-Za-z0-9_-]{32}\/[A-Za-z0-9_.+\/-]+$/.test(url.pathname)
    && url.pathname.split('/').every(part => part !== '.' && part !== '..'));
}
function resultDownloadAllowed(value, origin) {
  if (!localURL(value, origin)) return false;
  const url = new URL(value);
  return resultDownloadPath(url.pathname) || url.pathname === '/stage6/result-download'
    && !url.hash && [...url.searchParams.keys()].length === 1 && /^[A-Za-z0-9_-]{32}$/.test(url.searchParams.get('ticket') || '')
    || resultPreviewAllowed(value, origin) && /\.pdf$/.test(url.pathname);
}
function resultDownloadPath(pathname) {
  return pathname === '/signet/result-download';
}
function resultPreviewPath(pathname) {
  return /^\/signet\/result-preview\/[A-Za-z0-9_-]{32}\/signet_top[1-9][0-9]*_freq[0-9.eE+-]+\.html$/.test(pathname);
}
module.exports = {localURL, navigationAllowed, resultPreviewAllowed, resultDownloadAllowed, resultPreviewPath, resultDownloadPath};
