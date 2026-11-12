/**
 * Host half tests: the volatile Config contract and the `lastTurnEnd`
 * projection definition, plus the wiring apply() installs when the optional
 * services are present.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, Config, lastTurnEndDefinition, apply } from '../index.js'

test('defaults match the documented contract', () => {
  assert.deepEqual(DEFAULTS, {
    enabled: true,
    volume: 0.7,
    done: 'chime',
    attention: 'wood',
    error: 'alarm',
    onlyWhenHidden: false,
    repeatEnabled: false,
    repeatMode: 'ack',
    repeatIntervalSeconds: 15,
    repeatCount: 5,
  })
})

test('Config exposes every field as a volatile settings field', async () => {
  const { default: Schema } = await import('@deepseek-ai/schemastery')
  const result = Config['~standard'].validate({
    volume: 0.4,
    projects: { w1: { done: 'bell' } },
    repeatMode: 'count',
  })
  assert.equal(result.issues, undefined)
  assert.equal(result.value.volume.get(), 0.4)
  assert.deepEqual(result.value.projects.get(), { w1: { done: 'bell' } })
  assert.equal(result.value.repeatMode.get(), 'count')
  for (const [key, field] of Object.entries(Config.dict)) {
    assert.equal(field.meta.volatile, true, key + ' must be volatile')
    assert.doesNotThrow(() => new Schema(field.toJSON()), key + ' must rehydrate')
  }
})

test('lastTurnEnd folds reasons and ignores unrelated events', () => {
  const state = { kind: 'completed', turn: 3, at: 10 }
  const ignore = lastTurnEndDefinition.apply(state, { type: 'user/message', seq: 4 })
  assert.equal(ignore, state)
  const next = lastTurnEndDefinition.apply(state, {
    type: 'turn/end',
    seq: 5,
    time: 20,
    data: { turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  })
  assert.deepEqual(next, { kind: 'aborted', turn: 4, at: 20 })
  const fallback = lastTurnEndDefinition.apply(state, { type: 'turn/end', seq: 6, time: 21, data: { turn: 5 } })
  assert.deepEqual(fallback, { kind: 'completed', turn: 5, at: 21 })
  assert.equal(lastTurnEndDefinition.init(), null)
  assert.equal(lastTurnEndDefinition.wire.view(state), state)
  assert.equal(lastTurnEndDefinition.stateSchema.parse(42), 42)
})

test('Config projects onto a volatile form the settings surface accepts', async () => {
  const { default: Schema } = await import('@deepseek-ai/schemastery')
  const { plainConfig, projectForm, volatileForm } = await import('../test/form-projection.mjs')
  const form = volatileForm(Config, Schema)
  assert.ok(form, 'the entry must be served as a settings form')
  assert.equal(form.type, 'object')
  assert.deepEqual(Object.keys(form.dict).sort(), Object.keys(DEFAULTS).concat('projects').sort())
  const value = projectForm(form, plainConfig(Config({ volume: 1 })))
  assert.equal(value.volume, 1)
  assert.deepEqual(value.projects, {})
  assert.equal(value.repeatMode, 'ack')
  assert.doesNotThrow(() => new Schema(form.toJSON()))
})

test('apply registers the projection and the settings page policy', () => {
  const definitions = []
  const policies = []
  const effects = []
  const ctx = {
    fiber: { id: 'fiber' },
    effect(callback) {
      effects.push(callback)
    },
    inject(deps, callback) {
      const child = Object.create(ctx)
      if (deps.includes('sessionProjections')) {
        child.sessionProjections = {
          register(definition) {
            definitions.push(definition)
            return {
              then(resolve) {
                resolve({ dispose: async () => {} })
              },
            }
          },
        }
      }
      if (deps.includes('settings')) {
        child.settings = {
          configure(presentation, owner) {
            policies.push({ presentation, owner })
            return () => {}
          },
        }
      }
      callback(child)
    },
  }
  apply(ctx)
  const runEffects = () => {
    for (const callback of effects.splice(0)) callback()
  }
  runEffects()
  assert.equal(definitions.length, 1)
  assert.equal(definitions[0], lastTurnEndDefinition)
  assert.deepEqual(policies, [{ presentation: { auto: false }, owner: ctx.fiber }])
})
