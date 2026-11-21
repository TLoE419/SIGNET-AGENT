import {useEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {SshControls} from '../ssh/SshControls';
import {RemoteReadiness} from './RemoteReadiness';

const statusLabels = {
  unconfigured: 'Not configured',
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnecting: 'Disconnecting…',
  error: 'Connection error',
} as const;

export function WorkspaceSshSettings({readiness, pane, sidebar}: {
  readiness: HTMLElement;
  pane: HTMLElement;
  sidebar: HTMLElement;
}) {
  const [active, setActive] = useState(!pane.hidden && !sidebar.hidden);
  useEffect(() => {
    const update = () => {
      setActive(!pane.hidden && !sidebar.hidden);
    };
    const observer = new MutationObserver(update);
    observer.observe(pane, {attributeFilter: ['hidden']});
    observer.observe(sidebar, {attributeFilter: ['hidden']});
    update();
    return () => observer.disconnect();
  }, [pane, sidebar]);

  return <SshControls terminalActive={active} renderStatus={({host, status, phase, error, busy, environment, onEdit, onToggle, onEnvironment, onVerifyEnvironment}) => {
    const connected = status === 'connected';
    const connecting = status === 'connecting';
    const slow = phase === 'slow';
    const label = slow ? 'Verification incomplete' : statusLabels[status];
    const action = connected ? 'Disconnect remote session'
      : connecting ? 'Cancel remote connection' : 'Connect to remote server';
    const edit = 'Connection settings';
    return <>
      <div className="ml-settings-connection">
        <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/>
          <path d="M6 6h.01M6 18h.01"/>
        </svg>
        <strong>HPC3</strong>
        <span className="ml-settings-status" id="ml-remote-status" data-status={status} data-ready={connected && !slow} role="status">
          {label}
        </span>
        <button type="button" className="ml-remote-switch" id="ml-remote-switch" role="switch" aria-checked={connected}
          aria-label={action} title={action} disabled={status === 'disconnecting' || (busy && !connecting)} onClick={onToggle}>
          <span aria-hidden="true" />
        </button>
      </div>
      <div className="ml-connection-details">
        {status !== 'unconfigured' && <small title={host}>{host}</small>}
        <button type="button" className="ml-settings-action" onClick={onEdit}>{edit}</button>
      </div>
      {error && <p className="ml-settings-note" role="alert">{error.message}</p>}
      {createPortal(<RemoteReadiness {...{active, connected, environment, onEnvironment}} connectionIdentity={host}
        onVerify={onVerifyEnvironment}/>, readiness)}
    </>;
  }}/>;
}
