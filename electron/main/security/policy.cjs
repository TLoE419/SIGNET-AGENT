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
module.exports = {localURL, navigationAllowed, resultDownloadPath};
