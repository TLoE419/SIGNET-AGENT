import {useEffect, useState} from 'react';
import {ModelControls, type ModelBridge} from '../model/ModelControls';

export function WorkspaceModelSettings({workspace, bridge, model}: {workspace: HTMLElement; bridge: ModelBridge; model: string}) {
 const [english, setEnglish] = useState(workspace.lang === 'en');
 useEffect(() => {
  const observer = new MutationObserver(() => setEnglish(workspace.lang === 'en'));
  observer.observe(workspace, {attributeFilter: ['lang']});
  return () => observer.disconnect();
 }, [workspace]);
 return <ModelControls bridge={bridge} model={model} english={english} workspace/>;
}
