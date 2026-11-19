// Opt-in test evidence only. Bounded per page; no timers, Promise handlers, or product state writes.
(() => {
  const value = window.__subjectEvidence = { origin: performance.timeOrigin, events: [], animations: [], changes: [] };
  const push = (key, entry) => { if (value[key].length < 3000) value[key].push({ now: performance.now(), ...entry }); };
  const describe = e => e instanceof Element ? { tag: e.tagName, attributes: Object.fromEntries([...e.attributes].filter(a => a.name.startsWith('data-') || ['class','role'].includes(a.name)).map(a => [a.name,a.value])) } : { type: String(e) };
  const rect = e => { const r=e?.getBoundingClientRect(); return r && {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}; };
  const scene = () => {
    const area=document.querySelector('[data-reader-content]'), retry=document.querySelector('[data-report-feed] [data-read-failure] button');
    const b=retry?.getBoundingClientRect(), point=b && {x:b.x+b.width/2,y:b.y+b.height/2};
    const selected=document.querySelector('[data-image-slider-current]');
    return { area:rect(area), scroll:area && {top:area.scrollTop,max:area.scrollHeight-area.clientHeight,padding:getComputedStyle(area).paddingBottom}, retry:rect(retry), retryHit:point && retry.contains(document.elementFromPoint(point.x,point.y)),
      retryHitTarget:point && describe(document.elementFromPoint(point.x,point.y)), fold:rect(document.querySelector('[data-coordinator-fold-row]')), dock:document.documentElement && getComputedStyle(document.documentElement).getPropertyValue('--coordinator-dock'),
      panel:rect(document.querySelector('[data-coordinator-panel]')), current:rect(selected), track:rect(document.querySelector('[data-image-slider-track]')), modal:rect(document.querySelector('[data-image-slider-modal]')), rows:[...document.querySelectorAll('[data-row]')].slice(0,8).map(row => ({id:row.getAttribute('data-row'),rect:rect(row)})) };
  };
  for (const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture','touchstart','touchmove','touchend','touchcancel','keydown','keyup','visibilitychange']) addEventListener(type, e => {
    const t = e.touches;
    push('events', { type, stamp: e.timeStamp, target: describe(e.target), pointerType: e.pointerType, x: e.clientX, y: e.clientY, key: e.key, repeat: e.repeat, visibility: document.visibilityState, touches: t && [...t].map(p => ({x:p.clientX,y:p.clientY})), defaultPrevented: e.defaultPrevented, scene: ['pointerdown','pointerup','touchstart','touchend'].includes(type) ? scene() : undefined });
    if (['pointerup','touchend'].includes(type)) requestAnimationFrame(() => push('changes',{kind:'after-input',scene:scene()}));
  }, true);
  const animate = Element.prototype.animate, cancel = Animation.prototype.cancel;
  const ids = new WeakMap(); let next = 0;
  const state = a => ({ id: ids.get(a), start: a.startTime, current: a.currentTime, playState: a.playState, timing: a.effect?.getComputedTiming(), frames: a.effect?.getKeyframes() });
  Element.prototype.animate = function (...args) {
    const a = animate.apply(this,args);ids.set(a,++next);
    push('animations',{ phase:'create', target:describe(this), ghost:this.closest('[data-flying-card]')?.getAttribute('data-flying-card'), ...state(a) });
    // Passive events do not consume ready/finished rejection or change unhandled-error semantics.
    requestAnimationFrame(() => push('animations',{phase:'frame',...state(a)}));
    a.addEventListener('finish', () => push('animations',{phase:'finished',...state(a)}), {once:true});
    a.addEventListener('cancel', () => push('animations',{phase:'cancelled',...state(a)}), {once:true});
    return a;
  };
  Animation.prototype.cancel = function () { push('animations',{phase:'cancel',stack:new Error().stack,...state(this)});return cancel.apply(this,arguments); };
  new MutationObserver(records => {
    for (const record of records) {
      for (const n of record.removedNodes) if (n instanceof Element && (n.matches('[data-flying-card]') || n.querySelector('[data-flying-card]'))) push('changes',{kind:'ghost-removed',node:describe(n)});

    }
  }).observe(document,{subtree:true,childList:true,characterData:true});
})();
