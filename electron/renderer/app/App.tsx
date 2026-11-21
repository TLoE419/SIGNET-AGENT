import {ModelControls} from '../features/model/ModelControls';
import {SshControls} from '../features/ssh/SshControls';

// Stable shell. Chat and graph controllers own their dynamic DOM regions.
export function App({model}:{model:string}){
 return <>
  <aside className="rail">
    <a className="brand" href="/classic" aria-label="SIGNET home"><span className="logo">S</span><span>SIGNET<small><span>Research workspace</span></small></span></a>
    <button id="new-chat" className="new-chat"><span>+ New chat</span></button>
    <div className="nav-label"><span>WORKSPACE</span></div>
    <div className="nav-item active"><span>◉</span> <span>Research assistant</span> <span className="nav-dot"></span></div>
    <button id="s6-open" className="nav-item nav-button" type="button" aria-controls="stage6-pane" aria-expanded="false" hidden><span id="s6-open-label">Network visualization</span></button>
    <div id="chat-list-label" className="nav-label">CHATS</div>
    <nav id="chat-list" className="chat-list" aria-label="Saved conversations"></nav>
    <div className="environment"><span className="local-dot"></span> <span>Local session</span><small>{model}</small></div>
  </aside>
  <main>
    <div className="ssh-topbar ssh-ui-root" id="ssh-root"><SshControls/><ModelControls bridge={(window as any).signetDesktop.model}/></div>
    <div className="workspace chat-only">
      <section className="chat-pane" aria-label="Chat">

        <details id="workflow" className="workflow">
          <summary><span>Workflow</span><span id="workflow-summary" className="workflow-summary">Open to check HPC3</span></summary>
          <ol className="workflow-stages">
            <li className="workflow-stage" data-stage="environment">
              <details id="workflow-environment" open>
                <summary className="workflow-stage-head"><span className="workflow-step">1</span><strong>Prepare environment</strong><span id="workflow-environment-status" className="workflow-note"></span></summary>
                <div className="workflow-stage-body">
                  <div className="workflow-stage-actions"><button type="button" onClick={()=>window.dispatchEvent(new Event('open-environment'))}>HPC3 settings</button><button id="workflow-check" type="button">Check again</button></div>
                  <ul id="workflow-items" className="workflow-items"></ul>
                  <p id="workflow-message" className="workflow-message" role="status" hidden={true}></p>
                </div>
              </details>
            </li>
            <li className="workflow-stage locked" data-stage="preprocess">
              <details>
                <summary className="workflow-stage-head"><span className="workflow-step">2</span><strong>Data preprocessing</strong></summary>
                <p className="workflow-stage-body workflow-note" >Not implemented in this version</p>
              </details>
            </li>
            <li className="workflow-stage locked" data-stage="results">
              <details>
                <summary className="workflow-stage-head"><span className="workflow-step">3</span><strong>Analysis and results</strong></summary>
                <p className="workflow-stage-body workflow-note" >Not implemented in this version</p>
              </details>
            </li>
          </ol>
        </details>
        <div id="messages" className="messages" role="log" aria-label="Conversation" aria-live="polite">
          <div id="welcome" className="welcome"><span className="welcome-mark">✳</span><h2><span>What would you like to explore?</span></h2><p><span>Start with a research question.<br/>See chat activity below and compare networks on the right.</span></p><p><span>No data or analysis results are bundled. Chat requires model sign-in; scientific analysis also requires source code, data and a configured runtime.</span></p><div className="suggestions"><button data-prompt="Introduce the available analyses and the data each requires. Do not run any analyses yet."><span>Explore analyses</span> <span>↗</span></button><button data-prompt="Review this project’s data files and existing run records. Do not run any analyses yet."><span>Review data and runs</span> <span>↗</span></button></div></div>
        </div>
        <details id="chat-progress" className="chat-progress" hidden>
          <summary><span>Activity</span><span id="state" role="status">Ready</span></summary>
          <div id="activity" className="activity"><div id="activity-empty" className="activity-empty"><div className="empty-path"><i></i><i></i><i></i></div><h3><span>Follow every step</span></h3><p><span>After you send a request, see model responses,<br/>tool-selection notes and tool results here.</span></p><div className="legend"><span><span>01 Understand</span></span><span><span>02 Use tools</span></span><span><span>03 Summarize</span></span></div></div></div>
        </details>
        <form id="composer"><label className="sr-only" htmlFor="prompt"><span>Enter your research request</span></label><textarea id="prompt" rows={2} maxLength={8000} placeholder="Describe your research goal, or add more details…" required></textarea><div className="composer-bottom"><span><span>Enter to send · Shift + Enter for a new line</span></span><button id="send" type="submit"><span>Send</span> <span>↑</span></button></div></form>
        <p className="footnote"><span>Sending uses your model account quota. Closing this page does not cancel running tools.</span></p>
      </section>
      <section id="stage6-pane" className="activity-pane stage6-pane" aria-label="Stage 6 workspace" hidden>
        <div className="pane-title"><h2>Stage 6 · <span>Network visualization</span></h2><div className="s6-pane-actions"><button id="s6-close" type="button" aria-controls="stage6-pane" aria-expanded="true">Collapse</button></div></div>
        <div className="stage6-tabs" role="tablist" aria-label="Workspace tabs"><button id="s6-parameters-tab" role="tab" data-tab="parameters" aria-selected="true">Parameters</button><button id="s6-comparison-tab" role="tab" data-tab="comparison" aria-selected="false">Comparison</button><button id="s6-history-tab" role="tab" data-tab="history" aria-selected="false">Run history</button></div>
        <div id="s6-error" role="alert" hidden></div>
        <div id="s6-parameters" className="s6-content" role="tabpanel"></div>
        <div id="s6-comparison" className="s6-content" role="tabpanel" hidden></div>
        <div id="s6-history" className="s6-content" role="tabpanel" hidden></div>
        <div className="activity-footer"><span className="local-dot"></span> <span>Actual status and timing. Private reasoning and credentials stay hidden.</span></div>
      </section>
    </div>
  </main>

</>;
}
