/**
 * Integration tests for the browser half.
 *
 * `client.js` is a browser module loaded through `window.__ModuleLoader__`, so
 * each test builds the same surfaces the Web shell provides (services, stores,
 * events, Web Audio) around the real factory and drives public behavior only.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const RECORDED = []
const WATCHED_JOBS = []

class FakeParam {
  setValueAtTime(value) {
    RECORDED.push(value)
  }
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
}

class SilentParam {
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
}

class FakeAudioContext {
  constructor() {
    this.state = 'running'
    this.currentTime = 0
    this.destination = { id: 'destination' }
  }
  createGain() {
    return { gain: new SilentParam(), connect() {} }
  }
  createOscillator() {
    return { frequency: new FakeParam(), type: 'sine', connect() {}, start() {}, stop() {} }
  }
  resume() {
    return Promise.resolve()
  }
}

const localStore = new Map()
globalThis.window = {
  localStorage: {
    getItem: key => (localStore.has(key) ? localStore.get(key) : null),
    setItem: (key, value) => localStore.set(key, String(value)),
    removeItem: key => localStore.delete(key),
  },
  AudioContext: FakeAudioContext,
  addEventListener() {},
  removeEventListener() {},
}
globalThis.document = {
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
}
globalThis.__factory = undefined
window.__ModuleLoader__ = {
  load({ factory }) {
    globalThis.__factory = factory
  },
}

await import(new URL('../client.js', import.meta.url).href)

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/** @returns the factory-backed plugin instance. */
function plugin() {
  return globalThis.__factory(name => {
    if (name === 'react') return React
    return {}
  })
}

/**
 * Create a subscribable snapshot store.
 * @param initial - initial snapshot.
 * @returns the store plus a setter.
 */
function snapshotStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** @returns a fake Host settings form over one mutable snapshot. */
function configForm(initial) {
  const state = {
    status: 'ready',
    value: initial.value,
    base: {},
    user: initial.user ?? {},
    revision: 1,
    writable: initial.writable !== false,
  }
  const listeners = new Set()
  const writes = []
  const form = {
    writes,
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async mutate(ops) {
      writes.push(ops)
      for (const op of ops) {
        if (op.path.length !== 1) continue
        const field = op.path[0]
        if (op.op === 'set') state.value = { ...state.value, [field]: op.value }
      }
      state.user = { ...state.user }
      for (const listener of [...listeners]) listener()
      return true
    },
  }
  return form
}

const SESSIONS_KEY = 'dsh-project-sounds:v1'

/**
 * Seed `localStorage` with one configuration.
 * @param config - stored configuration.
 */
function seed(config) {
  localStore.set(SESSIONS_KEY, JSON.stringify(config))
}

/**
 * Build the Web shell surfaces and apply the plugin.
 * @param options - harness options.
 * @returns the applied harness.
 */
function harness(options = {}) {
  globalThis.document.visibilityState = options.visibility ?? 'visible'
  const sessions = snapshotStore(options.sessions ?? { byId: {}, projectionsBySession: {} })
  const workspaces = snapshotStore(options.workspaces ?? { items: [] })
  const status = snapshotStore(new Map(options.status ?? []))
  const handlers = new Map()
  let settingsSpec
  let settingsComponent
  let iconSpec
  const services = {
    configForms: options.configForms === undefined ? undefined : { get: () => options.configForms },
    jobs: options.jobs,
  }
  const ctx = {
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register: () => () => {},
      bind: () => key => key,
    },
    slots: {
      inject(_slot, register) {
        const dispose = register()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(spec, component) {
        if (spec.name === 'settings.section') {
          settingsSpec = spec
          settingsComponent = component
        }
        if (spec.name === 'settings.section.icon') iconSpec = spec
        return () => {}
      },
    },
    remote: {
      $on(name, handler) {
        handlers.set(name, handler)
        return () => handlers.delete(name)
      },
    },
    sessions: { list: sessions },
    workspaces: { list: workspaces },
    uiSession: { sessionStatus: status },
    get(name) {
      return services[name]
    },
    inject(deps, callback) {
      const child = Object.assign(Object.create(ctx), {})
      for (const name of deps) {
        if (services[name] === undefined) return
        child[name] = services[name]
      }
      callback(child)
    },
  }
  plugin().apply(ctx)
  const injected = settingsSpec.inject()
  return {
    ctx,
    store: injected.store,
    engine: injected.engine,
    sessions,
    workspaces,
    status,
    handlers,
    iconSpec,
    settingsSpec,
    settingsComponent,
  }
}

