import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const webRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
const packagePath = webRequire.resolve("embla-carousel/package.json");
const manifest = webRequire("embla-carousel/package.json");
assert.equal(manifest.version, "8.6.0", "Reassess the local arrival patch when upgrading Embla");
const esmPath = resolve(dirname(packagePath), manifest.exports["."].import.default);
const factories = {
  import: (await import(pathToFileURL(esmPath).href)).default,
  require: webRequire("embla-carousel"),
};

// Only browser layout, observers and the RAF clock are simulated. The public
// factory constructs the real Engine, ScrollBody, ScrollTo, loop and drag handler.
function fixture(factory, loop = false) {
  const dom = new JSDOM("<div id='root'><div><div></div><div></div><div></div></div></div>");
  const { window } = dom;
  const root = window.document.querySelector("#root");
  const container = root.firstElementChild;
  const observerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: class {
    observe() {} disconnect() {}
  } });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  for (const [node, width, left] of [[root, 398, 0], [container, 398, 0],
    ...Array.from(container.children, (node, index) => [node, 358, index * 358])]) {
    Object.defineProperties(node, {
      offsetWidth: { value: width }, offsetHeight: { value: 500 },
      offsetLeft: { value: left }, offsetTop: { value: 0 }, offsetParent: { value: root },
    });
  }
  const pending = new Map<number, (time: number) => void>();
  let id = 0, time = 100;
  window.requestAnimationFrame = fn => { pending.set(++id, fn); return id; };
  window.cancelAnimationFrame = key => pending.delete(key);
  const api = factory(root, { containScroll: false, loop, duration: 16,
    watchResize: false, watchSlides: false, watchFocus: false });
  const engine = api.internalEngine();
  assert.deepEqual(engine.scrollSnaps, [20, -338, -696]);
  assert.equal(engine.options.loop, loop, "Loop fixture must exercise the real loop");
  const events = [];
  const state = () => ({ time, target: engine.target.get(), location: engine.location.get(),
    previous: engine.previousLocation.get(), offset: engine.offsetLocation.get(),
    index: api.selectedScrollSnap(), previousIndex: api.previousScrollSnap(),
    drawn: Number(container.style.transform.match(/translate3d\(([^p]+)px/)?.[1]) });
  for (const type of ["select", "scroll", "settle", "destroy", "reInit"]) {
    api.on(type, () => events.push({ type, ...state() }));
  }
  function step(delta = 1000 / 60) {
    time += delta;
    const callbacks = [...pending.values()];
    pending.clear();
    for (const fn of callbacks) fn(time);
  }
  function drain(deltas = [1000 / 60]) {
    for (let frame = 0; pending.size && frame < 240; frame++) step(deltas[frame] ?? 1000 / 60);
    assert.equal(pending.size, 0, "Animation must stop within the bounded RAF schedule");
  }
  return { api, engine, root, window, pending, events, state, step, drain,
    close() {
      api.destroy(); dom.window.close();
      if (observerDescriptor) Object.defineProperty(globalThis, "IntersectionObserver", observerDescriptor);
      else Reflect.deleteProperty(globalThis, "IntersectionObserver");
    } };
}

function arrived(state) {
  for (const name of ["location", "previous", "offset", "drawn"]) {
    assert.ok(Math.abs(state[name] - state.target) < 0.001,
      `${name} must converge at stop: ${JSON.stringify(state)}`);
  }
}

