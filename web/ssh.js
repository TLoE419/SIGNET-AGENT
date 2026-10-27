'use strict';

(() => {
  const desktop = window.signetDesktop;
  const openButton = document.getElementById('ssh-open');
  if (!desktop?.isDesktop || !desktop.ssh || !openButton) return;
  const api = desktop.ssh;
  const get = id => document.getElementById(id);
  const dialog = get('ssh-dialog');
  const fields = {name:get('ssh-name'), username:get('ssh-username'), host:get('ssh-host'),
    port:get('ssh-port'), privateKeyPath:get('ssh-key-path')};
  let snapshot = {profiles:[], selectedProfileId:null, connection:null};
  const statusText = {disconnected:'未連線', connecting:'連線中', connected:'已連線', disconnecting:'中斷連線中', error:'發生錯誤'};

  function errorMessage(error) {
    const box = get('ssh-error');
    box.textContent = error?.message || 'SSH operation failed.';
    box.hidden = false;
  }
  function clearError() { get('ssh-error').hidden = true; get('ssh-error').textContent = ''; }
  function selected() { return snapshot.profiles.find(profile => profile.id === snapshot.selectedProfileId); }
  function populate(profile) {
    fields.name.value = profile?.name || '';
    fields.username.value = profile?.username || '';
    fields.host.value = profile?.host || 'hpc3.rcic.uci.edu';
    fields.port.value = profile?.port || 22;
    fields.privateKeyPath.value = profile?.privateKeyPath || '';
  }
  function render(next) {
    snapshot = next;
    const profileSelect = get('ssh-profile');
    const before = profileSelect.value;
    profileSelect.replaceChildren(new Option(translateUI('新增設定'), ''));
    for (const profile of snapshot.profiles) profileSelect.add(new Option(`${profile.name} · ${profile.username}`, profile.id));
    profileSelect.value = snapshot.selectedProfileId || '';
    if (before !== profileSelect.value || !fields.name.value) populate(selected());
    const status = snapshot.connection?.status || 'disconnected';
    openButton.hidden = false;
    openButton.className = `ssh-open ${status}`;
    uiText(get('ssh-open-label'), `SSH · ${statusText[status] || '未連線'}`);
    if (snapshot.connection?.error) get('ssh-state').textContent = snapshot.connection.error.message;
    else uiText(get('ssh-state'), statusText[status] || '未連線');
    uiText(get('ssh-connect'), status === 'connected' ? '中斷連線' : status === 'connecting' ? '取消' : '連線');
    get('ssh-connect').disabled = status === 'disconnecting';
    const pending = snapshot.pendingHost;
    get('ssh-host-trust').hidden = !pending;
    get('ssh-fingerprint').textContent = pending ? `${pending.host}:${pending.port} · ${pending.algorithm} · ${pending.fingerprint}` : '';
    if (snapshot.connection?.error) errorMessage(snapshot.connection.error);
  }
  function profilePayload() {
    return {id:get('ssh-profile').value || undefined, name:fields.name.value.trim(), host:fields.host.value.trim(),
      port:Number(fields.port.value), username:fields.username.value.trim(), privateKeyPath:fields.privateKeyPath.value};
  }
  async function run(action) {
    clearError();
    try { await action(); }
    catch (error) { errorMessage(error); }
  }

  openButton.addEventListener('click', () => { clearError(); render(snapshot); dialog.showModal(); });
  get('ssh-profile').addEventListener('change', async event => {
    clearError();
    if (!event.target.value) { populate(null); return; }
    await run(async () => { await api.selectProfile(event.target.value); });
  });
  get('ssh-pick-key').addEventListener('click', () => run(async () => {
    const choice = await api.pickPrivateKey();
    if (!choice.canceled) {
      const inspection = await api.inspectPrivateKey(choice.path);
      if (inspection.status !== 'encrypted') throw Error(inspection.reason || 'Select an encrypted OpenSSH private key.');
      fields.privateKeyPath.value = choice.path;
    }
  }));
  get('ssh-save').addEventListener('click', () => run(async () => {
    const saved = await api.saveProfile(profilePayload());
    get('ssh-profile').value = saved.id;
  }));
  get('ssh-generate-key').addEventListener('click', () => run(async () => {
    const passphrase = get('ssh-new-passphrase').value;
    const confirmation = get('ssh-confirm-passphrase').value;
    if (passphrase !== confirmation) throw Error('The new key passphrases do not match.');
    const input = {label:get('ssh-key-label').value.trim(), username:fields.username.value.trim(), passphrase};
    try {
      const key = await api.generateKey(input);
      fields.privateKeyPath.value = key.privateKeyPath;
      if (!fields.name.value) fields.name.value = key.label;
      get('ssh-public-key').value = key.publicKey;
      get('ssh-public-key-label').hidden = false;
    } finally {
      input.passphrase = '';
      get('ssh-new-passphrase').value = '';
      get('ssh-confirm-passphrase').value = '';
    }
  }));
  get('ssh-connect').addEventListener('click', () => run(async () => {
    const status = snapshot.connection?.status;
    if (status === 'connected' || status === 'connecting') { await api.disconnect(); return; }
    let id = get('ssh-profile').value;
    if (!id) { const saved = await api.saveProfile(profilePayload()); id = saved.id; }
    const passphrase = get('ssh-passphrase').value;
    get('ssh-passphrase').value = '';
    try { await api.connect(id, passphrase); } finally { get('ssh-passphrase').value = ''; }
  }));
  get('ssh-trust').addEventListener('click', () => run(async () => {
    if (!get('ssh-confirm-host').checked) throw Error('Confirm that you independently verified the fingerprint.');
    await api.trustHost(snapshot.pendingHost);
    get('ssh-confirm-host').checked = false;
  }));
  dialog.addEventListener('close', () => {
    get('ssh-passphrase').value = '';
    get('ssh-new-passphrase').value = '';
    get('ssh-confirm-passphrase').value = '';
    clearError();
  });
  api.subscribe(render);
  api.snapshot().then(render, errorMessage);
  window.addEventListener('languagechange', () => render(snapshot));
})();
