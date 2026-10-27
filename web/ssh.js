'use strict';
if (window.signetDesktop?.isDesktop) {
  const script = document.createElement('script');
  script.src = '/ssh-ui.js';
  document.head.append(script);
}
