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
const statusLabels = {ok:"Query complete", created:"Run created", process_completed:"Process ended; analysis validity still needs review", completed:"Complete", prepared:"Preparation only", unavailable:"Unavailable", blocked:"Requirements not met", invalid:"Invalid parameters", error:"Error", interrupted:"Interrupted", skipped:"Skipped", unknown:"State unknown", failed:"Failed", timed_out:"Timed out", timeout:"Timed out"};
Object.assign(statusLabels, {submitted:"Submitted; awaiting startup confirmation", starting:"Starting", running:"Running", verified_completed:"Completed; outputs verified", verification_failed:"Output verification failed", cancelled:"Stopped"});
const bad = new Set(['error','failed','interrupted','timeout','timed_out']);
function node(tag, className, text) {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function message(role, text) {
  const item = node('article', `message ${role}`);
  const label = role === 'user' ? 'You' : role === 'notice' ? 'Status' : 'SIGNET assistant';
  item.append(node('div', 'message-label', label), node('div', 'message-body'));
  item.lastChild.textContent = text;
  $('messages').append(item);
  $('messages').scrollTop = $('messages').scrollHeight;
  return item.lastChild;
}
function createTurn() {
  const root = node('article', 'turn');
  const head = node('div', 'turn-head');
  const timer = node('span', '', '0 s');
  head.append(node('span', '', `Request ${String(++turns).padStart(2,'0')}`), timer);
  const steps = node('div', 'steps');
  const transport = node('details', 'transport');
  transport.append(node('summary', '', 'Connection and timing details'), node('pre', '', ''));
  root.append(head, steps, transport);
  $('activity').append(root);
  $('chat-progress').hidden = false;
  return {root, steps, timer, transport:transport.lastChild, started:performance.now(), current:null, mode:null};
}
function card(turn, title, kind) {
  const el = node('div', `step ${kind}`);
  const head = node('div', 'step-heading');
  head.append(node('span', 'step-title', title), node('span', 'step-time', `+${((performance.now()-turn.started)/1000).toFixed(1)} s`));
  el.append(head);
  turn.steps.append(el);
  turn.current = el;
  turn.mode = kind;
  return el;
}
function progress(turn, text) {
  const follow = $('activity').scrollHeight - $('activity').scrollTop - $('activity').clientHeight < 100;
  if (/^(?:HTTP attempt|Multiple HTTP attempts|Transport timing:|Time before|Gap before retry|Final transport|Service-reported token counts:)/.test(text)) {
    turn.transport.textContent += text + '\n';
  } else if (text.startsWith('Quota wait:')) {
    if (!turn.current) card(turn, "Waiting for quota", 'model');
    let line = turn.current.querySelector('.quota-wait');
    if (!line) {line = node('div', 'step-line quota-wait'); turn.current.append(line);}
    line.textContent = text;
    const seconds = text.match(/(\d+) s\b/);
    $('state').textContent = seconds ? `Retrying in ${seconds[1]} s` : "Waiting for model";
  } else if (text.startsWith('Model request ') && text.includes('awaiting response')) {
    card(turn, "Waiting for model response", 'model').append(node('div','step-line',text));
    $('state').textContent = "Waiting for model";
  } else if (/^(Public tool-selection note|No public tool-selection note)/.test(text)) {
    card(turn, "Tool-selection notes", 'decision').append(node('div','step-line',text));
  } else if (/^Tool \d/.test(text)) {
    card(turn, text.split(';')[0], 'tool').append(node('div','step-line',"Validating arguments and calling the tool. Argument values stay hidden."));
    $('state').textContent = "Running tool";
  } else if (text.startsWith('Tool result:')) {
    if (turn.mode !== 'tool') card(turn, "Tool result", 'tool');
    const match = text.match(/status=([^;]+); executed=(.*?)\.$/);
    const status = match?.[1] || 'unknown';
    const executed = match?.[2];
    const severity = bad.has(status) || status === 'verification_failed' ? 'error' : ['ok','created','process_completed','completed','verified_completed','cancelled'].includes(status) ? '' : 'warning';
    if (severity) turn.current.classList.add(severity);
    const label = match ? `${text.split(';')[0]}\n${statusLabels[status] || status} (${status}) · ${executed === 'True' ? "Executed" : executed === 'False' ? "Not executed" : "Execution flag not provided; check status"}` : text;
    turn.current.append(node('div', `step-line result ${severity}`, label));
  } else {
    if (!turn.current) card(turn, "Progress", 'model');
    if (text.startsWith('Model responded')) $('state').textContent = "Processing response";
    turn.current.append(node('div','step-line',text));
  }
  if (follow) $('activity').scrollTop = $('activity').scrollHeight;
}
async function send(text) {
  if (busy || !text.trim()) return;
  const turnId = crypto.randomUUID();
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
  const answer = message('assistant', "Working… See execution progress below the chat.");
  const turn = createTurn();
  $('state').classList.add('live');
  $('state').textContent = "Connecting";
  const interval = setInterval(() => {turn.timer.textContent = `${Math.floor((performance.now()-turn.started)/1000)} s`;}, 250);
  let done = false, failed = false, registered = false, stopping = false;
  const stop = $('stop-response');
  async function requestStop() {
    try {
      const response = await fetch('/chat/cancel', {method:'POST',
        headers:{'Content-Type':'application/json','X-Chat-Token':document.querySelector('meta[name="chat-token"]').content},
        body:JSON.stringify({session,turn_id:turnId})});
      if (!response.ok) throw Error('Could not stop the response. Try again.');
    } catch (error) {if (!done) {stopping=false;if(stop)stop.disabled=false;$('state').textContent=error.message;}}
  }
  if(stop){stop.hidden=false;stop.disabled=false;stop.onclick=()=>{
    if(done||stopping)return;stopping=true;stop.disabled=true;$('state').textContent='Stopping response…';
    if(registered)void requestStop();
  };}
  try {
    const response = await fetch('/chat', {method:'POST', headers:{'Content-Type':'application/json','X-Chat-Token':document.querySelector('meta[name="chat-token"]').content},body:JSON.stringify({text,session,turn_id:turnId,workspace_context})});
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "The local service rejected the request.");
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    function consume(line) {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if(event.type==='turn_started'&&event.text?.turn_id===turnId){registered=true;if(stopping)void requestStop();}
      if(event.type==='model_fallback')message('notice',`This response uses ${event.text.model}.`);
      if(stopping&&['answer','workspace_action','ui'].includes(event.type))return;
      if(event.type==='done'&&event.status==='cancelled')answer.textContent='Response stopped. Completed tool records are retained.';
      if (event.type === 'ui') window.dispatchEvent(new CustomEvent('panel-request', {detail:event.text}));
      if (event.type === 'progress') progress(turn, event.text);
      if (event.type === 'answer') {
        answer.classList.add('markdown');
        answer.innerHTML = renderMarkdown(event.text);
      }
      if (event.type === 'error') {failed = true; answer.textContent += '\n\n' + event.text; answer.parentElement.classList.add('error');}
      if (event.type === 'done') {failed = failed || ['failed', 'needs_review', 'cancelled'].includes(event.status); if (failed) answer.parentElement.classList.add('error'); turn.root.dataset.status = event.status || (failed ? 'needs_review' : 'completed'); done = true; history.replaceState(null, '', location.pathname + '?session=' + session); card(turn,failed ? 'Needs attention' : 'Turn finished',failed ? 'error' : 'end').append(node('div','step-line',event.text));}
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
    if (!done) throw new Error("Connection interrupted. Tools may still be running. Check the run status before retrying.");
    $('state').textContent = failed ? "Needs attention" : "Turn finished";
  } catch (error) {
    const text = error instanceof TypeError ? "Connection failed or interrupted. Check that the local server is running. Started tools may continue; check their status first." : error.message;
    answer.textContent += `\n\n${text}`;
    answer.parentElement.classList.add('error');
    card(turn,"Needs attention",'error').append(node('div','step-line',text));
    $('state').textContent = "Needs attention";
  } finally {
    if(stop){stop.hidden=true;stop.onclick=null;}
    clearInterval(interval);
    turn.timer.textContent = `${((performance.now()-turn.started)/1000).toFixed(1)} s`;
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
    if(saved.model_fallback)message('notice',`This response uses ${saved.model_fallback}.`);
    const body = message(saved.role, saved.text);
    if (saved.role === 'assistant') {
      body.classList.add('markdown');
      body.innerHTML = renderMarkdown(saved.text);
    }
  }
  $('activity-empty')?.remove();
  for (const events of initialChat.events || []) {
    const turn = node('article', 'turn');
    turn.append(node('div', 'turn-head', `Saved request ${String(++turns).padStart(2, '0')}`));
    const detail = node('details', 'transport');
    detail.append(node('summary', '', 'View original activity log'), node('pre', '', events.join('\n')));
    turn.append(detail);
    $('activity').append(turn);
  }
  $('chat-progress').hidden = turns === 0;
  $('state').textContent = "Conversation restored";
}
