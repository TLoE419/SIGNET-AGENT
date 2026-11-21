import {ModelControls, type ModelBridge} from '../model/ModelControls';

export function WorkspaceModelSettings({bridge, model}: {bridge: ModelBridge; model: string}) {
 return <ModelControls bridge={bridge} model={model} workspace/>;
}
