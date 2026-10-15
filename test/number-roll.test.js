import test from 'node:test';
import assert from 'node:assert/strict';
import { digitPlaces, rollingNumberMarkup, renderRollingNumbers } from '../src/scripts/number-roll.js';

const digits = text => digitPlaces(text).filter(part => part.place !== undefined).map(part => [part.place, part.character]);
test('digit places survive carry, grouping, signs, currency and optional decimals', () => {
  assert.deepEqual(digits('999 kr'), [[2, '9'], [1, '9'], [0, '9']]);
  assert.deepEqual(digits('−1\u00a0000,50 kr'), [[3, '1'], [2, '0'], [1, '0'], [0, '0'], [-1, '5'], [-2, '0']]);
  assert.deepEqual(digits('6.8%'), [[0, '6'], [-1, '8']]);
  assert.deepEqual(digits('1,234'), [[3, '1'], [2, '2'], [1, '3'], [0, '4']]);
  assert.deepEqual(digits('Not set'), []);
  assert.match(rollingNumberMarkup('<10 kr>', 'a"b'), /data-number-roll="a&quot;b"/);
  assert.ok(!rollingNumberMarkup('<img>', 'x').includes('<img>'));
});

// Only the DOM boundary and animation clock are simulated. Values stay text;
// deferred promises let a new selection win before an older animation settles.
function harness({ reduced = false, visible = true, height = 16 } = {}) {
  const animations = [], observers = [];
  let elements = [];
  const win = {
    addEventListener() {},
    matchMedia: () => ({ matches: reduced }),
    getComputedStyle: () => ({ transform: 'matrix(1, 0, 0, 1, 0, -72)', fontSize: '16px', lineHeight: '16px', letterSpacing: '-0.6px' }),
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {} disconnect() { this.disconnected = true; }
    },
  };
  const doc = { defaultView: win, createElement: () => ({
    className: '', setAttribute() {}, remove() { this.removed = true; },
    set innerHTML(value) {
      this.slots = [...value.matchAll(/data-place="(-?\d+)"/g)].map(match => { const track = {
        style: {}, animate(frames, options) {
          let resolve, reject;
          const animation = { frames, options, finished: new Promise((yes, no) => { resolve = yes; reject = no; }), finish: () => resolve(), cancel() { this.cancelled = true; reject(new Error('cancelled')); } };
          animations.push(animation); return animation;
        },
      }; return { dataset: { place: match[1] }, querySelector: () => track }; });
    },
    querySelectorAll() { return this.slots; },
  }) };
  const container = { ownerDocument: doc,
    set innerHTML(markup) {
      elements.forEach(element => { element.isConnected = false; });
      elements = [...markup.matchAll(/data-number-roll="([^"]*)">([^<]*)<\/span>/g)].map(match => ({
        dataset: { numberRoll: match[1] }, textContent: match[2], ownerDocument: doc, isConnected: true, animate() {},
        style: { setProperty() {} }, activeClasses: new Set(),
        classList: { add(value) { this.owner.activeClasses.add(value); }, remove(value) { this.owner.activeClasses.delete(value); } },
        getBoundingClientRect: () => ({ height }),
        getClientRects: () => visible ? [{}] : [], replaceChildren(...children) { this.children = children; },
      }));
      elements.forEach(element => { element.classList.owner = element; });
    }, querySelectorAll: () => elements,
  };
  const render = (value, options) => { renderRollingNumbers(container, rollingNumberMarkup(value, 'total'), options); return elements[0]; };
  return { render, animations, observers };
}

test('initial values wait until visible and reduced motion keeps exact plain text', () => {
  const h = harness({ visible: false });
  const element = h.render('123 kr');
  assert.equal(h.animations.length, 0);
  h.observers[0].callback([{ isIntersecting: true }]);
  assert.equal(h.animations.length, 3);
  assert.equal(element.children[0].textContent, '123 kr');
  assert.equal(element.children[0].className, 'number-roll-value');
  assert.equal(element.activeClasses.has('number-roll-active'), true);
  const reduced = harness({ reduced: true });
  const plain = reduced.render('−1 234,50 kr');
  reduced.observers[0].callback([{ isIntersecting: true }]);
  assert.equal(reduced.animations.length, 0);
  assert.equal(plain.children, undefined);
  assert.equal(plain.textContent, '−1 234,50 kr');
});

test('rapid updates continue from the visible wheel and only the latest value settles', async () => {
  const h = harness();
  const first = h.render('9 kr');
  h.observers[0].callback([{ isIntersecting: true }]);
  const latest = h.render('2 kr', { duration: 210 });
  assert.equal(h.animations[0].cancelled, true);
  assert.deepEqual(h.animations[1].frames, [{ transform: 'translateY(-232px)' }, { transform: 'translateY(-192px)' }]);
  assert.equal(h.animations[1].options.duration, 210);
  h.animations[1].finish();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(first.isConnected, false);
  assert.equal(latest.children[0].textContent, '2 kr');
  assert.equal(latest.children[0].className, 'number-roll-value');
  assert.equal(latest.activeClasses.has('number-roll-active'), false);
  assert.equal(latest.children[1].removed, true);
  const count = h.animations.length;
  const unchanged = h.render('2 kr');
  assert.equal(h.animations.length, count);
  assert.equal(unchanged.children, undefined);
  assert.equal(unchanged.textContent, '2 kr');
});


test('wrapped values keep normal text flow instead of forcing a single rolling row', () => {
  const h = harness({ height: 32 });
  const element = h.render('1 234 567 890 kr');
  h.observers[0].callback([{ isIntersecting: true }]);
  assert.equal(h.animations.length, 0);
  assert.equal(element.children, undefined);
  assert.equal(element.textContent, '1 234 567 890 kr');
});
