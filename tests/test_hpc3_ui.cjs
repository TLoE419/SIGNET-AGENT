// Offline tests for the HPC3 sidebar card (web/hpc3.js) with the real i18n.js.
// A minimal fake DOM and a scripted fetch stand in for the browser and the /hpc3 API:
// no server, no ssh and no dialogs. The UCInetID and host names are made up.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const IDS = ['hpc3-card', 'hpc3-state', 'hpc3-detail', 'hpc3-login-form', 'hpc3-user', 'hpc3-login',
  'hpc3-logout', 'hpc3-refresh', 'hpc3-error', 'language-toggle'];
const CONNECTED = {status: 'connected', connected: true, user: 'jdoe', host: 'hpc3.example',
  remote: {hostname: 'login-i15', user: 'jdoe', slurm: true}};
const NOT_LOGGED_IN = {status: 'auth_required', connected: false, user: 'jdoe', host: 'hpc3.example'};

function element(id) {
  return {id, hidden: false, disabled: false, value: '', textContent: '', dataset: {}, attributes: {}, events: {},
    setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(name, fn) { this.events[name] = fn; }, focus() {}};
}

// Build a page whose /hpc3 API answers from `routes` ("METHOD /path" -> list of [code, body]).
function page(routes, language = 'en') {
  const elements = Object.fromEntries(IDS.map(id => [id, element(id)]));
  elements['hpc3-detail'].hidden = elements['hpc3-login-form'].hidden = elements['hpc3-error'].hidden = true;
  const requests = [], timers = [], windowEvents = {}, saved = new Map([['signet-language', language]]);
  async function fetch(path, options = {}) {
    const method = options.method || 'GET';
    requests.push({method, path, headers: options.headers, body: options.body});
    const queue = routes[method + ' ' + path.split('?')[0]];
    if (!queue || !queue.length) throw new Error('Unexpected request ' + method + ' ' + path);
    const [code, body] = queue.length > 1 ? queue.shift() : queue[0];
    return {status: code, json: async () => body};
  }
  const document = {documentElement: {}, getElementById: id => elements[id] || null,
    querySelector: () => ({content: 'page-token'}), querySelectorAll: () => []};
  const window = {addEventListener: (name, fn) => { windowEvents[name] = fn; }, dispatchEvent: event => windowEvents[event.type]?.()};
  const context = vm.createContext({document, window, fetch, Event: class { constructor(type) { this.type = type; } },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    localStorage: {getItem: k => saved.get(k), setItem: (k, v) => saved.set(k, v)}});
  vm.runInContext(fs.readFileSync('web/i18n.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('web/hpc3.js', 'utf8'), context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    el: elements, requests, context,
    async settle() { for (let i = 0; i < 10; i++) await settle(); },
    async click(id) { elements[id].events.click(); await this.settle(); },
    async submit() { elements['hpc3-login-form'].events.submit({preventDefault() {}}); await this.settle(); },
    async tick() { timers.shift()(); await this.settle(); },
    visible: () => IDS.filter(id => id.startsWith('hpc3-') && !['hpc3-card', 'hpc3-state', 'hpc3-user', 'hpc3-login'].includes(id) && !elements[id].hidden),
  };
}

(async () => {
  // 1. No UCInetID yet: an empty field and the login button; a bad name is refused; a good
  //    one is saved and the login starts in the same click.
  {
    const p = page({'GET /hpc3/login': [[200, {state: 'idle'}]],
      'GET /hpc3/status': [[200, {status: 'not_configured', connected: false, user: null}]],
      'POST /hpc3/user': [[400, {error: 'bad'}], [200, {user: 'jdoe'}]],
      'POST /hpc3/login': [[202, {state: 'waiting_for_user'}]]});
    await p.settle();
    assert.equal(p.el['hpc3-state'].textContent, 'No account set');
    assert.deepEqual(p.visible(), ['hpc3-login-form']);
    assert.equal(p.el['hpc3-user'].value, '');
    assert.equal(p.el['hpc3-login'].textContent, 'Log in to HPC3');
    await p.submit();
    assert.equal(p.el['hpc3-error'].textContent, 'Enter your UCInetID first.');
    p.el['hpc3-user'].value = 'JDoe';
    await p.submit();
    assert.equal(p.el['hpc3-error'].textContent, 'Invalid UCInetID: use lowercase letters, digits, _ or -.');
    assert.equal(p.requests.filter(r => r.path === '/hpc3/login' && r.method === 'POST').length, 0);
    p.el['hpc3-user'].value = ' jdoe ';
    await p.submit();
    const saved = p.requests.filter(r => r.path === '/hpc3/user');
    assert.deepEqual(JSON.parse(saved[1].body), {user: 'jdoe'});
    assert.equal(p.requests.at(-1).path, '/hpc3/login');
    assert.equal(p.el['hpc3-state'].textContent, 'Logging in…');
  }

  // 1b. A returning user sees their last account pre-filled and can type a different one.
  {
    const p = page({'GET /hpc3/login': [[200, {state: 'idle'}]], 'GET /hpc3/status': [[200, NOT_LOGGED_IN]],
      'POST /hpc3/user': [[200, {user: 'asmith'}]], 'POST /hpc3/login': [[202, {state: 'waiting_for_user'}]]});
    await p.settle();
    assert.equal(p.el['hpc3-user'].value, 'jdoe');
    assert.deepEqual(p.visible(), ['hpc3-detail', 'hpc3-login-form', 'hpc3-refresh']);
    p.el['hpc3-user'].value = 'asmith';
    await p.submit();
    assert.deepEqual(p.requests.slice(-2).map(r => [r.method, r.path, r.body]),
      [['POST', '/hpc3/user', '{"user":"asmith"}'], ['POST', '/hpc3/login', '{}']]);
  }

  // 2. Login: 202, poll while waiting, then connected; logout returns to "not connected".
  {
    const p = page({'GET /hpc3/login': [[200, {state: 'idle'}], [200, {state: 'waiting_for_user'}], [200, {state: 'succeeded'}]],
      'GET /hpc3/status': [[200, NOT_LOGGED_IN], [200, CONNECTED], [200, NOT_LOGGED_IN]],
      'POST /hpc3/login': [[202, {state: 'waiting_for_user'}]], 'POST /hpc3/logout': [[200, {message: 'ok'}]]});
    await p.settle();
    await p.submit();
    assert.equal(p.el['hpc3-state'].textContent, 'Logging in…');
    assert.equal(p.el['hpc3-detail'].textContent, 'Enter your password in the window that opens, then approve Duo on your phone.');
    assert.deepEqual(p.visible(), ['hpc3-detail']);
    assert.equal(p.el['hpc3-card'].dataset.state, 'busy');
    await p.tick();  // still waiting_for_user
    assert.equal(p.el['hpc3-state'].textContent, 'Logging in…');
    await p.tick();  // succeeded -> forced status refresh
    assert.equal(p.el['hpc3-state'].textContent, 'Connected');
    assert.equal(p.el['hpc3-detail'].textContent, 'jdoe @ login-i15');
    assert.deepEqual(p.visible(), ['hpc3-detail', 'hpc3-logout']);
    await p.click('hpc3-logout');
    assert.equal(p.el['hpc3-state'].textContent, 'Not connected');
    // Logging in again with the same account does not re-save it.
    assert.equal(p.requests.filter(r => r.path === '/hpc3/user').length, 0);
    // Every request carries the page token; nothing the page sends contains a password field.
    assert.ok(p.requests.every(r => r.headers['X-Chat-Token'] === 'page-token'));
    assert.ok(p.requests.every(r => !/password/i.test(r.body || '')));
  }

  // 3. Failed or impossible logins explain themselves.
  {
    const p = page({'GET /hpc3/login': [[200, {state: 'idle'}], [200, {state: 'failed', message: 'Login failed (ssh exit 255).'}],
      [200, {state: 'failed', message: 'Login cancelled.', cancelled: true}]],
      'GET /hpc3/status': [[200, NOT_LOGGED_IN]],
      'POST /hpc3/login': [[202, {state: 'waiting_for_user'}], [202, {state: 'waiting_for_user'}], [501, {error: 'x'}]]});
    await p.settle();
    await p.submit();
    await p.tick();
    assert.match(p.el['hpc3-error'].textContent, /^Login did not finish/);
    await p.submit();
    await p.tick();
    assert.equal(p.el['hpc3-error'].textContent, 'Login cancelled.');
    await p.submit();
    assert.equal(p.el['hpc3-error'].textContent, 'Login windows need macOS. Run python3 hpc3_ssh.py login in a terminal.');
  }

  // 4. Off the VPN, logging in cannot help: the button only saves the account; "Check again".
  {
    const p = page({'GET /hpc3/login': [[200, {state: 'idle'}]],
      'GET /hpc3/status': [[200, {status: 'network_unreachable', connected: false, user: 'jdoe'}]]});
    await p.settle();
    assert.equal(p.el['hpc3-detail'].textContent, 'Cannot reach HPC3. Connect to the UCI VPN or campus network.');
    assert.deepEqual(p.visible(), ['hpc3-detail', 'hpc3-login-form', 'hpc3-refresh']);
    assert.equal(p.el['hpc3-login'].textContent, 'Save account');
    await p.submit();  // same account, nothing to save: just re-checks, never starts a login
    assert.ok(!p.requests.some(r => r.path === '/hpc3/login' && r.method === 'POST'));
    await p.click('hpc3-refresh');
    assert.equal(p.requests.at(-1).path, '/hpc3/status?refresh=1');
  }

  // 5. A reload during a login resumes polling instead of offering a second login.
  {
    const p = page({'GET /hpc3/login': [[200, {state: 'waiting_for_user'}], [200, {state: 'succeeded'}]],
      'GET /hpc3/status': [[200, NOT_LOGGED_IN], [200, CONNECTED]]});
    await p.settle();
    assert.equal(p.el['hpc3-state'].textContent, 'Logging in…');
    await p.tick();
    assert.equal(p.el['hpc3-state'].textContent, 'Connected');
  }

  // 6. Traditional Chinese, and switching language re-renders the card.
  {
    const p = page({'GET /hpc3/login': [[200, {state: 'idle'}]], 'GET /hpc3/status': [[200, NOT_LOGGED_IN]]}, 'zh-Hant');
    await p.settle();
    assert.equal(p.el['hpc3-state'].textContent, '未連線');
    assert.equal(p.el['hpc3-detail'].textContent, '尚未登入 HPC3。');
    vm.runInContext("applyLanguage('en')", p.context);
    assert.equal(p.el['hpc3-detail'].textContent, 'Not logged in to HPC3.');
  }

  // 7. Server values are only ever shown as text, never parsed as HTML.
  assert.doesNotMatch(fs.readFileSync('web/hpc3.js', 'utf8'), /innerHTML|insertAdjacentHTML|outerHTML/);
  console.log('PASS: HPC3 card states, login polling, errors, language and request safety');
})().catch(error => { console.error(error); process.exit(1); });
