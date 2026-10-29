export function ModeIcon({kind}:{kind:'duo'|'key'|'create'|'import'}){
 return <svg className="ssh-mode-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
  {kind==='duo'?<><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z"/><path d="m8 12 3 3 5-6"/></>:kind==='key'?<><circle cx="8" cy="8" r="5"/><path d="m12 12 9 9M16 16l3-3M19 19l3-3"/><circle cx="7" cy="7" r=".7"/></>:kind==='create'?<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 15h8M12 11v8"/></>:<><path d="M3 8V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v3M3 11h18l-2 10H5zM12 8v9m-3-3 3 3 3-3"/></>}
 </svg>;
}