/** @returns the row map used by Session projections. */
function sessionRow(id, extra = {}) {
  return { id, running: false, retainedBy: {}, ...extra }
}

/** @returns the projection map carrying one session's values. */
function projections(values) {
  return { projectionsBySession: { s1: { values } } }
}

/** Drop recorded oscillator frequencies. */
function silence() {
  RECORDED.length = 0
}

/** Enable fake timers for one test. */
function timers(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
}

test('defaults use Перезвон, Дерево and Сирена', t => {
  timers(t)
  localStore.clear()
  const { store, iconSpec } = harness()
  const config = store.getSnapshot()
  assert.equal(config.done, 'chime')
  assert.equal(config.attention, 'wood')
  assert.equal(config.error, 'alarm')
  assert.equal(config.repeatEnabled, false)
  assert.equal(config.hostBacked, false)
  assert.equal(iconSpec.id, 'project-sounds')
})

test('legacy default trio migrates, custom values are kept', t => {
  timers(t)
  localStore.clear()
  seed({ enabled: true, volume: 0.7, done: 'chime', attention: 'attention', error: 'buzz', projects: {} })
  assert.equal(harness().store.getSnapshot().attention, 'wood')

  localStore.clear()
  seed({ enabled: true, volume: 0.5, done: 'chime', attention: 'bell', error: 'buzz', projects: {} })
  const custom = harness().store.getSnapshot()
  assert.equal(custom.attention, 'bell')
  assert.equal(custom.error, 'buzz')
  assert.equal(custom.volume, 0.5)
})

test('blocked goal and full context present at load stay silent, later crossings ring', t => {
  timers(t)
  localStore.clear()
  const { engine, sessions } = harness({
    sessions: {
      byId: { s1: sessionRow('s1') },
      projectionsBySession: {
        s1: { values: { goal: { phase: 'blocked' }, contextPressure: { projectedTokens: 95, contextWindow: 100 } } },
      },
    },
  })
  silence()
  sessions.set({
    byId: { s1: sessionRow('s1') },
    projectionsBySession: { s1: { values: { goal: { phase: 'active' }, contextPressure: { projectedTokens: 50, contextWindow: 100 } } } },
  })
  assert.equal(RECORDED.length, 0)
  sessions.set({
    byId: { s1: sessionRow('s1') },
    projectionsBySession: { s1: { values: { goal: { phase: 'blocked' }, contextPressure: { projectedTokens: 50, contextWindow: 100 } } } },
  })
  assert.deepEqual(RECORDED, [440, 554.37, 440, 554.37])
  engine.dispose()
})

test('turn end reason selects the cue', async t => {
  timers(t)
  localStore.clear()
  const base = { byId: { s1: sessionRow('s1', { running: true }) }, ...projections({ lastTurnEnd: null }) }
  const workspaces = { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }] }
  const run = async kind => {
    silence()
    const h = harness({ sessions: base, workspaces })
    h.sessions.set({
      byId: { s1: sessionRow('s1', { running: false }) },
      projectionsBySession: { s1: { values: { lastTurnEnd: { kind, turn: 1, at: Date.now() } } } },
    })
    h.handlers.get('api-session/status')('s1', false)
    t.mock.timers.tick(400)
    return [...RECORDED]
  }
  assert.deepEqual(await run('completed'), [880, 1174.66])
  assert.deepEqual(await run('aborted'), [])
  assert.deepEqual(await run('max-tokens'), [440, 554.37, 440, 554.37])
  assert.deepEqual(await run('error'), [440, 554.37, 440, 554.37])
})

test('without the Host projection the running transition still rings', t => {
  timers(t)
  localStore.clear()
  const h = harness({ sessions: { byId: { s1: sessionRow('s1', { running: true }) }, projectionsBySession: {} } })
  silence()
  h.handlers.get('api-session/status')('s1', false)
  h.sessions.set({ byId: { s1: sessionRow('s1') }, projectionsBySession: {} })
  t.mock.timers.tick(400)
  assert.deepEqual(RECORDED, [880, 1174.66])
})

