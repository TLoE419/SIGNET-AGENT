import {useEffect, useRef, useState} from 'react';
import type {EnvironmentSnapshot} from '../../../shared/environment/types';

const items = [
  ['signet_source', 'SIGNET 程式碼', 'SIGNET source code'],
  ['container', 'SIGNET 容器', 'SIGNET container'],
  ['reference_ref', '參考面板', 'Reference panel'],
  ['reference_gmap', '遺傳圖譜', 'Genetic map'],
  ['reference_gtf', '基因註解', 'Gene annotation'],
  ['reference_clinical', '臨床資料', 'Clinical data'],
  ['imputation_reference', '補值參考檔', 'Imputation reference'],
] as const;

const statuses = {
  ok: ['已就緒', 'Ready'],
  missing: ['缺少', 'Missing'],
  problem: ['有問題', 'Problem'],
  in_progress: ['進行中', 'In progress'],
  unknown: ['未檢查', 'Not checked'],
} as const;

type Check = {item: string; status: keyof typeof statuses; detail?: string};
type CheckResponse = {status: string; checks?: Check[]; reason?: string; error?: string};

interface Props {
  english: boolean;
  active: boolean;
  connected: boolean;
  environment: EnvironmentSnapshot;
  onEnvironment: () => void;
}

export function RemoteReadiness({english, active, connected, environment, onEnvironment}: Props) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const phase = environment.phase;
  const preparing = ['checking', 'installing-source', 'verifying'].includes(phase);
  const label = (zh: string, en: string) => english ? en : zh;

  useEffect(() => {
    if (!active || !connected) setBusy(false);
    if (!connected) {
      setChecks(null);
      setError('');
    }
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [active, connected]);

  async function inspect() {
    if (!active || !connected || preparing || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setChecks(null);
    setError('');
    try {
      const token = document.querySelector<HTMLMetaElement>('meta[name="chat-token"]')?.content;
      const reply = await fetch('/hpc/check', {
        method: 'POST', body: '{}', signal: controller.signal,
        headers: {'Content-Type': 'application/json', 'X-Chat-Token': token ?? ''},
      });
      const result: CheckResponse = await reply.json();
      if (controller.signal.aborted) return;
      if (!reply.ok || result.status !== 'ok' || !Array.isArray(result.checks)) {
        setError(result.reason || result.error || 'unavailable');
      } else {
        setChecks(result.checks);
      }
    } catch {
      if (!controller.signal.aborted) setError('unavailable');
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }

  const rows = items.map(([id, zh, en]) => ({id, name: label(zh, en), check: connected ? checks?.find(row => row.item === id) : undefined}));
  const ready = rows.filter(({check}) => check?.status === 'ok').length;
  let summary = label('按「重新檢查」查看檔案和環境狀態。', 'Select Check again to inspect the remote files and environment.');
  if (!connected) summary = label('連線後可檢查遠端環境。', 'Connect to check the remote environment.');
  else if (busy || preparing) summary = label('正在檢查遠端環境…', 'Checking the remote environment…');
  else if (error === 'unavailable') summary = label('目前無法檢查遠端環境。', 'The remote environment check is unavailable.');
  else if (error) summary = error;
  else if (checks) summary = label(`${ready}/${rows.length} 項就緒。`, `${ready}/${rows.length} ready.`);
  else if (phase === 'ready') summary = label('環境已就緒，可再檢查檔案。', 'Environment ready. You can also check the input files.');
  else if (phase === 'needs-install') summary = label('還有遠端資源需要準備。', 'Some remote resources still need setup.');
  else if (phase === 'blocked' || phase === 'error') summary = environment.message;

  return <section className="ml-settings-block ml-remote-readiness" data-phase={phase} aria-labelledby="ml-readiness-title">
    <div className="ml-settings-check-heading">
      <h4 id="ml-readiness-title">{label('環境就緒檢查', 'Environment readiness')}</h4>
      <button type="button" className="ml-settings-action" id="ml-check-environment" disabled={!active || !connected || busy || preparing} onClick={() => void inspect()}>
        {label('重新檢查', 'Check again')}
      </button>
    </div>
    <p className="ml-settings-note" id="ml-check-summary" role="status">{summary}</p>
    <ul className="ml-settings-checks" id="ml-environment-checks">
      {rows.map(({id, name, check}) => <li key={id}>
        <span>{name}</span>
        <span className="ml-settings-status" data-ready={check?.status === 'ok'} title={check?.detail}>
          {(statuses[check?.status ?? 'unknown'] ?? statuses.unknown)[english ? 1 : 0]}
        </span>
      </li>)}
    </ul>
    {connected && <button type="button" className="ml-settings-action" onClick={onEnvironment}>
      {label('遠端環境設定', 'Remote environment settings')}
    </button>}
  </section>;
}
