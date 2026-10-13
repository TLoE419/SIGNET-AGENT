// Exact local resource allowlist shared by the privileged protocol and tests.
const assets = require('./design-assets.json');
const files = Object.assign(Object.create(null), {
 '/formal.js': ['formal.js','text/javascript'], '/formal-bindings.js': ['formal-bindings.js','text/javascript'], '/formal.css': ['formal.css','text/css'],
 '/index.html': ['index.html','text/html'], '/renderer.js': ['renderer.js','text/javascript'],
 '/style.css': ['style.css','text/css'], '/design-layout.css': ['design-layout.css','text/css'],
 '/design-pages.js': ['design-pages.js','text/javascript'], '/design-routes.js': ['design-routes.js','text/javascript'],
 '/assets/fonts/InterVariable.woff2': ['assets/fonts/InterVariable.woff2','font/woff2'],
 '/assets/select-chevron.svg': ['assets/select-chevron.svg','image/svg+xml'],
});
for (const {file} of assets) {
 if (typeof file !== 'string' || !/^assets\/design\/(4-16|4-17|4-39|4-64)\/[a-f0-9-]+\.svg$/.test(file)) throw Error('Invalid design asset path');
 files['/' + file] = [file,'image/svg+xml'];
}
function lookup(host,method,pathname) {
 if (host !== 'app' || method !== 'GET' || !Object.hasOwn(files,pathname)) return null;
 return files[pathname];
}
module.exports = {lookup};
