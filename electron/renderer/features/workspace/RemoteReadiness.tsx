import {useEffect, useRef, useState} from 'react';
import type {EnvironmentSnapshot} from '../../../shared/environment/types';

const items = [
  ['connection', '遠端連線', 'Remote connection'],
  ['workspace', '工作目錄', 'Workspace directory'],
  ['slurm', '工作排程器', 'Job scheduler'],
  ['apptainer', '容器執行環境', 'Container runtime'],
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

type Check = {item: string; status: keyof typeof statuses; detail: string};
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;

/** A green service summary must agree with every required, uniquely identified check. */
export function normalizeReadiness(value: unknown, english = false) {
  const label = (zh: string, en: string) => english ? en : zh;
  const result = record(value);
  if (result?.status !== 'ok') return {
    checks: items.map(([item]): Check => ({item, status: 'unknown', detail: ''})),
    issues: [label('遠端環境檢查尚未成功完成。', 'The remote environment check did not complete successfully.')],
    detail: [result?.reason, result?.error, result?.detail]
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).join(' '),
    ready: false,
  };
  const issues: string[] = [];
  const known = new Set<string>(items.map(([id]) => id));
  const received = new Map<string, RecordValue[]>();
  if (!Array.isArray(result?.checks)) issues.push(label('服務未回傳有效的檢查清單。', 'The service did not return a valid check list.'));
  else for (const raw of result.checks) {
    const check = record(raw);
    if (!check || typeof check.item !== 'string' || !known.has(check.item)) {
      issues.push(label('檢查清單包含無效或未識別的項目：', 'Invalid or unrecognized check item: ') +
        (typeof check?.item === 'string' ? check.item : label('無法識別', 'unidentified')));
      continue;
    }
    const matches = received.get(check.item) ?? [];
    matches.push(check);
    received.set(check.item, matches);
  }
  const checks: Check[] = items.map(([item]) => {
    const matches = received.get(item) ?? [];
    if (!matches.length) return {item, status: 'unknown', detail: label('服務未回傳這項必要檢查的結果。', 'No result was returned for this required check.')};
    if (matches.length > 1) return {item, status: 'problem', detail: [
      label('服務回傳了重複的檢查結果。', 'The service returned duplicate check results.'),
      ...matches.map(check => typeof check.detail === 'string' ? check.detail : '').filter(Boolean),
    ].join(' ')};
    const check = matches[0];
    if (typeof check.status !== 'string' || !Object.hasOwn(statuses, check.status) ||
        check.detail !== undefined && typeof check.detail !== 'string') {
      return {item, status: 'problem', detail: label('服務回傳的狀態或說明格式無效。', 'The service returned an invalid status or detail.') +
        (typeof check.detail === 'string' ? ' ' + check.detail : '')};
    }
    const status = check.status as Check['status'];
    return {item, status, detail: typeof check.detail === 'string' && check.detail.trim() ? check.detail :
      status === 'ok' ? '' : label('服務未提供其他原因。', 'The service did not provide an additional reason.')};
  });
  const blocked = checks.filter(check => check.status !== 'ok').map(check => check.item);
  const notReady = result?.not_ready;
  if (!Array.isArray(notReady) || notReady.some(id => typeof id !== 'string' || !known.has(id)) ||
      new Set(notReady).size !== notReady.length) {
    issues.push(label('服務的未就緒項目清單無效。', 'The service returned an invalid list of checks needing attention.'));
  } else if (blocked.length !== notReady.length || blocked.some(id => !notReady.includes(id))) {
    issues.push(label('服務摘要與各項檢查結果不一致。', 'The service summary disagrees with the individual check results.'));
  }
  if (result?.ready !== true) issues.push(result?.ready === false
    ? label('服務回報環境尚未就緒。', 'The service reports that the environment is not ready.')
    : label('服務尚未確認環境已就緒。', 'The service has not confirmed that the environment is ready.'));
  else if (blocked.length) issues.push(label('服務回報已就緒，但仍有必要項目未通過檢查。', 'The service reports ready while required checks still need attention.'));
  if (typeof result?.error === 'string' && result.error) issues.push(result.error);
  const detail = [result?.reason, result?.detail].filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).join(' ');
  return {checks, issues: [...new Set(issues)], detail, ready: !issues.length && !blocked.length};
}

interface Props {
  english: boolean;
  active: boolean;
  connected: boolean;
  connectionIdentity?: string;
  environment: EnvironmentSnapshot;
  onEnvironment: () => void;
}

type Inspection = {scope: string; value: unknown; error: string; busy: boolean};

