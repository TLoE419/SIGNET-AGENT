'use strict';

(() => {
  const root = document.getElementById('signet-lens-left-preview');
  const tooltip = document.createElement('div');
  tooltip.id = 'workspace-tooltip';
  tooltip.className = 'workspace-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  document.body.append(tooltip);

  const triggerAt = (element) => element instanceof Element ? element.closest('[data-tooltip]') : null;
  let hovered = null;
  let focused = null;

  function showTooltip() {
    const target = hovered ?? focused;
    const label = target?.dataset.tooltip?.trim();
    if (!label || !target.getClientRects().length) {
      tooltip.hidden = true;
      return;
    }
    tooltip.textContent = label;
    tooltip.lang = root.lang;
    tooltip.hidden = false;
    const anchor = target.getBoundingClientRect();
    const {width, height} = tooltip.getBoundingClientRect();
    const gap = 5;
    let left = anchor.left + (anchor.width - width) / 2;
    let top = anchor.top - height - gap;
    if (target.dataset.tooltipPlacement === 'right') {
      left = anchor.right + gap;
      if (left + width > window.innerWidth - gap) left = anchor.left - width - gap;
      top = anchor.top + (anchor.height - height) / 2;
    } else if (top < gap) {
      top = anchor.bottom + gap;
    }
    tooltip.style.left = Math.max(gap, Math.min(left, window.innerWidth - width - gap)) + 'px';
    tooltip.style.top = Math.max(gap, Math.min(top, window.innerHeight - height - gap)) + 'px';
  }

  root.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') return;
    hovered = triggerAt(event.target);
    showTooltip();
  });
  root.addEventListener('pointerout', event => {
    hovered = triggerAt(event.relatedTarget);
    showTooltip();
  });
  root.addEventListener('focusin', event => {
    focused = triggerAt(event.target);
    showTooltip();
  });
  root.addEventListener('focusout', event => {
    focused = triggerAt(event.relatedTarget);
    showTooltip();
  });
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    hovered = focused = null;
    showTooltip();
  });
  window.addEventListener('resize', showTooltip);
  new MutationObserver(showTooltip).observe(root, {attributes: true, attributeFilter: ['lang']});
})();
