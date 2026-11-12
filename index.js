/**
 * Host half of the project-sounds bundle.
 *
 * Two small jobs, both optional so the bundle still works in compositions that
 * lack the owning services:
 *
 * - `lastTurnEnd` session projection: a client-visible fold of durable
 *   `turn/end` reasons. The browser half uses it to tell a completed turn
 *   (Перезвон) from a stopped one (silence) and from a failed or truncated one
 *   (Сирена); without the projection it falls back to the running transition.
 * - `Config` with volatile fields: the Host settings document, so the browser
 *   half can keep settings in the DSH profile instead of `localStorage`.
 *   `settings.configure({ auto: false })` keeps the generic Plugins settings
 *   page from rendering a second, duplicate form for this entry.
 *
 * Everything else (sounds, detection, UI) lives in the client half.
 */
import Schema from '@deepseek-ai/schemastery'

/** Default configuration; the client half applies the same values. */
export const DEFAULTS = {
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
}

/**
 * Plugin configuration. Every field is volatile, which is what makes the entry
 * appear in the Host settings document served to the browser (edits apply
 * without remounting the plugin). Values are deliberately permissive: a stale
 * or hand-edited value must not stop the plugin from loading, so the client
 * half normalizes unknown sound ids and out-of-range numbers.
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(DEFAULTS.enabled).volatile(),
  volume: Schema.number().default(DEFAULTS.volume).volatile(),
  done: Schema.string().default(DEFAULTS.done).volatile(),
  attention: Schema.string().default(DEFAULTS.attention).volatile(),
  error: Schema.string().default(DEFAULTS.error).volatile(),
  onlyWhenHidden: Schema.boolean().default(DEFAULTS.onlyWhenHidden).volatile(),
  repeatEnabled: Schema.boolean().default(DEFAULTS.repeatEnabled).volatile(),
  repeatMode: Schema.union(['ack', 'count']).default(DEFAULTS.repeatMode).volatile(),
  repeatIntervalSeconds: Schema.number().default(DEFAULTS.repeatIntervalSeconds).volatile(),
  repeatCount: Schema.number().default(DEFAULTS.repeatCount).volatile(),
  projects: Schema.dict(Schema.any()).default({}).volatile(),
})

/** Identity schema: the registry only calls `parse`, and this state is ours. */
const identitySchema = { parse: value => value }

/**
 * The last durable `turn/end` of a Session, or `null` before the first turn
 * ends. `wire.view` returns the state reference itself, so a snapshot with no
 * new turn end publishes nothing.
 */
export const lastTurnEndDefinition = {
  key: 'lastTurnEnd',
  stateSchema: identitySchema,
  stateVersion: 1,
  init: () => null,
  apply: (state, event) => {
    if (event.type !== 'turn/end') return state
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    const reason = data.reason !== null && typeof data.reason === 'object' ? data.reason : {}
    return {
      kind: typeof reason.kind === 'string' ? reason.kind : 'completed',
      turn: typeof data.turn === 'number' ? data.turn : 0,
      at: typeof event.time === 'number' ? event.time : 0,
    }
  },
  wire: { viewSchema: identitySchema, view: state => state },
}

/**
 * Register the projection and opt out of the generic settings form.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionProjections'], scope => {
      scope.effect(() => {
        const registration = scope.sessionProjections.register(lastTurnEndDefinition)
        Promise.resolve(registration).catch(error => {
          console.error('[project-sounds] last-turn projection', error)
        })
        return () => {
          Promise.resolve(registration)
            .then(handle => handle.dispose())
            .catch(error => console.error('[project-sounds] projection dispose', error))
        }
      }, 'project-sounds: last-turn projection')
    })
    ctx.inject(['settings'], scope => {
      scope.effect(() => {
        try {
          return scope.settings.configure({ auto: false }, ctx.fiber)
        } catch (error) {
          console.error('[project-sounds] settings policy', error)
          return () => {}
        }
      }, 'project-sounds: settings policy')
    })
  }
}
