'use strict';
const uiEnglish = {
  "安全連線": "SECURE CONNECTION",
  "已儲存的 SSH 設定": "Saved SSH profile",
  "設定名稱": "Profile name",
  "使用者名稱": "Username",
  "主機": "Host",
  "連接埠": "Port",
  "加密的 OpenSSH 私鑰": "Encrypted OpenSSH private key",
  "選擇…": "Choose…",
  "建立由 App 管理的金鑰": "Create an app-managed key",
  "加密私鑰會留在 SIGNET 應用程式儲存區。連線前請先將公鑰加入遠端帳號。": "The encrypted private key stays in SIGNET application storage. Add the public key to the remote account before connecting.",
  "金鑰名稱": "Key name",
  "新金鑰密碼": "New key passphrase",
  "確認金鑰密碼": "Confirm passphrase",
  "產生加密金鑰": "Generate encrypted key",
  "公鑰": "Public key",
  "儲存設定": "Save profile",
  "私鑰密碼": "Private-key passphrase",
  "未知的主機身分": "Unknown host identity",
  "信任主機前，請透過獨立管道確認這組指紋。": "Confirm this fingerprint independently before trusting the host.",
  "我已透過獨立管道確認這組指紋。": "I independently verified this fingerprint.",
  "信任已確認的主機": "Trust verified host",
  "SSH · 未連線": "SSH · Disconnected",
  "SSH · 連線中": "SSH · Connecting",
  "SSH · 已連線": "SSH · Connected",
  "SSH · 中斷連線中": "SSH · Disconnecting",
  "SSH · 發生錯誤": "SSH · Error",
  "未連線": "Disconnected",
  "中斷連線": "Disconnect",
  "連線": "Connect",
  "取消": "Cancel",
  "新增設定": "New profile",
  "已存對話": "Saved conversations",
  "此版本未附資料或分析結果。聊天需登入模型；科學分析另需來源、資料與執行環境。": "No data or analysis results are bundled. Chat requires model sign-in; scientific analysis also requires source code, data and a configured runtime.",
  "網路視覺化": "Network visualization",
  "SIGNET · 研究助手": "SIGNET · Research Assistant",
  "研究工作台": "Research workspace",
  "＋ 開始新對話": "+ New chat",
  "工作空間": "WORKSPACE",
  "研究助手": "Research assistant",
  "本機工作階段": "Local session",
  "對話": "Chat",
  "你與 SIGNET 助手": "You and SIGNET",
  "今天想探索什麼？": "What would you like to explore?",
  "從一個研究問題開始。<br>聊天下方可查看執行過程，右側可比較網路結果。": "Start with a research question.\nSee chat activity below and compare networks on the right.",
  "了解分析能力": "Explore analyses",
  "檢查目前資料與工作": "Review data and runs",
  "輸入研究需求": "Enter your research request",
  "Enter 送出 · Shift + Enter 換行": "Enter to send · Shift + Enter for a new line",
  "送出": "Send",
  "送出後會使用目前模型帳號的額度。關閉頁面不會取消已啟動的工具。": "Sending uses your model account quota. Closing this page does not cancel running tools.",
  "執行過程": "Activity",
  "等待需求": "Ready",
  "依實際事件逐步更新。決策摘要是模型的公開說明，仍需對照工具結果。": "Updated from actual events. Tool-selection notes are public explanations; verify them against tool results.",
  "每一步，都有跡可循": "Follow every step",
  "送出需求後，這裡會依序顯示<br>模型回覆、選擇理由與工具結果。": "After you send a request, see model responses,\ntool-selection notes and tool results here.",
  "01 理解需求": "01 Understand",
  "02 呼叫工具": "02 Use tools",
  "03 整理結果": "03 Summarize",
  "保留實際狀態與耗時，不顯示私密推理或金鑰。": "Actual status and timing. Private reasoning and credentials stay hidden.",
  "SIGNET 首頁": "SIGNET home",
  "聊天": "Chat",
  "對話紀錄": "Conversation",
  "描述你的研究目的，或接著補充資料…": "Describe your research goal, or add more details…",
  "先介紹目前可以做的分析，以及各自需要哪些資料，暫時不要執行分析。": "Introduce the available analyses and the data each requires. Do not run any analyses yet.",
  "幫我查看目前專案有哪些資料檔案，以及已有工作的記錄狀態，暫時不要執行分析。": "Review this project’s data files and existing run records. Do not run any analyses yet.",
  "你": "You",
  "SIGNET 助手": "SIGNET assistant",
  "連線與計時細節": "Connection and timing details",
  "查看原執行紀錄": "View original activity log",
  "已恢復對話": "Conversation restored",
  "查詢完成": "Query complete",
  "工作已建立": "Run created",
  "程序已結束，分析有效性仍須核對": "Process ended; analysis validity still needs review",
  "已完成": "Complete",
  "僅完成準備": "Preparation only",
  "目前無法執行": "Unavailable",
  "條件不足": "Requirements not met",
  "參數無效": "Invalid parameters",
  "發生錯誤": "Error",
  "已中斷": "Interrupted",
  "已跳過": "Skipped",
  "狀態未知": "State unknown",
  "執行失敗": "Failed",
  "執行逾時": "Timed out",
  "已送出，待確認啟動": "Submitted; awaiting startup confirmation",
  "正在啟動": "Starting",
  "執行中": "Running",
  "已完成並通過輸出核對": "Completed; outputs verified",
  "輸出核對未通過": "Output verification failed",
  "已確認停止": "Stopped",
  "已執行": "Executed",
  "未執行": "Not executed",
  "未標示執行旗標，請依狀態判讀": "Execution flag not provided; check status",
  "等待免費額度": "Waiting for quota",
  "等待模型回覆": "Waiting for model response",
  "等待模型": "Waiting for model",
  "選擇工具的公開說明": "Tool-selection notes",
  "正在驗證參數並呼叫工具；參數值不顯示。": "Validating arguments and calling the tool. Argument values stay hidden.",
  "執行工具": "Running tool",
  "工具結果": "Tool result",
  "處理進度": "Progress",
  "處理回覆": "Processing response",
  "處理中…請查看聊天下方的執行過程。": "Working… See execution progress below the chat.",
  "連線中": "Connecting",
  "本機服務拒絕請求。": "The local service rejected the request.",
  "本回合已結束": "Turn finished",
  "需要確認": "Needs attention",
  "回合結束": "Turn finished",
  "連線已中斷；工具可能仍在執行。請核對工作狀態，避免重複操作。": "Connection interrupted. Tools may still be running. Check the run status before retrying.",
  "無法連線或連線中斷；請確認本機程式仍在執行。已啟動的工具可能繼續執行，請先核對狀態。": "Connection failed or interrupted. Check that the local server is running. Started tools may continue; check their status first.",
  "回合結束；分析是否成功請以工具狀態與回答為準。": "Turn finished. Check tool status and the answer to assess analysis success.",
  "回合發生非預期錯誤；操作狀態可能未知，請核對工作狀態後再繼續。": "Unexpected turn error. Operation status may be unknown; check the run status before continuing.",
  "僅允許本機介面。": "Only the local interface is allowed.",
  "找不到頁面。": "Page not found.",
  "找不到這段對話。": "Conversation not found.",
  "回合仍在執行，請保留原頁面等待完成。": "A turn is still running. Keep the original page open until it finishes.",
  "請從本機聊天頁面送出。": "Send requests from the local chat page.",
  "找不到此操作。": "Operation not found.",
  "訊息格式不正確，請輸入 1 至 8000 字。": "Invalid message. Enter 1–8000 characters.",
  "另一個回合仍在執行，請等候結束；關閉頁面不會取消工具。": "Another turn is running. Wait for it to finish; closing the page does not cancel tools.",
  "本次程式的對話數已達上限，請重新啟動本機介面。": "Session limit reached. Restart the local interface.",
  "模型完成文字回答。": "The model finished its answer.",
  "Codex 命令列：使用既有登入，僅產生回答或受控工具請求。": "Codex CLI: using the existing login to produce an answer or a controlled tool request.",
  "Codex 命令列：正在處理目前問題。": "Codex CLI: processing your request.",
  "決策摘要：模型未提供公開說明；以下僅顯示實際工具紀錄，不推測選擇原因。": "No public tool-selection note was provided. Only actual tool events are shown.",
  "決策摘要（模型提供的說明；本輪工具尚未執行，依據仍須對照實際紀錄）：": "Public tool-selection note (proposed tools have not run yet; check against actual records):",
  "摘要欄位不完整：模型未明確提供全部三項，不自行補寫。": "Incomplete public note. Missing fields are not inferred.",
  "模型只提供摘要、工具標記或空白內容；要求補答一次，已完成工具不重跑。": "The response contained only metadata or no answer. Requesting one answer repair; completed tools will not rerun.",
  "模型補答後仍未產生有效回答。": "Answer repair did not produce a valid answer.",
  "模型未提供其他回答。": "The model did not provide an additional answer.",
  "請檢查金鑰權限與模型存取資格；不會自動重試。": "Check key permissions and model access. No automatic retry.",
  "請核對模型名稱及此帳號可使用的模型；不會自動切換模型。": "Check the model name and account access. The model will not be switched automatically.",
  "請核對服務訊息中的請求格式、工具宣告或參數限制。": "Check request format, tool declarations and parameter limits in the service message.",
  "單次輸入內容超過服務上限；等待不會縮短內容，請減少輸入或開始新對話。": "The input exceeds the service limit. Waiting does not reduce it; reduce the input or start a new conversation.",
  "請檢查請求速率與配額，依服務提示等待後再繼續；已完成的工具結果仍保留。": "Check request rate and quota. Wait as advised by the service. Completed tool results are retained.",
  "服務端回報錯誤，可稍後重試；確切原因以服務訊息為準。": "The service reported an error. Try later; see the service message for details.",
  "未取得可判讀的服務狀態碼；請檢查連線或錯誤類別，不會自動重試。": "No interpretable service status code. Check the connection or error type. No automatic retry.",
  "請確認 Codex 命令列登入與用量；對話與已完成工具結果保留，不會重跑工具。": "Check Codex CLI login and usage. Conversation and completed tool results are retained; tools will not rerun.",
  "對話與已完成的工具結果仍保留；稍後可輸入「繼續」。": "The conversation and completed tool results are retained. Send “continue” when ready.",
  "單次模式不保留聊天紀錄；請先核對工作狀態後再重新執行。": "One-shot mode does not retain chat history. Check the run status before trying again.",
  "本次需求尚未呼叫任何工具。": "No tools have been called for this request.",
  "完整對話與工具結果仍保留；請縮小問題範圍或開啟新對話，原樣輸入「繼續」無法縮短請求。": "The full conversation and tool results are retained. Narrow the question or start a new conversation; “continue” does not reduce input size.",
  "已中斷等待模型；此回合未收到可執行的工具呼叫。": "Stopped waiting for the model. No executable tool call was received.",
  "已中斷等待模型；": "Stopped waiting for the model. ",
  "模型未回傳完整內容；這一輪的操作未執行。": "The model did not return complete content. No operations from this turn were executed.",
  "模型未產生有效回答；已完成的工具結果仍保留。": "The model did not produce a valid answer. Completed tool results are retained.",
  "模型補答時未遵守純文字要求；此次提出的工具未執行。": "The answer repair returned tool calls. Those calls were not executed.",
  "已達工具呼叫輪數上限；最後一輪提出的操作未執行。": "Tool-round limit reached. Operations proposed in the final round were not executed.",
  "單輪工具呼叫超過上限；這一輪的操作未執行。": "Too many tool calls in one round. No operations from that round were executed.",
  "工具已中斷或發生非預期錯誤；目前操作是否執行完成仍未知，後續操作未執行。請先核對工作狀態。": "A tool was interrupted or encountered an unexpected error. Completion is unknown; later operations were not executed. Check the run status first.",
  "輸入超過安全預算；未送出模型請求，未刪除使用者條件或工具證據。": "Input exceeds the safety budget. No model request was sent; user requirements and tool evidence were retained.",
  "找不到 Codex 命令列，請先安裝並執行 codex login。": "Codex CLI not found. Install it and run codex login.",
  "Codex 命令列等待逾時；已停止本次模型請求，未執行新工具。": "Codex CLI timed out. This model request was stopped; no new tools were executed.",
  "Codex 回覆格式異常；未執行新工具。": "Invalid Codex response format. No new tools were executed.",
  "Codex 回合失敗；請確認命令列登入與帳號用量，未執行新工具。": "Codex turn failed. Check CLI login and account usage. No new tools were executed.",
  "Codex 嘗試使用未允許的內建工具；已停止，本次不分派 SIGNET 工具。": "Codex attempted to use a disallowed built-in tool. Stopped; no SIGNET tools dispatched.",
  "Codex 命令列未完成有效回覆；請用 codex login status 檢查登入。": "Codex CLI did not produce a valid response. Check login with codex login status.",
  "Codex 命令列傳輸或回覆格式無效；未執行新工具。": "Invalid Codex CLI transport or response format. No new tools were executed."
};

