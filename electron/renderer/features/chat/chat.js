'use strict';
const $ = id => document.getElementById(id);
const initialChat = JSON.parse($('initial-chat')?.textContent || '{}');
const session = initialChat.session || crypto.randomUUID();
if (initialChat.session) history.replaceState(null, '', location.pathname + '?session=' + session);
let busy = false, turns = 0;
// Saved conversations are listed in the rail; the current one is marked and not a link.
const chatList = $('chat-list');
for (const saved of initialChat.sessions || []) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'chat-link';
  item.dataset.session = saved.session;
  item.textContent = saved.title;
  item.title = saved.title;
  if (saved.session === initialChat.session) item.setAttribute('aria-current', 'page');
  item.addEventListener('click', () => {
    if (!busy && saved.session !== initialChat.session) location.assign(location.pathname + '?session=' + encodeURIComponent(saved.session));
  });
  chatList?.append(item);
}
if ($('chat-list-label')) $('chat-list-label').hidden = !(initialChat.sessions || []).length;
function setChatListDisabled(value) {
  for (const item of chatList?.children || []) item.disabled = value;
}
const statusLabels = {ok:'查詢完成', created:'工作已建立', process_completed:'程序已結束，分析有效性仍須核對', completed:'已完成', prepared:'僅完成準備', unavailable:'目前無法執行', blocked:'條件不足', invalid:'參數無效', error:'發生錯誤', interrupted:'已中斷', skipped:'已跳過', unknown:'狀態未知', failed:'執行失敗', timed_out:'執行逾時', timeout:'執行逾時'};
Object.assign(statusLabels, {submitted:'已送出，待確認啟動', starting:'正在啟動', running:'執行中', verified_completed:'已完成並通過輸出核對', verification_failed:'輸出核對未通過', cancelled:'已確認停止'});
const bad = new Set(['error','failed','interrupted','timeout','timed_out']);
function node(tag, className, text) {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) uiText(el, text);
  return el;
}
function message(role, text) {
  const item = node('article', `message ${role}`);
  item.append(node('div', 'message-label', role === 'user' ? '你' : 'SIGNET 助手'), node('div', 'message-body'));
  item.lastChild.textContent = text;
  $('messages').append(item);
  $('messages').scrollTop = $('messages').scrollHeight;
  return item.lastChild;
}
function createTurn() {
  const root = node('article', 'turn');
  const head = node('div', 'turn-head');
  const timer = node('span', '', '0 秒');
  head.append(node('span', '', `需求 ${String(++turns).padStart(2,'0')}`), timer);
  const steps = node('div', 'steps');
  const transport = node('details', 'transport');
  transport.append(node('summary', '', '連線與計時細節'), node('pre', '', ''));
  root.append(head, steps, transport);
  $('activity').append(root);
  $('chat-progress').hidden = false;
  return {root, steps, timer, transport:transport.lastChild, started:performance.now(), current:null, mode:null};
}
function card(turn, title, kind) {
  const el = node('div', `step ${kind}`);
  const head = node('div', 'step-heading');
  head.append(node('span', 'step-title', title), node('span', 'step-time', `+${((performance.now()-turn.started)/1000).toFixed(1)} 秒`));
  el.append(head);
  turn.steps.append(el);
  turn.current = el;
  turn.mode = kind;
  return el;
}
function progress(turn, text) {
  const follow = $('activity').scrollHeight - $('activity').scrollTop - $('activity').clientHeight < 100;
  if (/HTTP|底層|token 數|方法開始|再次送出|最後傳輸/.test(text)) {
    uiText(turn.transport, (turn.transport.dataset.i18n || '') + text + '\n');
  } else if (text.startsWith('額度等待：')) {
    if (!turn.current) card(turn, '等待免費額度', 'model');
    let line = turn.current.querySelector('.quota-wait');
    if (!line) {line = node('div', 'step-line quota-wait'); turn.current.append(line);}
    uiText(line, text);
    const seconds = text.match(/剩餘 (\d+) 秒/) || text.match(/(\d+) 秒/);
    uiText($('state'), seconds ? `等待發送 · ${seconds[1]} 秒` : '等待模型');
  } else if (text.startsWith('模型請求') && text.includes('等待回覆')) {
    card(turn, '等待模型回覆', 'model').append(node('div','step-line',text));
    uiText($('state'), '等待模型');
  } else if (text.startsWith('決策摘要')) {
    card(turn, '選擇工具的公開說明', 'decision').append(node('div','step-line',text));
  } else if (/^工具 \d/.test(text)) {
    card(turn, text.split('；')[0], 'tool').append(node('div','step-line','正在驗證參數並呼叫工具；參數值不顯示。'));
    uiText($('state'), '執行工具');
  } else if (text.startsWith('工具結果：')) {
    if (turn.mode !== 'tool') card(turn, '工具結果', 'tool');
    const match = text.match(/status=([^；]+)；executed=(.*?)。$/);
    const status = match?.[1] || 'unknown';
    const executed = match?.[2];
    const severity = bad.has(status) || status === 'verification_failed' ? 'error' : ['ok','created','process_completed','completed','verified_completed','cancelled'].includes(status) ? '' : 'warning';
    if (severity) turn.current.classList.add(severity);
    const label = match ? `${text.split('；')[0]}\n${statusLabels[status] || status}（${status}） · ${executed === 'True' ? '已執行' : executed === 'False' ? '未執行' : '未標示執行旗標，請依狀態判讀'}` : text;
    turn.current.append(node('div', `step-line result ${severity}`, label));
  } else {
    if (!turn.current) card(turn, '處理進度', 'model');
    if (text.startsWith('模型已回覆')) uiText($('state'), '處理回覆');
    turn.current.append(node('div','step-line',text));
  }
  if (follow) $('activity').scrollTop = $('activity').scrollHeight;
}
async function send(text) {
  if (busy || !text.trim()) return;
  const selection = {context: null};
  window.dispatchEvent(new CustomEvent('workspace-context-request', {detail: selection}));
  const workspace_context = selection.context;
  busy = true;
  window.dispatchEvent(new Event('chat-busy'));
  $('send').disabled = true;
  $('new-chat').disabled = true;
  setChatListDisabled(true);
  document.querySelectorAll('[data-prompt]').forEach(button => button.disabled = true);
  $('welcome')?.remove();
  $('activity-empty')?.remove();
  message('user', text);
  $('prompt').value = '';
  const answer = message('assistant', '處理中…請查看聊天下方的執行過程。');
  uiText(answer, '處理中…請查看聊天下方的執行過程。');
  const turn = createTurn();
  $('state').classList.add('live');
  uiText($('state'), '連線中');
  const interval = setInterval(() => {uiText(turn.timer, `${Math.floor((performance.now()-turn.started)/1000)} 秒`);}, 250);
  let done = false, failed = false;
  try {
    const response = await fetch('/chat', {method:'POST', headers:{'Content-Type':'application/json','X-Chat-Token':document.querySelector('meta[name="chat-token"]').content},body:JSON.stringify({text,session,language:uiLanguage,workspace_context})});
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || '本機服務拒絕請求。');
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    function consume(line) {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'ui') window.dispatchEvent(new CustomEvent('panel-request', {detail:event.text}));
      if (event.type === 'progress') progress(turn, event.text);
      if (event.type === 'answer') {
        delete answer.dataset.i18n;
        answer.classList.add('markdown');
        answer.innerHTML = renderMarkdown(event.text);
        if (/^(模型請求失敗|精簡後輸入估算|模型未回傳完整內容|模型未產生有效回答|模型補答時|已達工具呼叫輪數|單輪工具呼叫|工具已中斷|已中斷等待模型)/.test(event.text)) {
          failed = true;
          uiText(answer, event.text);
          answer.parentElement.classList.add('error');
        }
      }
      if (event.type === 'error') {failed = true; uiText(answer, answer.textContent + '\n\n' + event.text); answer.parentElement.classList.add('error');}
      if (event.type === 'done') {failed = failed || ['failed', 'needs_review', 'cancelled'].includes(event.status); turn.root.dataset.status = event.status || (failed ? 'needs_review' : 'completed'); done = true; history.replaceState(null, '', location.pathname + '?session=' + session); card(turn,failed ? '需要確認' : '本回合已結束',failed ? 'error' : 'end').append(node('div','step-line',event.text));}
    }
    while (true) {
      const part = await reader.read();
      buffer += decoder.decode(part.value, {stream:!part.done});
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(consume);
      if (part.done) break;
    }
    consume(buffer);
    if (!done) throw new Error('連線已中斷；工具可能仍在執行。請核對工作狀態，避免重複操作。');
    uiText($('state'), failed ? '需要確認' : '回合結束');
  } catch (error) {
    const text = error instanceof TypeError ? '無法連線或連線中斷；請確認本機程式仍在執行。已啟動的工具可能繼續執行，請先核對狀態。' : error.message;
    uiText(answer, (answer.dataset.i18n || answer.textContent) + `\n\n${text}`);
    answer.parentElement.classList.add('error');
    card(turn,'需要確認','error').append(node('div','step-line',text));
    uiText($('state'), '需要確認');
  } finally {
    clearInterval(interval);
    uiText(turn.timer, `${((performance.now()-turn.started)/1000).toFixed(1)} 秒`);
    $('state').classList.remove('live');
    busy = false;
    window.dispatchEvent(new Event('chat-idle'));
    $('send').disabled = false;
    $('new-chat').disabled = false;
    setChatListDisabled(false);
    $('prompt').focus();
    $('messages').scrollTop = $('messages').scrollHeight;
  }
}
$('composer').addEventListener('submit', event => {event.preventDefault(); send($('prompt').value.trim());});
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {event.preventDefault(); $('composer').requestSubmit();}
});
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => send(button.dataset.prompt)));
$('new-chat').addEventListener('click', () => {if (!busy) location.assign(location.pathname + '?new=1');});
if (initialChat.messages?.length) {
  $('welcome')?.remove();
  for (const saved of initialChat.messages) {
    const body = message(saved.role, saved.text);
    if (saved.role === 'assistant') {
      body.classList.add('markdown');
      body.innerHTML = renderMarkdown(saved.text);
    }
  }
  $('activity-empty')?.remove();
  for (const events of initialChat.events || []) {
    const turn = node('article', 'turn');
    turn.append(node('div', 'turn-head', `已保留需求 ${String(++turns).padStart(2, '0')}`));
    const detail = node('details', 'transport');
    detail.append(node('summary', '', '查看原執行紀錄'), node('pre', '', events.join('\n')));
    turn.append(detail);
    $('activity').append(turn);
  }
  $('chat-progress').hidden = turns === 0;
  uiText($('state'), '已恢復對話');
}
