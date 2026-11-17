import {useEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {SshControls} from '../ssh/SshControls';
import {RemoteReadiness} from './RemoteReadiness';

const statusLabels = {
  unconfigured: ['未設定', 'Not configured'],
  disconnected: ['未連線', 'Disconnected'],
  connecting: ['連線中…', 'Connecting…'],
  connected: ['已連線', 'Connected'],
  disconnecting: ['斷線中…', 'Disconnecting…'],
  error: ['連線異常', 'Connection error'],
} as const;

export function WorkspaceSshSettings({workspace, readiness, pane, sidebar}: {
  workspace: HTMLElement;
  readiness: HTMLElement;
  pane: HTMLElement;
  sidebar: HTMLElement;
}) {
  const [english, setEnglish] = useState(workspace.lang === 'en');
  const [active, setActive] = useState(!pane.hidden && !sidebar.hidden);
  useEffect(() => {
    const update = () => {
      setEnglish(workspace.lang === 'en');
      setActive(!pane.hidden && !sidebar.hidden);
    };
    const observer = new MutationObserver(update);
    observer.observe(workspace, {attributeFilter: ['lang']});
    observer.observe(pane, {attributeFilter: ['hidden']});
    observer.observe(sidebar, {attributeFilter: ['hidden']});
    update();
    return () => observer.disconnect();
  }, [workspace, pane, sidebar]);

  return <SshControls renderStatus={({host, status, phase, error, busy, environment, onEdit, onToggle, onEnvironment}) => {
    const connected = status === 'connected';
    const connecting = status === 'connecting';
    const slow = phase === 'slow';
    const labels = slow ? ['驗證尚未完成', 'Verification incomplete'] : statusLabels[status];
    const action = connected ? ['中斷遠端連線', 'Disconnect remote session']
      : connecting ? ['取消遠端連線', 'Cancel remote connection'] : ['連線到遠端', 'Connect to remote server'];
    const edit = english ? 'Connection settings' : '連線設定';
    return <>
      <div className="ml-settings-connection">
        <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/>
          <path d="M6 6h.01M6 18h.01"/>
        </svg>
        <strong>HPC3</strong>
        <span className="ml-settings-status" id="ml-remote-status" data-status={status} data-ready={connected && !slow} role="status">
          {labels[english ? 1 : 0]}
        </span>
        <button type="button" className="ml-remote-switch" id="ml-remote-switch" role="switch" aria-checked={connected}
          aria-label={action[english ? 1 : 0]} title={action[english ? 1 : 0]} disabled={status === 'disconnecting' || (busy && !connecting)} onClick={onToggle}>
          <span aria-hidden="true" />
        </button>
      </div>
      <div className="ml-connection-details">
        {status !== 'unconfigured' && <small title={host}>{host}</small>}
        <button type="button" className="ml-settings-action" onClick={onEdit}>{edit}</button>
      </div>
      {error && <p className="ml-settings-note" role="alert">{error.message}</p>}
      {createPortal(<RemoteReadiness {...{english, active, connected, environment, onEnvironment}} connectionIdentity={host}/>, readiness)}
    </>;
  }}/>;
}
