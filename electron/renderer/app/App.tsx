import {ModelControls} from '../features/model/ModelControls';
import {SshControls} from '../features/ssh/SshControls';

// Stable shell. Chat and graph controllers own their dynamic DOM regions.
export function App({model}:{model:string}){
 return <>
  <aside className="rail">
    <a className="brand" href="/" aria-label="SIGNET home" data-i18n-aria="SIGNET 首頁"><span className="logo">S</span><span>SIGNET<small><span data-i18n="研究工作台">Research workspace</span></small></span></a>
    <button id="new-chat" className="new-chat"><span data-i18n="＋ 開始新對話">+ New chat</span></button>
    <div className="nav-label"><span data-i18n="工作空間">WORKSPACE</span></div>
    <div className="nav-item active"><span>◉</span> <span data-i18n="研究助手">Research assistant</span> <span className="nav-dot"></span></div>
    <button id="s6-open" className="nav-item nav-button" type="button" aria-controls="stage6-pane" aria-expanded="false" hidden><span id="s6-open-label">Network visualization</span></button>
    <div id="chat-list-label" className="nav-label" data-i18n="聊天紀錄">CHATS</div>
    <nav id="chat-list" className="chat-list" aria-label="Saved conversations" data-i18n-aria="已存對話"></nav>
    <div className="environment"><span className="local-dot"></span> <span data-i18n="本機工作階段">Local session</span><small>{model}</small></div>
    <button id="language-toggle" type="button" aria-label="Switch to Traditional Chinese">繁體中文</button>
  </aside>
  <main>
    <div className="ssh-topbar ssh-ui-root" id="ssh-root"><SshControls/><ModelControls bridge={(window as any).signetDesktop.model}/></div>
    <div className="workspace chat-only">
      <section className="chat-pane" aria-label="Chat" data-i18n-aria="聊天">

        <details id="workflow" className="workflow">
          <summary><span data-i18n="分析流程">Workflow</span><span id="workflow-summary" className="workflow-summary" data-i18n="展開以檢查 HPC3 環境">Open to check HPC3</span></summary>
          <ol className="workflow-stages">
            <li className="workflow-stage" data-stage="environment">
              <details id="workflow-environment" open>
                <summary className="workflow-stage-head"><span className="workflow-step">1</span><strong data-i18n="準備環境">Prepare environment</strong><span id="workflow-environment-status" className="workflow-note"></span></summary>
                <div className="workflow-stage-body">
                  <div className="workflow-stage-actions"><button type="button" onClick={()=>window.dispatchEvent(new Event('open-environment'))} data-i18n="HPC3 設定">HPC3 settings</button><button id="workflow-check" type="button" data-i18n="重新檢查">Check again</button></div>
                  <ul id="workflow-items" className="workflow-items"></ul>
                  <p id="workflow-message" className="workflow-message" role="status" hidden={true}></p>
                </div>
              </details>
            </li>
            <li className="workflow-stage locked" data-stage="preprocess">
              <details>
                <summary className="workflow-stage-head"><span className="workflow-step">2</span><strong data-i18n="資料前處理">Data preprocessing</strong></summary>
                <p className="workflow-stage-body workflow-note" >Not implemented in this version</p>
              </details>
            </li>
            <li className="workflow-stage locked" data-stage="results">
              <details>
                <summary className="workflow-stage-head"><span className="workflow-step">3</span><strong data-i18n="分析與結果">Analysis and results</strong></summary>
                <p className="workflow-stage-body workflow-note" >Not implemented in this version</p>
              </details>
            </li>
          </ol>
        </details>
        <div id="messages" className="messages" role="log" aria-label="Conversation" data-i18n-aria="對話紀錄" aria-live="polite">
          <div id="welcome" className="welcome"><span className="welcome-mark">✳</span><h2><span data-i18n="今天想探索什麼？">What would you like to explore?</span></h2><p><span data-i18n="從一個研究問題開始。<br>聊天下方可查看執行過程，右側可比較網路結果。">Start with a research question.<br/>See chat activity below and compare networks on the right.</span></p><p><span data-i18n="此版本未附資料或分析結果。聊天需登入模型；科學分析另需來源、資料與執行環境。">No data or analysis results are bundled. Chat requires model sign-in; scientific analysis also requires source code, data and a configured runtime.</span></p><div className="suggestions"><button data-prompt="Introduce the available analyses and the data each requires. Do not run any analyses yet." data-i18n-prompt="先介紹目前可以做的分析，以及各自需要哪些資料，暫時不要執行分析。"><span data-i18n="了解分析能力">Explore analyses</span> <span>↗</span></button><button data-prompt="Review this project’s data files and existing run records. Do not run any analyses yet." data-i18n-prompt="幫我查看目前專案有哪些資料檔案，以及已有工作的記錄狀態，暫時不要執行分析。"><span data-i18n="檢查目前資料與工作">Review data and runs</span> <span>↗</span></button></div></div>
        </div>
        <details id="analysis-tracking" className="analysis-tracking" hidden>
          <summary><span data-i18n="追蹤既有分析">Track an existing analysis</span></summary>
          <form id="analysis-link-form">
            <label className="sr-only" htmlFor="analysis-run"><span data-i18n="選擇分析">Select analysis</span></label>
            <select id="analysis-run" required></select>
            <button type="submit" id="analysis-link" disabled><span data-i18n="連結到此對話">Link to this conversation</span></button>
          </form>
          <p id="analysis-link-status" role="status" hidden></p>
        </details>
        <details id="chat-progress" className="chat-progress" hidden>
          <summary><span data-i18n="執行過程">Activity</span><span id="state" role="status" data-i18n="等待需求">Ready</span></summary>
          <div id="activity" className="activity"><div id="activity-empty" className="activity-empty"><div className="empty-path"><i></i><i></i><i></i></div><h3><span data-i18n="每一步，都有跡可循">Follow every step</span></h3><p><span data-i18n="送出需求後，這裡會依序顯示<br>模型回覆、選擇理由與工具結果。">After you send a request, see model responses,<br/>tool-selection notes and tool results here.</span></p><div className="legend"><span><span data-i18n="01 理解需求">01 Understand</span></span><span><span data-i18n="02 呼叫工具">02 Use tools</span></span><span><span data-i18n="03 整理結果">03 Summarize</span></span></div></div></div>
        </details>
        <form id="composer"><label className="sr-only" htmlFor="prompt"><span data-i18n="輸入研究需求">Enter your research request</span></label><textarea id="prompt" rows={2} maxLength={8000} placeholder="Describe your research goal, or add more details…" data-i18n-placeholder="描述你的研究目的，或接著補充資料…" required></textarea><div className="composer-bottom"><span><span data-i18n="Enter 送出 · Shift + Enter 換行">Enter to send · Shift + Enter for a new line</span></span><button id="send" type="submit"><span data-i18n="送出">Send</span> <span>↑</span></button></div></form>
        <p className="footnote"><span data-i18n="送出後會使用目前模型帳號的額度。關閉頁面不會取消已啟動的工具。">Sending uses your model account quota. Closing this page does not cancel running tools.</span></p>
      </section>
      <section id="stage6-pane" className="activity-pane stage6-pane" aria-label="Stage 6 workspace" hidden>
        <div className="pane-title"><h2>Stage 6 · <span data-i18n="網路視覺化">Network visualization</span></h2><div className="s6-pane-actions"><button id="s6-close" type="button" aria-controls="stage6-pane" aria-expanded="true">Collapse</button></div></div>
        <div className="stage6-tabs" role="tablist" aria-label="Workspace tabs"><button id="s6-parameters-tab" role="tab" data-tab="parameters" aria-selected="true">Parameters</button><button id="s6-comparison-tab" role="tab" data-tab="comparison" aria-selected="false">Comparison</button><button id="s6-history-tab" role="tab" data-tab="history" aria-selected="false">Run history</button></div>
        <div id="s6-error" role="alert" hidden></div>
        <div id="s6-parameters" className="s6-content" role="tabpanel"></div>
        <div id="s6-comparison" className="s6-content" role="tabpanel" hidden></div>
        <div id="s6-history" className="s6-content" role="tabpanel" hidden></div>
        <div className="activity-footer"><span className="local-dot"></span> <span data-i18n="保留實際狀態與耗時，不顯示私密推理或金鑰。">Actual status and timing. Private reasoning and credentials stay hidden.</span></div>
      </section>
    </div>
  </main>

</>;
}