test('a failing background job rings only on the failed transition', t => {
  timers(t)
  localStore.clear()
  const jobState = snapshotStore({ rows: {}, observed: {} })
  const jobs = {
    state: jobState,
    watchRows(id) {
      WATCHED_JOBS.push(id)
      return () => {}
    },
    observe: () => () => {},
    kill: async () => ({ ok: true }),
  }
  const h = harness({
    sessions: {
      byId: { s1: sessionRow('s1', { running: true }) },
      projectionsBySession: {},
    },
    workspaces: { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }] },
    jobs,
  })
  assert.ok(WATCHED_JOBS.includes('s1'))
  silence()
  jobState.set({ rows: { s1: [{ id: 'j1', status: 'failed' }] }, observed: {} })
  assert.equal(RECORDED.length, 0, 'existing failure is a baseline, not news')
  jobState.set({ rows: { s1: [{ id: 'j1', status: 'running' }] }, observed: {} })
  jobState.set({ rows: { s1: [{ id: 'j1', status: 'failed' }] }, observed: {} })
  assert.deepEqual(RECORDED, [440, 554.37, 440, 554.37])
  h.engine.dispose()
})

test('repeat by count stops after the configured number of plays', t => {
  timers(t)
  localStore.clear()
  seed({
    enabled: true, volume: 0.7, done: 'chime', attention: 'wood', error: 'alarm', projects: {},
    repeatEnabled: true, repeatMode: 'count', repeatIntervalSeconds: 5, repeatCount: 2,
  })
  const { engine } = harness()
  silence()
  engine.event('attention', 'w1')
  assert.equal(RECORDED.length, 2, 'initial play')
  t.mock.timers.tick(5000)
  assert.equal(RECORDED.length, 4, 'first repeat')
  t.mock.timers.tick(5000)
  assert.equal(RECORDED.length, 4, 'count exhausted')
  engine.dispose()
})

test('repeat until acknowledged stops when the project is opened', t => {
  timers(t)
  localStore.clear()
  seed({
    enabled: true, volume: 0.7, done: 'chime', attention: 'wood', error: 'alarm', projects: {},
    repeatEnabled: true, repeatMode: 'ack', repeatIntervalSeconds: 5,
  })
  const { engine, sessions } = harness({
    sessions: {
      byId: { s1: sessionRow('s1') },
      projectionsBySession: {},
    },
    workspaces: { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }] },
  })
  silence()
  engine.error('w1')
  assert.equal(RECORDED.length, 4, 'alarm plays')
  t.mock.timers.tick(5000)
  assert.equal(RECORDED.length, 8, 'repeated while the project stays closed')
  sessions.set({ byId: { s1: sessionRow('s1', { retainedBy: { mainView: 1 } }) }, projectionsBySession: {} })
  t.mock.timers.tick(5000)
  assert.equal(RECORDED.length, 8, 'acknowledged by opening the project')
  engine.dispose()
})

test('an already open project rings once and does not repeat', t => {
  timers(t)
  localStore.clear()
  seed({
    enabled: true, volume: 0.7, done: 'chime', attention: 'wood', error: 'alarm', projects: {},
    repeatEnabled: true, repeatMode: 'ack', repeatIntervalSeconds: 5,
  })
  const h = harness({
    sessions: { byId: { s1: sessionRow('s1', { retainedBy: { mainView: 1 } }) }, projectionsBySession: {} },
    workspaces: { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }] },
  })
  silence()
  h.status.set(new Map([['s1', { pendingInteraction: 'approval' }]]))
  assert.equal(RECORDED.length, 2, 'attention cue plays once')
  t.mock.timers.tick(10000)
  assert.equal(RECORDED.length, 2, 'no repeat for an open project')
  h.engine.dispose()
})

test('onlyWhenHidden suppresses cues while the tab is visible', t => {
  timers(t)
  localStore.clear()
  seed({ enabled: true, volume: 0.7, done: 'chime', attention: 'wood', error: 'alarm', projects: {}, onlyWhenHidden: true })
  const { engine } = harness()
  silence()
  engine.event('done')
  assert.equal(RECORDED.length, 0)
  globalThis.document.visibilityState = 'hidden'
  engine.event('done')
  assert.deepEqual(RECORDED, [880, 1174.66])
  globalThis.document.visibilityState = 'visible'
  engine.dispose()
})

