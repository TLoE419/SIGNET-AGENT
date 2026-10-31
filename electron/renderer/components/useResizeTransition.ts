import {useEffect,type RefObject} from 'react';

/** Animate intrinsic dialog size changes while leaving the final layout CSS-owned. */
export function useResizeTransition(surface:RefObject<HTMLElement|null>,content:RefObject<HTMLElement|null>,open:boolean){
 useEffect(()=>{
  const element=surface.current,body=content.current;
  if(!open||!element||!body||typeof ResizeObserver==='undefined'||!element.animate)return;
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  let animation:Animation|undefined;
  let previous=element.getBoundingClientRect();
  const observer=new ResizeObserver(()=>{
   const current=element.getBoundingClientRect();
   animation?.cancel();
   const next=element.getBoundingClientRect();
   if(!reduced.matches&&(Math.abs(next.height-previous.height)>1||Math.abs(next.width-previous.width)>1)){
    animation=element.animate([
     {height:`${animation?current.height:previous.height}px`,width:`${animation?current.width:previous.width}px`},
     {height:`${next.height}px`,width:`${next.width}px`},
    ],{duration:220,easing:'cubic-bezier(.2,.8,.2,1)'});
   }
   previous=next;
  });
  observer.observe(body);
  const stop=()=>{if(reduced.matches)animation?.cancel()};
  reduced.addEventListener('change',stop);
  return()=>{observer.disconnect();animation?.cancel();reduced.removeEventListener('change',stop)};
 },[surface,content,open]);
}