export function RemoteReadiness({english, active, connected, connectionIdentity = '', environment, onEnvironment}: Props) {
  const [inspection, setInspection] = useState<Inspection>({scope: '', value: undefined, error: '', busy: false});
  const request = useRef<{scope: string; controller: AbortController} | null>(null);
  const phase = environment.phase;
  const preparing = ['checking', 'installing-source', 'verifying'].includes(phase);
  const environmentBlocked = ['blocked', 'error', 'needs-install', 'disconnected'].includes(phase);
  const config = environment.config;
  const scope = JSON.stringify([active, connected, connectionIdentity, phase, environment.checkedAt,
    config?.root, config?.source, config?.image, config?.executor, config?.runtimeModule,
    config?.workRoot, config?.revision, config?.partition]);
  const available = active && connected && !preparing;
  const current = inspection.scope === scope ? inspection : null;
  const label = (zh: string, en: string) => english ? en : zh;

  async function inspect() {
    if (!available || request.current) return;
    const pending = {scope, controller: new AbortController()};
    request.current = pending;
    setInspection({scope, value: undefined, error: '', busy: true});
    try {
      const token = document.querySelector<HTMLMetaElement>('meta[name="chat-token"]')?.content;
      const reply = await fetch('/hpc/check', {
        method: 'POST', body: '{}', signal: pending.controller.signal,
        headers: {'Content-Type': 'application/json', 'X-Chat-Token': token ?? ''},
      });
      const value: unknown = await reply.json();
      if (pending.controller.signal.aborted || request.current !== pending) return;
      const result = record(value);
      setInspection({scope, value: reply.ok ? value : undefined, busy: false,
        error: reply.ok ? '' : typeof result?.reason === 'string' ? result.reason
          : typeof result?.error === 'string' ? result.error : 'unavailable'});
    } catch {
      if (!pending.controller.signal.aborted && request.current === pending) {
        setInspection({scope, value: undefined, error: 'unavailable', busy: false});
      }
    } finally {
      if (request.current === pending) request.current = null;
    }
  }

  useEffect(() => {
    request.current?.controller.abort();
    request.current = null;
    setInspection({scope, value: undefined, error: '', busy: false});
    if (available) void inspect();
    return () => {
      if (request.current?.scope === scope) {
        request.current.controller.abort();
        request.current = null;
      }
    };
  }, [scope, available]);

  const report = current && current.value !== undefined ? normalizeReadiness(current.value, english) : null;
  const rows = items.map(([id, zh, en]) => ({id, name: label(zh, en),
    check: report?.checks.find(check => check.item === id)}));
  const ready = rows.filter(({check}) => check?.status === 'ok').length;
  const allReady = available && !environmentBlocked && Boolean(report?.ready);
  let summary = label('開啟設定後會自動檢查，也可按「重新檢查」。', 'Checks run when Settings is open. You can also select Check again.');
  if (!connected) summary = label('連線後可檢查遠端環境。', 'Connect to check the remote environment.');
  else if (current?.busy || preparing) summary = label('正在檢查遠端環境…', 'Checking the remote environment…');
  else if (current?.error) summary = current.error === 'unavailable'
    ? label('目前無法檢查遠端環境，請重新檢查。', 'The remote environment check is unavailable. Check again.') : current.error;
  else if (report) summary = allReady
    ? label(`${ready}/${rows.length} 項就緒，環境檢查已通過。`, `${ready}/${rows.length} ready. All environment checks passed.`)
    : label(`${ready}/${rows.length} 項通過檢查，環境尚未就緒。`, `${ready}/${rows.length} checks passed. The environment is not ready.`);
  const environmentReason = connected && environmentBlocked ? environment.message ||
    label('遠端環境設定尚未通過驗證。', 'Remote environment settings have not passed verification.') : '';
  const problems = [...new Set([...(report?.issues ?? []), report?.detail, environmentReason]
    .filter((message): message is string => Boolean(message) && message !== summary))];

  return <section className="ml-settings-block ml-remote-readiness" data-phase={phase} data-ready={allReady} aria-labelledby="ml-readiness-title">
    <div className="ml-settings-check-heading">
      <h4 id="ml-readiness-title">{label('環境就緒檢查', 'Environment readiness')}</h4>
      <button type="button" className="ml-settings-action" id="ml-check-environment" disabled={!available || Boolean(current?.busy)} onClick={() => void inspect()}>
        {label('重新檢查', 'Check again')}
      </button>
    </div>
    <p className="ml-settings-note" id="ml-check-summary" role="status">{summary}
      {problems.map(message => <span key={message}> {message}</span>)}
    </p>
    <ul className="ml-settings-checks" id="ml-environment-checks">
      {rows.map(({id, name, check}) => <li key={id} data-check-id={id} data-status={check?.status ?? 'unknown'}>
        <span>{name}</span>
        <span className="ml-settings-status" data-ready={check?.status === 'ok'}>
          {statuses[check?.status ?? 'unknown'][english ? 1 : 0]}
        </span>
        {check?.detail && <p className="ml-settings-check-detail">{check.detail}</p>}
      </li>)}
    </ul>
    {connected && <button type="button" className="ml-settings-action" onClick={onEnvironment}>
      {label('遠端環境設定', 'Remote environment settings')}
    </button>}
  </section>;
}