let uiLanguage = 'en';
try { if (localStorage.getItem('signet-language') === 'zh-Hant') uiLanguage = 'zh-Hant'; } catch (_) {}
function translateUI(source, language = uiLanguage) {
  if (language === 'zh-Hant') return source;
  if (Object.hasOwn(uiEnglish, source)) return uiEnglish[source];
  if (source.includes('\n')) return source.split('\n').map(line => translateUI(line, language)).join('\n');
  const prefix = source.match(/^(目前進度|判讀提示|服務訊息|原因|缺少依賴|工具錯誤類別|工具錯誤)：(.*)$/);
  if (prefix) {
    const labels = {目前進度:'Progress',判讀提示:'Guidance',服務訊息:'Service message',原因:'Reason',缺少依賴:'Missing dependencies',工具錯誤類別:'Tool error type',工具錯誤:'Tool error'};
    return labels[prefix[1]] + ': ' + translateUI(prefix[2], language);
  }
  const patterns = [
    [/^模型請求失敗（(.*)）。$/, 'Model request failed ($1).'],
    [/^模型：(.*?)；模型請求 (\d+)\/(\d+)；耗時 ([\d.]+) 秒。$/, 'Model: $1; request $2/$3; duration $4 s.'],
    [/^模型請求 (\d+) 失敗（([\d.]+) 秒）；尚未執行此回合提出的任何工具。$/, 'Model request $1 failed ($2 s). No proposed tools have run.'],
    [/^本次需求已有 (\d+) 個工具結果；失敗發生在後續模型請求。$/, '$1 tool results are retained; a later model request failed.'],
    [/^已保留需求 (\d+)$/, 'Saved request $1'], [/^需求 (\d+)$/, 'Request $1'],
    [/^等待發送 · (\d+) 秒$/, 'Retrying in $1 s'], [/^([+]?\d+(?:\.\d+)?) 秒$/, '$1 s'],
    [/^工具 (\d+)\/(\d+)：(.*)$/, 'Tool $1/$2: $3'],
    [/^模型請求 (\d+)\/(\d+)：模型=(.*?)；訊息數=(\d+)；可用工具=(\d+)；等待回覆。$/, 'Model request $1/$2: model=$3; messages=$4; available tools=$5; awaiting response.'],
    [/^模型已回覆（([\d.]+) 秒）；提出 (\d+) 個工具呼叫。$/, 'Model responded ($1 s); requested $2 tool calls.'],
    [/^工具耗時：([\d.]+) 秒。$/, 'Tool duration: $1 s.'],
    [/^Codex 命令列：結構化回覆已驗證（([\d.]+) 秒）。$/, 'Codex CLI: structured response validated ($1 s).'],
    [/^已將 (\d+) 個工具結果加入對話，接著請求模型整理或選擇工具。$/, 'Added $1 tool results to the conversation. Requesting an answer or further tool selection.'],
    [/^新增或變動輸出檔案數：(\d+)（清單截斷=(.*?)）。$/, 'New or changed output files: $1 (list truncated=$2).']
  ];
  for (const [pattern, replacement] of patterns) if (pattern.test(source)) return source.replace(pattern, replacement);
  // Translate framework labels only; preserve scientific values, paths and raw evidence.
  let output = source;
  for (const [zh, en] of Object.entries(uiEnglish).sort((a,b) => b[0].length-a[0].length)) {
    if (zh.length > 2) output = output.split(zh).join(en);
  }
  return output.replace(/工具結果：/g,'Tool result: ').replace(/缺少依賴：/g,'Missing dependencies: ')
    .replace(/原因：/g,'Reason: ').replace(/工具錯誤類別：/g,'Tool error type: ')
    .replace(/工具錯誤：/g,'Tool error: ').replace(/服務訊息：/g,'Service message: ').replace(/目前進度：/g,'Progress: ').replace(/判讀提示：/g,'Guidance: ').replace(/選擇原因：/g,'Selection reason: ')
    .replace(/資訊依據：/g,'Evidence: ').replace(/尚缺資訊：/g,'Missing information: ');
}
function uiText(element, source) {
  element.dataset.i18n = source;
  element.textContent = translateUI(source);
}
function applyLanguage(language) {
  uiLanguage = language === 'zh-Hant' ? 'zh-Hant' : 'en';
  document.documentElement.lang = uiLanguage;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = translateUI(el.dataset.i18n); });
  for (const [key, attr] of [['i18nAria','aria-label'],['i18nPlaceholder','placeholder'],['i18nPrompt','data-prompt']]) {
    document.querySelectorAll(`[data-${key.replace(/[A-Z]/g, ch=>'-'+ch.toLowerCase())}]`).forEach(el => {
      el.setAttribute(attr, translateUI(el.dataset[key]));
    });
  }
  const toggle = document.getElementById('language-toggle');
  toggle.textContent = uiLanguage === 'en' ? '繁體中文' : 'English';
  toggle.setAttribute('aria-label', uiLanguage === 'en' ? 'Switch to Traditional Chinese' : '切換為英文');
  try { localStorage.setItem('signet-language', uiLanguage); } catch (_) {}
  window.dispatchEvent(new Event('languagechange'));
}
document.getElementById('language-toggle').addEventListener('click', () => applyLanguage(uiLanguage === 'en' ? 'zh-Hant' : 'en'));
applyLanguage(uiLanguage);
