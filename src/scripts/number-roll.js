import { reducedMotion } from './motion.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const containers = new WeakMap();
const motionListeners = new WeakSet();
const wheels = '012345678901234567890123456789'.split('').map(digit => `<span>${digit}</span>`).join('');

export function rollingNumberMarkup(value, key) {
  return `<span class="rolling-number" data-number-roll="${esc(key)}">${esc(value)}</span>`;
}

// Align by decimal place, so 999 → 1 000 and 12 → 12,50 keep the
// corresponding units together. Formatting and signs always use the final text.
export function digitPlaces(value) {
  const text = String(value), decimal = /[.,](\d{1,2})(?:\D*)$/.exec(text);
  const boundary = decimal ? decimal.index : text.length;
  const integerCount = (text.slice(0, boundary).match(/\d/g) || []).length;
  let integer = integerCount - 1, fraction = -1;
  return [...text].map((character, index) => /\d/.test(character) ? { character, place: index < boundary ? integer-- : fraction-- } : { character });
}

function stop(entry, win) {
  entry.observer?.disconnect();
  for (const digit of entry.digits.values()) {
    if (digit.animation) {
      // Sample the current wheel before replacing the DOM. Rapid updates then
      // continue from the visible position rather than jumping to an old target.
      const transform = win.getComputedStyle(digit.track).transform;
      const size = digit.lineHeight;
      const matrix = transform.startsWith('matrix(') ? transform.slice(7, -1).split(',').map(Number) : null;
      if (matrix && size) digit.position = -matrix[5] / size;
      digit.animation.cancel();
    }
  }
}

function roll(element, previous, entry, win, duration) {
  entry.seen = true;
  if (!/\d/.test(entry.value) || reducedMotion(win) || !element.animate || previous?.value === entry.value && previous.seen) return;
  const typography = win.getComputedStyle(element);
  const textLineHeight = parseFloat(typography.lineHeight) || parseFloat(typography.fontSize) * 1.2;
  const bounds = element.getBoundingClientRect();
  // A wrapped value needs normal text flow rather than a single rolling row.
  if (bounds.height > textLineHeight * 1.5) return;
  // Use the rendered line height, including the browser's subpixel rounding.
  const lineHeight = bounds.height || textLineHeight;
  element.style.setProperty('--number-roll-height', `${lineHeight}px`);
  element.style.setProperty('--number-roll-spacing', `${parseFloat(typography.letterSpacing) || 0}px`);
  const oldDigits = new Map(digitPlaces(previous?.seen ? previous.value : '0').filter(part => part.place !== undefined).map(part => [part.place, Number(part.character)]));
  const visual = element.ownerDocument.createElement('span');
  visual.className = 'number-roll-visual'; visual.setAttribute('aria-hidden', 'true');
  const parts = digitPlaces(entry.value);
  visual.innerHTML = parts.map(part => part.place === undefined ? esc(part.character) : `<span class="number-roll-digit" data-place="${part.place}"><span class="number-roll-window"><span class="number-roll-track">${wheels}</span></span></span>`).join('');
  const exact = element.ownerDocument.createElement('span');
  // The exact text stays in flow for identical width, height and baseline
  // before, during and after the overlay animates. It also remains accessible.
  exact.className = 'number-roll-value'; exact.textContent = entry.value;
  element.replaceChildren(exact, visual);
  element.classList.add('number-roll-active');
  const animations = [];
  for (const slot of visual.querySelectorAll('[data-place]')) {
    const place = Number(slot.dataset.place), track = slot.querySelector('.number-roll-track');
    const target = Number(parts.find(part => part.place === place).character);
    const sampled = previous?.seen ? previous.digits.get(place)?.position : undefined;
    const current = sampled === undefined ? oldDigits.get(place) || 0 : ((sampled % 10) + 10) % 10;
    // Take the shortest route around a wheel, leaving one cycle on each
    // side so rapid pointer reversals can turn smoothly in either direction.
    const delta = target - current;
    const from = 10 + current, to = from + delta - 10 * Math.round(delta / 10);
    const digit = { track, position: to, lineHeight, animation: null };
    entry.digits.set(place, digit);
    track.style.transform = `translateY(${-to * lineHeight}px)`;
    if (Math.abs(to - from) < 0.001) continue;
    digit.animation = track.animate([{ transform: `translateY(${-from * lineHeight}px)` }, { transform: `translateY(${-to * lineHeight}px)` }], { duration, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    animations.push(digit.animation.finished);
  }
  // Only the exact, formatted text remains after settling (including copying).
  Promise.all(animations).then(() => {
    if (element.isConnected) { visual.remove(); element.classList.remove('number-roll-active'); }
    entry.digits.clear();
  }).catch(() => {}); // Cancellation is expected when another filter/point wins.
}

// Called at the same boundary as the existing renderers. State stays local to
// each block; no transaction values or chart calculations are interpolated.
export function renderRollingNumbers(container, markup, { duration = 480, reset = false } = {}) {
  const win = container.ownerDocument?.defaultView;
  const previous = containers.get(container) || new Map();
  if (win) for (const entry of previous.values()) stop(entry, win);
  container.innerHTML = markup;
  if (!win) return;
  if (!motionListeners.has(win)) {
    win.addEventListener('saga:motionchange', () => {
      if (reducedMotion(win)) {
        for (const track of win.document.querySelectorAll('.number-roll-track')) {
          for (const animation of track.getAnimations()) animation.finish();
        }
      }
    });
    motionListeners.add(win);
  }
  const next = new Map();
  for (const element of container.querySelectorAll('[data-number-roll]')) {
    const key = element.dataset.numberRoll, old = reset ? undefined : previous.get(key);
    const entry = { value: element.textContent, seen: old?.seen || false, digits: new Map() };
    next.set(key, entry);
    const start = () => roll(element, old, entry, win, duration);
    if (element.getClientRects().length && (!win.IntersectionObserver || old?.seen)) start();
    else if (win.IntersectionObserver) {
      entry.observer = new win.IntersectionObserver(entries => {
        if (entries.some(item => item.isIntersecting)) { entry.observer.disconnect(); start(); }
      });
      entry.observer.observe(element);
    }
  }
  containers.set(container, next);
}
