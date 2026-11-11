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
  return url.pathname === '/' || resultDownloadPath(url.pathname);
}
function resultDownloadPath(pathname) {
  return pathname === '/stage6/file' || pathname === '/signet/result-download';
}
function resultPreviewPath(pathname) {
  return /^\/signet\/result-preview\/[A-Za-z0-9_-]{32}\/signet_top[1-9][0-9]*_freq[0-9.eE+-]+\.html$/.test(pathname);
}
module.exports = {localURL, navigationAllowed, resultDownloadPath, resultPreviewPath};
