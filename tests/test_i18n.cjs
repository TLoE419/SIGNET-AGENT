const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function element(dataset={},textContent='') {
  return {dataset,textContent,attributes:{},setAttribute(k,v){this.attributes[k]=v;},addEventListener(_,fn){this.click=fn;}};
}
const toggle=element(), label=element({i18n:'對話'}), state=element({i18n:'回合結束'});
const prompt=element({i18nPlaceholder:'描述你的研究目的，或接著補充資料…'});
prompt.value='Keep my unsent research question.';
const message=element({},'原始對話，必須保留。');
const elements=[label,state,prompt,message], saved=new Map();
const document={documentElement:{},getElementById(){return toggle;},querySelectorAll(selector){
  const key=selector.slice(6,-1).replace(/-([a-z])/g,(_,ch)=>ch.toUpperCase());
  return elements.filter(el=>Object.hasOwn(el.dataset,key));
}};
let languageEvents=0;
const context=vm.createContext({document,window:{dispatchEvent(){languageEvents++;}},Event:class Event{},localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)}});
vm.runInContext(fs.readFileSync('electron/renderer/i18n/index.js','utf8'),context);
const tr=text=>vm.runInContext(`translateUI(${JSON.stringify(text)})`,context);
assert.equal(document.documentElement.lang,'en');
assert.equal(label.textContent,'Chat');
assert.equal(state.textContent,'Turn finished');
assert.equal(tr('模型請求 2/5：模型=gpt-6.1-sol；訊息數=10；可用工具=22；等待回覆。'),'Model request 2/5: model=gpt-6.1-sol; messages=10; available tools=22; awaiting response.');
assert.equal(tr('工具耗時：0.31 秒。'),'Tool duration: 0.31 s.');
assert.equal(tr('處理中…請查看聊天下方的執行過程。'),'Working… See execution progress below the chat.');
assert.equal(tr('已完成並通過輸出核對'),'Completed; outputs verified');
assert.equal(tr('目前進度：本次需求已有 2 個工具結果；失敗發生在後續模型請求。'),'Progress: 2 tool results are retained; a later model request failed.');
assert.equal(tr('runs/test/medical-results.tsv'),'runs/test/medical-results.tsv');
toggle.click();
assert.equal(document.documentElement.lang,'zh-Hant');
assert.equal(label.textContent,'對話');
assert.equal(toggle.textContent,'English');
assert.equal(saved.get('signet-language'),'zh-Hant');
assert.equal(message.textContent,'原始對話，必須保留。');
assert.equal(prompt.value,'Keep my unsent research question.');
toggle.click();
assert.equal(label.textContent,'Chat');
assert.equal(message.textContent,'原始對話，必須保留。');
assert.equal(languageEvents,3);
const html=(fs.readFileSync('electron/renderer/app/App.tsx','utf8').replaceAll('className=', 'class=').replaceAll('htmlFor=', 'for=') + '<script id="initial-chat"></script>');
for(const match of html.matchAll(/data-i18n(?:-aria|-placeholder|-prompt)?="([^"]+)"/g)){
 assert.notEqual(tr(match[1]),match[1],`Missing English translation: ${match[1]}`);
}
assert.ok(!html.includes('對話存於本機；回合結束後可重新整理恢復'));
console.log('Language switching, persistence, translations and conversation preservation passed.');