for (const [format, factory] of Object.entries(factories)) {
  test(`${format}: uneven RAF arrival stops with all three positions converged`, t => {
    const f = fixture(factory);
    try {
      f.api.scrollTo(1);
      f.engine.scrollBody.useDuration(16).useFriction(0.698);
      f.drain([18, 120, 148, 110]);
      const settled = f.events.filter(event => event.type === "settle");
      assert.equal(settled.length, 1);
      t.diagnostic(JSON.stringify(settled[0]));
      arrived(settled[0]);
      assert.equal(settled[0].index, 1);
      assert.equal(f.events[0].type, "select");
      assert.equal(f.events.at(-1).type, "settle");
      const lastScroll = f.events.filter(event => event.type === "scroll").at(-1);
      assert.ok(Math.abs(lastScroll.offset - settled[0].offset) < 0.002,
        "The last omitted scroll notification must leave less than 0.002px of pull");
    } finally { f.close(); }
  });

  test(`${format}: 60Hz and instant preserve notification order and current index`, () => {
    const f = fixture(factory);
    try {
      f.api.scrollTo(1);
      f.engine.scrollBody.useDuration(12).useFriction(0.68);
      f.drain();
      arrived(f.state());
      assert.deepEqual([...new Set(f.events.map(event => event.type))], ["select", "scroll", "settle"]);
      assert.ok(f.events.every(event => event.index === 1 && event.previousIndex === 0));
      f.events.length = 0;
      f.api.scrollTo(2, true);
      arrived(f.state());
      assert.deepEqual(f.events.map(event => event.type), ["scroll", "select"]);
      assert.ok(f.events.every(event => event.index === 2 && event.previousIndex === 1));
      f.events.length = 0;
      // Old offset near the new target must not cause a render with stale index.
      f.engine.offsetLocation.set(-338.0005);
      f.api.scrollTo(1, true);
      arrived(f.state());
      assert.deepEqual(f.events.map(event => event.type), ["settle", "select"]);
      assert.ok(f.events.every(event => event.index === 1 && event.previousIndex === 2));
      f.events.length = 0;
      f.api.scrollTo(1, true);
      assert.deepEqual(f.events, [], "An unchanged target adds no notifications");
    } finally { f.close(); }
  });

  test(`${format}: held pointer and active bounds prevent premature settle`, () => {
    const f = fixture(factory);
    try {
      f.root.dispatchEvent(new f.window.MouseEvent("mousedown", { button: 0, clientX: 200 }));
      assert.equal(f.engine.dragHandler.pointerDown(), true);
      f.engine.animation.start();
      for (let n = 0; n < 4; n++) f.step();
      assert.equal(f.events.filter(event => event.type === "settle").length, 0);
      assert.equal(f.pending.size, 1);
      f.window.document.dispatchEvent(new f.window.MouseEvent("mouseup", { button: 0, clientX: 200 }));
      assert.equal(f.engine.dragHandler.pointerDown(), false);
      f.drain();
      f.events.length = 0;
      for (const vector of [f.engine.location, f.engine.previousLocation, f.engine.offsetLocation, f.engine.target]) vector.set(40);
      assert.equal(f.engine.scrollBody.settled(), true);
      assert.equal(f.engine.scrollBounds.shouldConstrain(), true);
      f.engine.animation.render(1);
      assert.deepEqual(f.events.map(event => event.type), ["scroll"]);
      f.engine.animation.start();
      f.drain();
      arrived(f.state());
      assert.equal(f.engine.scrollBounds.shouldConstrain(), false);
      assert.equal(f.events.at(-1).type, "settle");
    } finally { f.close(); }
  });

  test(`${format}: real loop, reInit and destroy retain their lifetimes`, () => {
    const f = fixture(factory, true);
    try {
      f.api.scrollTo(2, true);
      f.events.length = 0;
      f.api.scrollNext();
      f.engine.scrollBody.useDuration(16).useFriction(0.698);
      f.drain([18, 120, 148, 110]);
      arrived(f.state());
      assert.equal(f.api.selectedScrollSnap(), 0);
      assert.ok(f.state().target > -1054, "Real ScrollLooper must wrap the vectors");
      assert.equal(f.events.at(-1).type, "settle");
      f.api.scrollNext(); f.step();
      const oldEngine = f.engine;
      f.api.reInit();
      assert.equal(f.pending.size, 0);
      assert.notEqual(f.api.internalEngine(), oldEngine);
      assert.equal(f.api.selectedScrollSnap(), 1);
      const current = f.api.internalEngine();
      for (const vector of [current.location, current.previousLocation, current.offsetLocation, current.target]) {
        assert.equal(vector.get(), current.scrollSnaps[1]);
      }
      f.api.scrollNext(); f.step();
      assert.equal(f.pending.size, 1);
      f.api.destroy();
      const count = f.events.length;
      f.step(); f.api.scrollNext();
      assert.equal(f.pending.size, 0);
      assert.equal(f.events.length, count);
      assert.equal(f.events.at(-1).type, "destroy");
    } finally { f.close(); }
  });
}
