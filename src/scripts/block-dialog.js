// Renderers register a snapshot and a pure renderer. Dialog changes never call
// the page renderers, save preferences, or write to the ledger.
const blocks = new WeakMap();
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function registerBlock(container, descriptor) {
  if (!container?.ownerDocument || container.closest('dialog')) return;
  blocks.set(container, descriptor);
  let button = container.querySelector(':scope > [data-expand-block], :scope > .block-expand-group [data-expand-block], :scope > dt > [data-expand-block]');
  if (!button) {
    button = container.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'expand-block';
    button.setAttribute('data-expand-block', '');
    button.setAttribute('aria-haspopup', 'dialog');
    // A dl may contain only dt, dd, or groups of these.
    if (container.tagName === 'DL') {
      const group = container.ownerDocument.createElement('div');
      group.className = 'block-expand-group';
      const term = container.ownerDocument.createElement('dt');
      term.className = 'sr-only'; term.textContent = 'Expanded view';
      const definition = container.ownerDocument.createElement('dd');
      definition.append(button); group.append(term, definition); container.prepend(group);
    } else if (container.classList.contains('stat-item')) container.querySelector('dt').append(button);
    else container.prepend(button);
  }
  button.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true" focusable="false"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg>';
  button.setAttribute('aria-label', `Expand ${descriptor.title}`);
  button.title = `Expand ${descriptor.title}`;
  container.classList.add('expandable-block');
}

export function createBlockSession(descriptor) {
  const initial = structuredClone(descriptor.initial || {});
  return {
    title: descriptor.title,
    controls: descriptor.controls || [],
    options: structuredClone(initial),
    reset() { this.options = structuredClone(initial); },
    render(container) { descriptor.render(container, this.options); },
  };
}

function controlsMarkup(session) {
  return session.controls.map((control, index) => {
    const value = session.options[control.key];
    const id = `block-option-${index}`;
    if (control.type === 'checkbox') return `<label class="checkbox" for="${id}"><input id="${id}" type="checkbox" data-block-option="${esc(control.key)}"${value ? ' checked' : ''}>${esc(control.label)}</label>`;
    if (control.type === 'series') return `<fieldset class="block-series-options"><legend>${esc(control.label)}</legend>${control.choices.map(choice => `<label class="checkbox"><input type="checkbox" data-block-series="${esc(choice.value)}"${value.includes(choice.value) ? ' checked' : ''}>${esc(choice.label)}</label>`).join('')}</fieldset>`;
    return `<label for="${id}">${esc(control.label)}<select id="${id}" data-block-option="${esc(control.key)}">${control.choices.map(choice => `<option value="${esc(choice.value)}"${String(value) === String(choice.value) ? ' selected' : ''}>${esc(choice.label)}</option>`).join('')}</select></label>`;
  }).join('');
}

export function initializeBlockDialog(doc = document) {
  const dialog = doc.getElementById('block-dialog');
  const controls = doc.getElementById('block-dialog-options');
  const content = doc.getElementById('block-dialog-content');
  let session = null, opener = null, notes = [];
  const render = () => {
    if (!session || !dialog.open) return;
    session.render(content);
    for (const text of notes) {
      const note = doc.createElement('p'); note.className = 'input-note'; note.textContent = text; content.append(note);
    }
  };
  const renderControls = () => {
    controls.innerHTML = controlsMarkup(session);
    controls.hidden = !session.controls.length;
    doc.getElementById('reset-block-dialog').hidden = !session.controls.length;
  };
  doc.addEventListener('click', event => {
    if (content.contains(event.target) && event.target.closest('a[href^="#"]')) { dialog.close(); return; }
    const button = event.target.closest('[data-expand-block]');
    if (!button) return;
    const source = button.closest('.expandable-block');
    const descriptor = blocks.get(source);
    if (!descriptor) return;
    opener = button;
    session = createBlockSession(descriptor);
    notes = [...source.parentElement.querySelectorAll(':scope > .chart-note, :scope > .input-note')].map(note => note.textContent);
    doc.getElementById('block-dialog-title').textContent = session.title;
    renderControls();
    dialog.showModal();
    render();
  });
  controls.addEventListener('change', event => {
    if (!session) return;
    const input = event.target;
    if (input.hasAttribute('data-block-series')) {
      const key = session.controls.find(control => control.type === 'series').key;
      session.options[key] = [...controls.querySelectorAll('[data-block-series]:checked')].map(element => element.dataset.blockSeries);
    } else if (input.dataset.blockOption) session.options[input.dataset.blockOption] = input.type === 'checkbox' ? input.checked : input.value;
    render();
  });
  doc.getElementById('reset-block-dialog').addEventListener('click', () => { session.reset(); renderControls(); render(); });
  doc.getElementById('close-block-dialog').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    session = null; notes = []; content.replaceChildren(); content.className = ''; controls.replaceChildren();
    const replacement = [...doc.querySelectorAll('.view:not([hidden]) [data-expand-block]')].find(button => button.getAttribute('aria-label') === opener?.getAttribute('aria-label'));
    const focusTarget = opener?.isConnected ? opener : replacement || doc.getElementById('main-content');
    focusTarget?.focus({ preventScroll: true });
    opener = null;
  });
  // Observing only the width avoids a feedback loop when options change height.
  let width = 0;
  new doc.defaultView.ResizeObserver(entries => {
    const next = Math.round(entries[0].contentRect.width);
    if (next && next !== width) { width = next; render(); }
  }).observe(content);
}

// For read-only outcome tables and contextual text, retain the rendered
// snapshot. Do not clone forms, page event handlers, or animated number wheels.
export function registerReadOnlyBlock(container, title) {
  const copy = container.cloneNode(true);
  copy.querySelectorAll('[data-expand-block], .block-expand-group, .number-roll-visual').forEach(element => element.remove());
  copy.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
  copy.querySelectorAll('.number-roll-active').forEach(element => element.classList.remove('number-roll-active'));
  const markup = copy.innerHTML;
  registerBlock(container, {
    title, initial: { notes: true, spacing: 'comfortable' },
    controls: [
      ...(copy.querySelector('.input-note, .chart-note') ? [{ key: 'notes', label: 'Show explanatory notes', type: 'checkbox' }] : []),
      ...(copy.querySelector('table') ? [{ key: 'spacing', label: 'Table spacing', choices: [{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }] }] : []),
    ],
    render(target, options) {
      target.innerHTML = markup;
      target.classList.toggle('block-compact', options.spacing === 'compact');
      target.querySelectorAll('.input-note, .chart-note').forEach(note => { note.hidden = !options.notes; });
    },
  });
}
