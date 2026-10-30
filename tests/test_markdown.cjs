const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..', 'electron', 'renderer', 'features', 'chat');
const context = vm.createContext({});
context.window = context;
vm.runInContext(fs.readFileSync(path.join(root, 'chat.js'), 'utf8').split('// SIGNET chat interface')[0], context);
const render = source => {context.source = source; return vm.runInContext('renderMarkdown(source)', context);};

const labels = ['顯著配對清單', '找到多少', '關聯證據', '變異分組'];
for (const label of labels) {
  assert.ok(render(`- **${label}：**列出說明。`).includes(`<strong>${label}：</strong>列出說明。`));
}
assert.ok(render('**這次已完成。**本次使用模擬資料。').includes('<strong>這次已完成。</strong>本次'));
assert.ok(render('`**用途：**說明`').includes('<code>**用途：**說明</code>'));
assert.ok(render('```text\n**用途：**說明\n```').includes('**用途：**說明'));
assert.ok(!render('\\*\\*用途：\\*\\*說明').includes('<strong>'));

const formatted = render('# 標題\n\n**粗體**、*斜體*與 `工具`\n\n1. 第一項\n   - 子項\n\n> 引用\n\n---\n\n| 階段 | 狀態 |\n| --- | --- |\n| 查詢 | 完成 |\n\n```python\nprint("<safe>")\n```\n\n[文件](https://example.com)');
for (const fragment of ['<h1>標題</h1>', '<strong>粗體</strong>', '<em>斜體</em>', '<code>工具</code>', '<ol>', '<ul>', '<blockquote>', '<hr>', '<table>', '<th>階段</th>', '<td>完成</td>', '<pre><code class="language-python">', '&lt;safe&gt;', 'href="https://example.com"']) {
  assert.ok(formatted.includes(fragment), `Missing rendered element: ${fragment}`);
}
const unsafe = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))\n\n[encoded](jav&#x61;script:alert(1))\n\n[local](file:///etc/passwd)\n\n![remote](https://example.com/tracker.png)');
assert.doesNotMatch(unsafe, /<(?:script|img)\b|href="(?:javascript:|file:)/);
assert.ok(unsafe.includes('&lt;img'));
assert.ok(unsafe.includes('&lt;script&gt;'));
assert.ok(!render('[data](data:text/html;base64,PHNjcmlwdD4=)').includes('<a '));
const summary = '【決策摘要】\n選擇原因：根據檔案清單整理可用研究資料。\n資訊依據：專案檔案 목록。\n尚缺資訊：各檔案內容格式與完整性。';
assert.equal(render(summary + '\n\n實際回答：有三個資料檔。'), '<p>實際回答：有三個資料檔。</p>\n');
assert.equal(render('實際回答。\n\n' + summary), '<p>實際回答。</p>\n');
assert.equal(render('### 決策摘要\n- **選擇原因：**查詢\n- **資訊依據**：檔案\n- 尚缺資訊: 無\n\n**答案**'), '<p><strong>答案</strong></p>\n');
assert.equal(render(summary), '<p>模型未提供其他回答。</p>\n');
assert.ok(render('```text\n' + summary + '\n```').includes('資訊依據：專案檔案 목록。'));
assert.ok(render('這裡說明決策摘要的用途。').includes('這裡說明決策摘要的用途。'));
console.log('Markdown formatting and unsafe-content checks passed.');
