import {packager} from '@electron/packager';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
const output = await packager({
  dir: root, name: 'SIGNET', platform: 'darwin', arch: 'arm64',
  electronVersion: '44.5.1', out: path.join(root, 'dist'), overwrite: true,
  appBundleId: 'edu.uci.signet.desktop', appCategoryType: 'public.app-category.education',
  // Detached analysis workers use these Node sources after the window exits.
  asar: false, prune: true,
  ignore: /^\/(evidence|dist|\.runtime|README\.md|test[^/]*)(\/|$)/,
});
console.log(output.join('\n'));
