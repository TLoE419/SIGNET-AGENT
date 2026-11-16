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
  return ['/', '/classic', '/stage6/file'].includes(url.pathname);
}
module.exports = {localURL, navigationAllowed};