test('first Host sync migrates browser settings into the profile', async t => {
  timers(t)
  localStore.clear()
  seed({ enabled: true, volume: 0.4, done: 'bell', attention: 'wood', error: 'alarm', projects: {} })
  const form = configForm({
    value: {
      enabled: true, volume: 0.7, done: 'chime', attention: 'wood', error: 'alarm',
      onlyWhenHidden: false, repeatEnabled: false, repeatMode: 'ack',
      repeatIntervalSeconds: 15, repeatCount: 5, projects: {},
    },
  })
  const { store } = harness({ configForms: form })
  assert.equal(store.getSnapshot().hostBacked, true)
  t.mock.timers.tick(350)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(form.writes.length, 1)
  const fields = form.writes[0].map(op => op.path[0])
  assert.ok(fields.includes('volume'))
  const volume = form.writes[0].find(op => op.path[0] === 'volume')
  assert.equal(volume.value, 0.4)
  assert.equal(volume.op, 'set')
})

test('explicit Host overrides win over the browser mirror', t => {
  timers(t)
  localStore.clear()
  const form = configForm({
    value: {
      enabled: true, volume: 0.9, done: 'wood', attention: 'alarm', error: 'chime',
      onlyWhenHidden: false, repeatEnabled: false, repeatMode: 'ack',
      repeatIntervalSeconds: 15, repeatCount: 5, projects: {},
    },
    user: { volume: 0.9, done: 'wood' },
  })
  const { store } = harness({ configForms: form })
  const config = store.getSnapshot()
  assert.equal(config.hostBacked, true)
  assert.equal(config.volume, 0.9)
  assert.equal(config.done, 'wood')
})

test('fields the Host document never overrides keep the browser value and are written up', async t => {
  timers(t)
  localStore.clear()
  seed({ enabled: true, volume: 0.7, done: 'bell', attention: 'wood', error: 'alarm', projects: {} })
  const form = configForm({
    value: {
      enabled: true, volume: 1, done: 'chime', attention: 'wood', error: 'alarm',
      onlyWhenHidden: false, repeatEnabled: false, repeatMode: 'ack',
      repeatIntervalSeconds: 15, repeatCount: 5, projects: {},
    },
    user: { volume: 1 },
  })
  const { store } = harness({ configForms: form })
  const config = store.getSnapshot()
  assert.equal(config.volume, 1, 'explicit Host volume wins')
  assert.equal(config.done, 'bell', 'untouched Host field yields to the browser')
  t.mock.timers.tick(350)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(form.writes.length, 1)
  const fields = form.writes[0].map(op => op.path[0])
  assert.deepEqual(fields, ['done'])
  assert.equal(form.writes[0][0].value, 'bell')
})

/** @returns every string rendered by the stub element tree, components included. */
function textOf(node) {
  if (typeof node === 'string') return [node]
  if (typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(child => textOf(child))
  if (node === null || typeof node !== 'object') return []
  const type = node.type
  if (typeof type === 'function') {
    return textOf(type({ ...node.props, children: node.children }))
  }
  return node.children === undefined ? [] : textOf(node.children)
}

test('settings page renders the repeat, visibility and storage controls', t => {
  timers(t)
  localStore.clear()
  const h = harness()
  const injected = h.settingsSpec.inject()
  const page = h.settingsComponent({
    ...injected,
    useWorkspaces: () => ({
      items: [{ workspaceId: 'w1', title: 'Demo', path: 'C:/demo', sessionIds: ['s1'] }],
    }),
  })
  const text = textOf(page).join(' ')
  assert.ok(page)
  assert.ok(text.includes('repeat'), 'repeat section')
  assert.ok(text.includes('onlyWhenHidden'), 'background-only row')
  assert.ok(text.includes('projects'), 'per-project section')
  assert.ok(text.includes('inheritShort'), 'inheritance label')
  assert.ok(text.includes('storageLocal'), 'browser-only storage note')
})
