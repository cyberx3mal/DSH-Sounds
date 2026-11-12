/**
 * Browser half of the project-sounds bundle.
 *
 * Plays a synthesized Web Audio cue for three situations of every Session:
 * a finished turn, a pending approval/question, and a failure. Each project
 * (Workspace) may override any of the three sounds or inherit the global one,
 * so concurrent projects are distinguishable by ear.
 *
 * Failure sound covers every blocking condition this build exposes to the
 * browser: agent errors, exhausted quota notices, context-limit pressure,
 * blocked goals, crashed background jobs, and turns that ended as an error or
 * hit the output-token ceiling.
 *
 * Detection uses public Client surfaces only:
 * - `ctx.remote.$on('api-session/status')` for the running transition,
 * - `ctx.remote.$on('api-session/error')` for live failures,
 * - `ctx.remote.$on('deepseek-account/*')` for expired credentials,
 * - `ctx.uiSession.sessionStatus` for pending interactions,
 * - `ctx.sessions.list` projections (`goal`, `contextPressure`, and the
 *   Host-side `lastTurnEnd` this bundle registers),
 * - `ctx.jobs` rosters for settled background jobs,
 * - `shell.quota-notice` chain for quota notices,
 * - `retainedBy.mainView` on Session rows to acknowledge project repeats.
 *
 * Settings live in the Host settings document (`Config` with volatile fields
 * in the Host half) so every browser of one DSH profile shares them; a browser
 * without that surface falls back to `localStorage`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-project-sounds',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'projectSounds'
    const ENTRY_ID = 'project-sounds'
    const STORAGE_KEY = 'dsh-project-sounds:v1'
    const SECTION_ID = 'project-sounds'
    const DONE_DELAY_MS = 350
    const DONE_RETRY_MS = 600
    const TURN_END_FRESH_MS = 5000
    const ERROR_SUPPRESSION_MS = 4000
    const ERROR_THROTTLE_MS = 1200
    const QUOTA_THROTTLE_MS = 30000
    const CONTEXT_WARN_PERCENT = 90
    const CONTEXT_REARM_PERCENT = 80
    const REPEAT_MIN_SECONDS = 5
    const REPEAT_MAX_SECONDS = 300
    const REPEAT_MIN_COUNT = 1
    const REPEAT_MAX_COUNT = 30
    const REPEAT_ACK_MAX_MS = 10 * 60 * 1000
    const JOB_WATCH_GRACE_MS = 5 * 60 * 1000
    const JOB_WATCH_LIMIT = 24
    const EVENTS = ['done', 'attention', 'error']
    const HOST_FIELDS = [
      'enabled', 'volume', 'done', 'attention', 'error', 'onlyWhenHidden',
      'repeatEnabled', 'repeatMode', 'repeatIntervalSeconds', 'repeatCount', 'projects',
    ]

    /* ------------------------------------------------------------------ *
     * Sound catalogue and Web Audio synthesis
     * ------------------------------------------------------------------ */

    /**
     * Note-based presets. Every note is one oscillator with an attack/decay
     * envelope; the whole preset is mixed through one volume gain node.
     */
    const SOUNDS = {
      chime: [
        { f: 880, t: 0, d: 0.16, g: 0.5 },
        { f: 1174.66, t: 0.12, d: 0.34, g: 0.4 },
      ],
      bell: [
        { f: 659.25, t: 0, d: 0.85, g: 0.4, type: 'triangle' },
        { f: 1318.51, t: 0, d: 0.5, g: 0.12 },
      ],
      marimba: [
        { f: 523.25, t: 0, d: 0.25, g: 0.45 },
        { f: 783.99, t: 0.1, d: 0.3, g: 0.3 },
      ],
      blip: [{ f: 1046.5, t: 0, d: 0.09, g: 0.35, type: 'square' }],
      digital: [
        { f: 880, t: 0, d: 0.07, g: 0.25, type: 'square' },
        { f: 1108.73, t: 0.08, d: 0.07, g: 0.25, type: 'square' },
        { f: 1318.51, t: 0.16, d: 0.1, g: 0.25, type: 'square' },
      ],
      wood: [
        { f: 320, t: 0, d: 0.12, g: 0.5, type: 'triangle' },
        { f: 210, t: 0.02, d: 0.14, g: 0.35, type: 'triangle' },
      ],
      drop: [{ f: 1200, t: 0, d: 0.22, g: 0.4, to: 520 }],
      success: [
        { f: 523.25, t: 0, d: 0.11, g: 0.4 },
        { f: 659.25, t: 0.1, d: 0.11, g: 0.4 },
        { f: 783.99, t: 0.2, d: 0.26, g: 0.4 },
      ],
      attention: [
        { f: 987.77, t: 0, d: 0.12, g: 0.35 },
        { f: 987.77, t: 0.2, d: 0.16, g: 0.35 },
      ],
      alarm: [
        { f: 440, t: 0, d: 0.14, g: 0.3, type: 'sawtooth' },
        { f: 554.37, t: 0.15, d: 0.14, g: 0.3, type: 'sawtooth' },
        { f: 440, t: 0.3, d: 0.14, g: 0.3, type: 'sawtooth' },
        { f: 554.37, t: 0.45, d: 0.2, g: 0.3, type: 'sawtooth' },
      ],
      buzz: [{ f: 150, t: 0, d: 0.5, g: 0.35, type: 'sawtooth', to: 120 }],
      none: [],
    }
    const SOUND_IDS = [
      'chime', 'bell', 'marimba', 'blip', 'digital', 'wood', 'drop',
      'success', 'attention', 'alarm', 'buzz', 'none',
    ]

    /** @type {AudioContext | undefined} */
    let audioContext

    /**
     * Lazily create (and resume) the shared AudioContext.
     * @returns the context, or undefined when Web Audio is unavailable.
     */
    function audio() {
      if (typeof window === 'undefined') return undefined
      const Ctor = window.AudioContext || window.webkitAudioContext
      if (typeof Ctor !== 'function') return undefined
      try {
        if (audioContext === undefined || audioContext.state === 'closed') audioContext = new Ctor()
        if (audioContext.state === 'suspended') {
          const pending = audioContext.resume()
          if (pending && typeof pending.catch === 'function') pending.catch(() => {})
        }
        return audioContext
      } catch (error) {
        console.error('[project-sounds] audio context', error)
        return undefined
      }
    }

    /**
     * Schedule one preset on an AudioContext.
     * @param ac - target context.
     * @param notes - preset notes.
     * @param volume - master volume, 0..1.
     */
    function synthesize(ac, notes, volume) {
      const now = ac.currentTime + 0.01
      const master = ac.createGain()
      master.gain.setValueAtTime(Math.max(0, Math.min(1, volume)), now)
      master.connect(ac.destination)
      for (const note of notes) {
        const start = now + (note.t || 0)
        const duration = note.d || 0.2
        const oscillator = ac.createOscillator()
        const gain = ac.createGain()
        oscillator.type = note.type || 'sine'
        oscillator.frequency.setValueAtTime(note.f, start)
        if (note.to !== undefined) {
          oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, note.to), start + duration)
        }
        gain.gain.setValueAtTime(0.0001, start)
        gain.gain.linearRampToValueAtTime(note.g || 0.4, start + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
        oscillator.connect(gain)
        gain.connect(master)
        oscillator.start(start)
        oscillator.stop(start + duration + 0.03)
      }
    }

    /**
     * Play one named preset. Silence, unknown names and disabled audio are no-ops.
     * @param name - preset id.
     * @param volume - master volume.
     */
    function playSound(name, volume) {
      if (name === undefined || name === null || name === 'none') return
      const notes = SOUNDS[name]
      if (notes === undefined || notes.length === 0) return
      const ac = audio()
      if (ac === undefined) return
      try {
        synthesize(ac, notes, volume)
      } catch (error) {
        console.error('[project-sounds] play', error)
      }
    }

    /* ------------------------------------------------------------------ *
     * Persistent configuration
     * ------------------------------------------------------------------ */

    /**
     * Event sounds shipped before the current defaults were chosen. A stored
     * configuration that still matches all three was never customized.
     */
    const LEGACY_DEFAULTS = { done: 'chime', attention: 'attention', error: 'buzz' }

    /** @returns a fresh default configuration object. */
    function defaults() {
      return {
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
        projects: {},
        hostBacked: false,
      }
    }

    /**
     * Clamp a number to an inclusive range, falling back to a default.
     * @param value - candidate.
     * @param min - lower bound.
     * @param max - upper bound.
     * @param fallback - value for non-finite input.
     * @returns the clamped number.
     */
    function clampNumber(value, min, max, fallback) {
      const number = Number(value)
      if (!Number.isFinite(number)) return fallback
      return Math.min(max, Math.max(min, number))
    }

    /**
     * Normalize one sound id.
     * @param value - candidate.
     * @param fallback - value used when the candidate is not a known preset.
     * @returns a known preset id.
     */
    function soundId(value, fallback) {
      return typeof value === 'string' && SOUND_IDS.indexOf(value) !== -1 ? value : fallback
    }

    /**
     * Normalize the persisted per-project overrides. Accepts both the object
     * shape and the earlier string shape (`w1: 'bell'` meaning the done sound).
     * @param raw - stored overrides.
     * @returns a safe map of project overrides.
     */
    function sanitizeProjects(raw) {
      const out = {}
      if (raw === null || typeof raw !== 'object') return out
      for (const key of Object.keys(raw)) {
        const value = raw[key]
        if (typeof value === 'string') {
          if (value !== 'inherit' && SOUND_IDS.indexOf(value) !== -1) out[key] = { done: value }
          continue
        }
        if (value === null || typeof value !== 'object') continue
        const entry = {}
        for (const event of EVENTS) {
          const candidate = value[event]
          if (typeof candidate === 'string' && candidate !== 'inherit' && SOUND_IDS.indexOf(candidate) !== -1) {
            entry[event] = candidate
          }
        }
        if (Object.keys(entry).length > 0) out[key] = entry
      }
      return out
    }

    /**
     * Normalize a whole configuration, regardless of where it came from.
     * @param raw - stored or Host-provided value.
     * @returns a complete, safe configuration.
     */
    function sanitize(raw) {
      const out = defaults()
      if (raw === null || typeof raw !== 'object') return out
      out.enabled = raw.enabled !== false
      const volume = Number(raw.volume)
      out.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : out.volume
      out.done = soundId(raw.done, out.done)
      out.attention = soundId(raw.attention, out.attention)
      out.error = soundId(raw.error, out.error)
      out.onlyWhenHidden = raw.onlyWhenHidden === true
      out.repeatEnabled = raw.repeatEnabled === true
      out.repeatMode = raw.repeatMode === 'count' ? 'count' : 'ack'
      out.repeatIntervalSeconds = Math.round(
        clampNumber(raw.repeatIntervalSeconds, REPEAT_MIN_SECONDS, REPEAT_MAX_SECONDS, out.repeatIntervalSeconds),
      )
      out.repeatCount = Math.round(
        clampNumber(raw.repeatCount, REPEAT_MIN_COUNT, REPEAT_MAX_COUNT, out.repeatCount),
      )
      out.projects = sanitizeProjects(raw.projects)
      return out
    }

    /**
     * Compare two configuration objects without caring about key order.
     * @param left - first value.
     * @param right - second value.
     * @returns whether both serialize to the same JSON.
     */
    function sameConfig(left, right) {
      return stableJson(left) === stableJson(right)
    }

    /**
     * Deterministic JSON for configuration comparison.
     * @param value - value to serialize.
     * @returns a canonical string.
     */
    function stableJson(value) {
      if (value === null || typeof value !== 'object') return JSON.stringify(value)
      if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
      const keys = Object.keys(value).sort()
      return '{' + keys.map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}'
    }

    /**
     * Drop the event sounds of a configuration that still equals the previous
     * shipped defaults, so the current defaults apply. Customized sounds are
     * left untouched, as are per-project overrides.
     * @param raw - parsed value from storage.
     * @returns the value to sanitize.
     */
    function migrateLegacyDefaults(raw) {
      if (raw === null || typeof raw !== 'object') return raw
      const untouched = EVENTS.every(event => raw[event] === LEGACY_DEFAULTS[event])
      if (!untouched) return raw
      const next = { ...raw }
      for (const event of EVENTS) delete next[event]
      return next
    }

    /**
     * Create the configuration store shared by the sound engine and the page.
     *
     * The Host settings document is the source of truth once its entry is
     * served; `localStorage` remains a mirror (so a profile without the settings
     * transport still works) and the initial value before the first Host reply.
     *
     * @param ctx - Client context, used to find the optional `configForms` service.
     * @returns the store.
     */
    function createConfigStore(ctx) {
      let value = defaults()
      let hostBacked = false
      let hostForm
      let hostSeen = false
      let hostAttached = false
      let pushTimer
      let snapshot = deck()
      let migrated = false

      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw !== null) {
          const parsed = JSON.parse(raw)
          const next = migrateLegacyDefaults(parsed)
          value = sanitize(next)
          migrated = next !== parsed
        }
      } catch (error) {
        console.error('[project-sounds] config read', error)
      }
      snapshot = deck()

      const listeners = new Set()

      /** @returns the current immutable snapshot. */
      function deck() {
        return { ...value, hostBacked }
      }

      const persist = () => {
        try {
          const plain = { ...value }
          delete plain.hostBacked
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(plain))
        } catch (error) {
          console.error('[project-sounds] config write', error)
        }
      }

      const emit = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('[project-sounds] listener', error)
          }
        }
      }

      const publish = next => {
        value = next
        snapshot = deck()
        persist()
        emit()
      }

      const setHostBacked = next => {
        if (hostBacked === next) return
        hostBacked = next
        snapshot = deck()
        emit()
      }

      /** Queue one debounced write of every changed field to the Host entry. */
      const push = () => {
        if (hostForm === undefined) return
        if (pushTimer !== undefined) clearTimeout(pushTimer)
        pushTimer = setTimeout(() => {
          pushTimer = undefined
          void flush()
        }, 300)
      }

      /** Write the current value into the Host settings document. */
      async function flush() {
        const form = hostForm
        if (form === undefined) return
        const remote = form.getSnapshot()
        if (remote.status !== 'ready' || !remote.writable) return
        const current = remote.value !== null && typeof remote.value === 'object' ? remote.value : {}
        const ops = []
        for (const field of HOST_FIELDS) {
          if (sameValue(current[field], value[field])) continue
          ops.push({ op: 'set', path: [field], value: value[field] })
        }
        if (ops.length === 0) return
        try {
          await form.mutate(ops)
        } catch (error) {
          console.error('[project-sounds] settings write', error)
        }
      }

      /** @returns whether two JSON-shaped values are equal. */
      function sameValue(left, right) {
        if (left === right) return true
        if (Array.isArray(left) && Array.isArray(right)) {
          return left.length === right.length && left.every((item, index) => sameValue(item, right[index]))
        }
        if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
          const leftKeys = Object.keys(left).sort()
          const rightKeys = Object.keys(right).sort()
          if (leftKeys.length !== rightKeys.length) return false
          return leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]))
        }
        return false
      }

      /**
       * Adopt the Host value. On the first reply, fields the profile never
       * overrides keep this browser's value (so pre-existing customizations are
       * not lost), and those values are written up once; later replies win.
       */
      function adoptHost() {
        if (hostForm === undefined) return
        const remote = hostForm.getSnapshot()
        if (remote.status === 'unavailable') {
          setHostBacked(false)
          return
        }
        if (remote.status !== 'ready' || remote.value === undefined) return
        if (!hostSeen) {
          hostSeen = true
          const hostValue = sanitize(remote.value)
          const user = remote.user !== null && typeof remote.user === 'object' ? remote.user : {}
          const merged = { ...hostValue }
          for (const field of HOST_FIELDS) {
            if (Object.hasOwn(user, field)) continue
            merged[field] = value[field]
          }
          setHostBacked(true)
          if (!sameConfig(merged, value)) publish(merged)
          push()
          return
        }
        const next = sanitize(remote.value)
        setHostBacked(true)
        if (!sameConfig(next, value)) publish(next)
      }

      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['configForms'], scope => {
            if (hostAttached) return
            hostAttached = true
            hostForm = scope.configForms.get(ENTRY_ID)
            const off = hostForm.subscribe(adoptHost)
            adoptHost()
            scope.effect(() => () => {
              off()
              hostAttached = false
              hostForm = undefined
              if (pushTimer !== undefined) clearTimeout(pushTimer)
              pushTimer = undefined
            }, 'project-sounds: host settings')
          })
        } catch (error) {
          console.error('[project-sounds] config forms', error)
        }
      }

      if (migrated) persist()

      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        update(patch) {
          publish(sanitize({ ...value, ...patch }))
          push()
        },
        setProject(workspaceId, event, sound) {
          const projects = { ...value.projects }
          const entry = { ...(projects[workspaceId] || {}) }
          if (sound === 'inherit' || sound === undefined) delete entry[event]
          else entry[event] = sound
          if (Object.keys(entry).length === 0) delete projects[workspaceId]
          else projects[workspaceId] = entry
          publish(sanitize({ ...value, projects }))
          push()
        },
        pruneProjects(workspaceIds) {
          const projects = { ...value.projects }
          let changed = false
          for (const key of Object.keys(projects)) {
            if (workspaceIds.has(key)) continue
            delete projects[key]
            changed = true
          }
          if (!changed) return
          publish(sanitize({ ...value, projects }))
          push()
        },
        reset() {
          publish(defaults())
          const form = hostForm
          if (form !== undefined && form.getSnapshot().status === 'ready') {
            Promise.resolve(form.mutate(HOST_FIELDS.map(field => ({ op: 'unset', path: [field] }))))
              .catch(error => console.error('[project-sounds] settings reset', error))
          }
        },
      }
    }

    /* ------------------------------------------------------------------ *
     * Sound engine
     * ------------------------------------------------------------------ */

    /**
     * Create the event-to-sound resolver, the tab-visibility gate, and the
     * repeat scheduler.
     *
     * A repeat channel exists per Workspace (and one `*` channel for alerts
     * without a project, such as a quota notice). Opening the project in the
     * main view acknowledges its channel; the global channel is acknowledged
     * when the tab becomes visible.
     *
     * @param store - configuration store.
     * @returns the engine.
     */
    function createSoundEngine(store) {
      let lastErrorAt = 0
      const repeats = new Map()

      const resolve = (cfg, event, workspaceId) => {
        if (workspaceId !== undefined) {
          const entry = cfg.projects[workspaceId]
          if (entry !== undefined && entry[event] !== undefined) return entry[event]
        }
        return cfg[event]
      }

      const isHidden = () => {
        try {
          return typeof document !== 'undefined' && document.visibilityState === 'hidden'
        } catch (error) {
          return false
        }
      }

      const mayPlay = cfg => cfg.enabled === true && (cfg.onlyWhenHidden !== true || isHidden())

      const cancel = key => {
        const entry = repeats.get(key)
        if (entry === undefined) return
        clearInterval(entry.timer)
        repeats.delete(key)
      }

      const cancelAll = () => {
        for (const key of [...repeats.keys()]) cancel(key)
      }

      /** @returns the repeat channel key for a Workspace or the global channel. */
      const channelOf = workspaceId => (workspaceId === undefined ? '*' : String(workspaceId))

      /**
       * Start (or restart) the repeat channel of one Workspace.
       * @param event - done | attention | error.
       * @param workspaceId - owning Workspace, or undefined for global alerts.
       * @param initialPlayed - whether the first cue already played.
       */
      const schedule = (event, workspaceId, initialPlayed) => {
        const cfg = store.getSnapshot()
        if (!cfg.enabled || !cfg.repeatEnabled) return
        const key = channelOf(workspaceId)
        cancel(key)
        const intervalMs = Math.round(
          clampNumber(cfg.repeatIntervalSeconds, REPEAT_MIN_SECONDS, REPEAT_MAX_SECONDS, 15),
        ) * 1000
        const countMode = cfg.repeatMode === 'count'
        const limit = countMode
          ? Math.round(clampNumber(cfg.repeatCount, REPEAT_MIN_COUNT, REPEAT_MAX_COUNT, 1))
          : Infinity
        const deadline = countMode ? Infinity : Date.now() + REPEAT_ACK_MAX_MS
        let played = initialPlayed ? 1 : 0
        if (played >= limit) return
        const timer = setInterval(() => {
          const current = store.getSnapshot()
          if (!current.enabled || !current.repeatEnabled || played >= limit || Date.now() > deadline) {
            cancel(key)
            return
          }
          if (!mayPlay(current)) return
          played += 1
          playSound(resolve(current, event, workspaceId), current.volume)
        }, intervalMs)
        repeats.set(key, { timer, event, workspaceId })
      }

      /**
       * Ring one event now (when audible) and arm its repeat channel.
       * @param event - done | attention | error.
       * @param workspaceId - owning Workspace, when known.
       */
      const alert = (event, workspaceId) => {
        const cfg = store.getSnapshot()
        if (!cfg.enabled) {
          cancel(channelOf(workspaceId))
          return
        }
        let played = false
        if (mayPlay(cfg)) {
          playSound(resolve(cfg, event, workspaceId), cfg.volume)
          played = true
        }
        schedule(event, workspaceId, played)
      }

      return {
        event: alert,
        /**
         * Play the single error cue for every failure-like source. Throttled so
         * one incident (quota notice plus the underlying agent error) rings once.
         * @param workspaceId - owning Workspace, when known.
         */
        error(workspaceId) {
          const cfg = store.getSnapshot()
          if (!cfg.enabled) {
            cancel(channelOf(workspaceId))
            return
          }
          const now = Date.now()
          let played = false
          if (now - lastErrorAt >= ERROR_THROTTLE_MS) {
            lastErrorAt = now
            if (mayPlay(cfg)) {
              playSound(resolve(cfg, 'error', workspaceId), cfg.volume)
              played = true
            }
          }
          schedule('error', workspaceId, played)
        },
        /**
         * Play a named preset for previews, ignoring the enabled switch.
         * @param name - preset id.
         */
        preview(name) {
          playSound(name, store.getSnapshot().volume)
        },
        /**
         * Acknowledge one project: the user opened it, so its repeat stops.
         * @param workspaceId - Workspace identity.
         */
        acknowledge(workspaceId) {
          if (workspaceId === undefined) return
          cancel(channelOf(workspaceId))
        },
        /** Acknowledge alerts that carry no project (the tab is visible again). */
        acknowledgeGlobal() {
          cancel('*')
        },
        /** Re-evaluate repeats after a configuration change. */
        sync() {
          const cfg = store.getSnapshot()
          if (!cfg.enabled || !cfg.repeatEnabled) cancelAll()
        },
        /** Stop every repeat and timer. */
        dispose() {
          cancelAll()
        },
      }
    }

    /* ------------------------------------------------------------------ *
     * Session and Workspace reading
     * ------------------------------------------------------------------ */

    /**
     * Read a Client service snapshot defensively.
     * @param service - service carrying a `list` store.
     * @returns the snapshot, or undefined.
     */
    function readList(service) {
      const store = service && service.list
      if (!store || typeof store.getSnapshot !== 'function') return undefined
      try {
        return store.getSnapshot()
      } catch (error) {
        console.error('[project-sounds] snapshot', error)
        return undefined
      }
    }

    /**
     * Subscribe to a Client service snapshot defensively.
     * @param service - service carrying a `list` store.
     * @param listener - invalidation callback.
     * @returns an unsubscribe function when subscription succeeded.
     */
    function subscribeList(service, listener) {
      const store = service && service.list
      if (!store || typeof store.subscribe !== 'function') return undefined
      try {
        const off = store.subscribe(listener)
        return typeof off === 'function' ? off : undefined
      } catch (error) {
        console.error('[project-sounds] subscribe', error)
        return undefined
      }
    }

    /* ------------------------------------------------------------------ *
     * Event detection
     * ------------------------------------------------------------------ */

    /**
     * Read a session's projection values from the Client list snapshot.
     * @param snapshot - sessions list snapshot.
     * @param sessionId - session identity.
     * @returns projection values, or undefined.
     */
    function projectionValuesOf(snapshot, sessionId) {
      const projections = snapshot && snapshot.projectionsBySession
      const entry = projections === undefined ? undefined : projections[sessionId]
      return entry === undefined ? undefined : entry.values
    }

    /**
     * Phase of the durable goal projection, tolerant to both documented shapes.
     * @param values - projection values.
     * @returns the goal phase, or undefined.
     */
    function goalPhaseOf(values) {
      const projection = values === undefined ? undefined : values.goal
      if (projection === null || typeof projection !== 'object') return undefined
      const goal = projection.goal !== null && typeof projection.goal === 'object' ? projection.goal : projection
      return typeof goal.phase === 'string' ? goal.phase : undefined
    }

    /**
     * Context occupancy percentage from the token-meter projection.
     * @param values - projection values.
     * @returns the integer percentage, or undefined.
     */
    function contextPercentOf(values) {
      const pressure = values === undefined ? undefined : values.contextPressure
      if (pressure === null || typeof pressure !== 'object') return undefined
      const used = pressure.projectedTokens !== undefined ? pressure.projectedTokens : pressure.pressureTokens
      const window = pressure.contextWindow
      if (used === undefined || window === undefined || !(window > 0)) return undefined
      return Math.min(100, Math.round((used / window) * 100))
    }

    /**
     * Durable turn-end reason from this bundle's Host projection.
     * @param values - projection values.
     * @returns the projection entry, null when the host reports no ended turn,
     * or undefined when the projection is not served at all.
     */
    function turnEndOf(values) {
      if (values === undefined || !Object.hasOwn(values, 'lastTurnEnd')) return undefined
      const entry = values.lastTurnEnd
      if (entry === null || typeof entry !== 'object') return null
      return entry
    }

    /**
     * Install the Client watchers that drive the sounds.
     * @param ctx - Client context with the injected services.
     * @param store - configuration store.
     * @param engine - sound engine.
     * @returns one disposer.
     */
    function installWatchers(ctx, store, engine) {
      const disposers = []
      const doneTimers = new Map()
      const runningSince = new Map()
      const lastError = new Map()
      const subagents = new Set()
      const prevRunning = new Map()
      const prevPending = new Map()
      const prevGoal = new Map()
      const warnedPressure = new Set()
      const jobWatches = new Map()
      const jobStatus = new Map()
      const lastRunningAt = new Map()
      let pendingBaseline = true
      let goalBaseline = true
      let pressureBaseline = true
      let jobsService
      let jobsAttached = false

      const sessions = ctx.sessions
      const workspaces = ctx.workspaces
      let workspaceOfSession = new Map()

      const rowOf = sessionId => {
        const snapshot = readList(sessions)
        const byId = snapshot && snapshot.byId
        return byId === undefined ? undefined : byId[sessionId]
      }

      const isSubagent = sessionId => {
        if (subagents.has(sessionId)) return true
        const row = rowOf(sessionId)
        if (row === undefined) return false
        return row.origin === 'subagent' || row.parentId !== undefined || row.blank === true
      }

      const workspaceOf = sessionId => workspaceOfSession.get(sessionId)

      const rebuildWorkspaces = () => {
        const next = new Map()
        const snapshot = readList(workspaces)
        const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
        for (const workspace of items) {
          const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
          for (const sessionId of ids) {
            if (!next.has(sessionId)) next.set(sessionId, workspace.workspaceId)
          }
        }
        workspaceOfSession = next
      }

      /**
       * Sessions whose project is currently open in the main view. Used to
       * acknowledge a pending repeat: opening the project is what "read" means.
       * @param byId - sessions list rows.
       * @returns project ids to acknowledge.
       */
      const openedWorkspaces = byId => {
        const opened = new Set()
        for (const id of Object.keys(byId)) {
          const row = byId[id]
          const retained = row && row.retainedBy ? row.retainedBy.mainView : undefined
          if (!(retained > 0)) continue
          const workspaceId = workspaceOf(id)
          if (workspaceId !== undefined) opened.add(workspaceId)
        }
        return opened
      }

      /**
       * Whether a project is currently open in the main view. Ringing once is
       * enough there, so the watchers acknowledge it immediately and skip the
       * repeat until the project is closed and opened again.
       * @param workspaceId - project identity.
       * @returns whether that project is open.
       */
      const isWorkspaceOpen = workspaceId => {
        if (workspaceId === undefined) return false
        const snapshot = readList(sessions)
        const byId = snapshot && snapshot.byId ? snapshot.byId : {}
        for (const id of Object.keys(byId)) {
          const retained = byId[id] && byId[id].retainedBy ? byId[id].retainedBy.mainView : undefined
          if (retained > 0 && workspaceOf(id) === workspaceId) return true
        }
        return false
      }

      /** Ring one event and drop a repeat when the project is already open. */
      const alert = (event, workspaceId) => {
        engine.event(event, workspaceId)
        if (isWorkspaceOpen(workspaceId)) engine.acknowledge(workspaceId)
      }

      /** Ring the failure cue and drop a repeat when the project is already open. */
      const alertError = workspaceId => {
        engine.error(workspaceId)
        if (isWorkspaceOpen(workspaceId)) engine.acknowledge(workspaceId)
      }

      /* ------------------------------ jobs ------------------------------ */

      /** @returns the number of roster streams currently held. */
      const jobWatcherCount = () => jobWatches.size

      /** Keep roster watches for running sessions and a short tail after they stop. */
      const rebuildJobWatches = () => {
        if (jobsService === undefined) return
        const snapshot = readList(sessions)
        const byId = snapshot && snapshot.byId ? snapshot.byId : {}
        const now = Date.now()
        const desired = []
        for (const id of Object.keys(byId)) {
          if (isSubagent(id)) continue
          const running = byId[id] && byId[id].running === true
          const last = lastRunningAt.get(id)
          if (running || (last !== undefined && now - last < JOB_WATCH_GRACE_MS)) desired.push(id)
        }
        desired.sort((left, right) => (lastRunningAt.get(right) ?? 0) - (lastRunningAt.get(left) ?? 0))
        const keep = new Set(desired.slice(0, JOB_WATCH_LIMIT))
        for (const [id, entry] of jobWatches) {
          if (keep.has(id)) continue
          entry()
          jobWatches.delete(id)
          jobStatus.delete(id)
        }
        for (const id of keep) {
          if (jobWatches.has(id) || jobWatcherCount() >= JOB_WATCH_LIMIT) continue
          try {
            const release = jobsService.watchRows(id)
            if (typeof release === 'function') jobWatches.set(id, release)
          } catch (error) {
            console.error('[project-sounds] job watch', error)
          }
        }
      }

      /** Ring the error cue when a watched background job settles as failed. */
      const onJobsChanged = () => {
        if (jobsService === undefined) return
        let snapshot
        try {
          snapshot = jobsService.state.getSnapshot()
        } catch (error) {
          console.error('[project-sounds] jobs snapshot', error)
          return
        }
        const rows = snapshot && snapshot.rows ? snapshot.rows : {}
        for (const sessionId of Object.keys(rows)) {
          if (!jobWatches.has(sessionId)) continue
          const previous = jobStatus.get(sessionId)
          const next = new Map()
          for (const job of rows[sessionId]) {
            const id = String(job.id)
            const status = job.status
            next.set(id, status)
            if (previous === undefined || status !== 'failed') continue
            if (previous.get(id) === 'failed') continue
            alertError(workspaceOf(sessionId))
          }
          jobStatus.set(sessionId, next)
        }
      }

      /** Attach the optional Client jobs service. */
      const attachJobs = service => {
        if (jobsAttached || service === undefined) return
        jobsAttached = true
        jobsService = service
        try {
          const off = service.state.subscribe(onJobsChanged)
          if (typeof off === 'function') disposers.push(off)
        } catch (error) {
          console.error('[project-sounds] jobs subscribe', error)
        }
        rebuildJobWatches()
        onJobsChanged()
      }

      /* --------------------------- projections -------------------------- */

      /**
       * Fold one sessions-list snapshot into running baselines, subagent
       * identity, opened projects, and the failure sources that live in
       * session projections.
       */
      const rebuildSessions = () => {
        const snapshot = readList(sessions)
        const byId = snapshot && snapshot.byId ? snapshot.byId : {}
        subagents.clear()
        for (const id of Object.keys(byId)) {
          const row = byId[id]
          if (row === undefined) continue
          if (row.origin === 'subagent' || row.parentId !== undefined) subagents.add(id)
          if (!prevRunning.has(id)) {
            const running = row.running === true
            prevRunning.set(id, running)
            if (running) {
              runningSince.set(id, Date.now())
              lastRunningAt.set(id, Date.now())
            }
          }
        }
        for (const workspaceId of openedWorkspaces(byId)) engine.acknowledge(workspaceId)
        for (const id of Object.keys(byId)) {
          if (isSubagent(id)) continue
          const values = projectionValuesOf(snapshot, id)
          const phase = goalPhaseOf(values)
          if (!goalBaseline && phase === 'blocked' && prevGoal.get(id) !== 'blocked') {
            alertError(workspaceOf(id))
          }
          prevGoal.set(id, phase)
          const percent = contextPercentOf(values)
          if (percent !== undefined) {
            if (!pressureBaseline && percent >= CONTEXT_WARN_PERCENT && !warnedPressure.has(id)) {
              warnedPressure.add(id)
              alertError(workspaceOf(id))
            } else if (percent < CONTEXT_REARM_PERCENT) {
              warnedPressure.delete(id)
            }
          }
        }
        goalBaseline = false
        pressureBaseline = false
        rebuildJobWatches()
      }

      const clearDoneTimer = sessionId => {
        const timer = doneTimers.get(sessionId)
        if (timer !== undefined) {
          clearTimeout(timer)
          doneTimers.delete(sessionId)
        }
      }

      /**
       * Ring the completion sound (or the failure sound) for a finished turn,
       * using the durable reason when the Host projection is available.
       * @param sessionId - finished Session.
       * @param retry - whether a stale projection may still catch up once.
       */
      const finishTurn = (sessionId, retry) => {
        if (isSubagent(sessionId)) return
        const workspaceId = workspaceOf(sessionId)
        const errorAt = lastError.get(sessionId)
        if (errorAt !== undefined && Date.now() - errorAt < ERROR_SUPPRESSION_MS) return
        const values = projectionValuesOf(readList(sessions), sessionId)
        const entry = turnEndOf(values)
        const startedAt = runningSince.get(sessionId) ?? 0
        if (entry !== undefined && entry !== null) {
          const fresh = typeof entry.at === 'number' && entry.at + TURN_END_FRESH_MS >= startedAt
          if (fresh) {
            dispatchTurnEnd(entry.kind, workspaceId)
            return
          }
        }
        if (entry !== undefined && !retry) {
          doneTimers.set(
            sessionId,
            setTimeout(() => {
              doneTimers.delete(sessionId)
              finishTurn(sessionId, true)
            }, DONE_RETRY_MS),
          )
          return
        }
        alert('done', workspaceId)
      }

      /**
       * Map a durable turn-end reason onto a cue.
       * @param kind - `turn/end.reason.kind`.
       * @param workspaceId - owning Workspace, when known.
       */
      const dispatchTurnEnd = (kind, workspaceId) => {
        if (kind === 'completed') {
          alert('done', workspaceId)
          return
        }
        if (kind === 'aborted' || kind === 'forked') return
        if (kind === 'error' || kind === 'max-tokens' || kind === 'blocked' || kind === 'interrupted') {
          alertError(workspaceId)
        }
      }

      const onStatus = (sessionId, running) => {
        const was = prevRunning.get(sessionId)
        prevRunning.set(sessionId, running === true)
        if (running === true) {
          clearDoneTimer(sessionId)
          runningSince.set(sessionId, Date.now())
          lastRunningAt.set(sessionId, Date.now())
          rebuildJobWatches()
          return
        }
        if (was !== true) return
        if (isSubagent(sessionId)) return
        clearDoneTimer(sessionId)
        doneTimers.set(
          sessionId,
          setTimeout(() => {
            doneTimers.delete(sessionId)
            finishTurn(sessionId, false)
          }, DONE_DELAY_MS),
        )
        rebuildJobWatches()
      }

      const onError = sessionId => {
        clearDoneTimer(sessionId)
        lastError.set(sessionId, Date.now())
        alertError(workspaceOf(sessionId))
      }

      const listen = (name, handler) => {
        if (!ctx.remote || typeof ctx.remote.$on !== 'function') return
        try {
          const off = ctx.remote.$on(name, handler)
          if (typeof off === 'function') disposers.push(off)
        } catch (error) {
          console.error('[project-sounds] listen ' + name, error)
        }
      }

      listen('api-session/status', onStatus)
      listen('api-session/error', onError)
      listen('deepseek-account/session-expired', () => alertError(undefined))
      listen('deepseek-account/model-sign-in-required', () => alertError(undefined))

      const offSessions = subscribeList(sessions, rebuildSessions)
      if (offSessions !== undefined) disposers.push(offSessions)
      const offWorkspaces = subscribeList(workspaces, rebuildWorkspaces)
      if (offWorkspaces !== undefined) disposers.push(offWorkspaces)
      rebuildSessions()
      rebuildWorkspaces()

      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['jobs'], scope => attachJobs(scope.jobs))
        } catch (error) {
          console.error('[project-sounds] jobs injection', error)
        }
      }
      if (typeof ctx.get === 'function') attachJobs(ctx.get('jobs'))

      const uiSession = ctx.uiSession
      const status = uiSession && uiSession.sessionStatus
      if (status && typeof status.subscribe === 'function' && typeof status.getSnapshot === 'function') {
        const checkPending = () => {
          let snapshot
          try {
            snapshot = status.getSnapshot()
          } catch (error) {
            console.error('[project-sounds] status', error)
            return
          }
          if (!snapshot || typeof snapshot.forEach !== 'function') return
          const seen = new Map()
          snapshot.forEach((state, sessionId) => {
            const kind = state === undefined || state === null ? undefined : state.pendingInteraction
            if (kind === undefined || kind === null) return
            seen.set(sessionId, kind)
            const previous = prevPending.get(sessionId)
            if (pendingBaseline || previous !== undefined) {
              prevPending.set(sessionId, kind)
              return
            }
            prevPending.set(sessionId, kind)
            if (isSubagent(sessionId)) return
            alert('attention', workspaceOf(sessionId))
          })
          for (const sessionId of [...prevPending.keys()]) {
            if (seen.has(sessionId)) continue
            prevPending.delete(sessionId)
            engine.acknowledge(workspaceOf(sessionId))
          }
          pendingBaseline = false
        }
        try {
          const off = status.subscribe(checkPending)
          if (typeof off === 'function') disposers.push(off)
          checkPending()
        } catch (error) {
          console.error('[project-sounds] pending subscribe', error)
        }
      }

      const onVisibility = () => {
        try {
          if (document.visibilityState === 'visible') engine.acknowledgeGlobal()
        } catch (error) {
          console.error('[project-sounds] visibility', error)
        }
      }

      const unlock = () => {
        engine.acknowledgeGlobal()
        const ac = audio()
        if (ac !== undefined && ac.state === 'suspended') {
          const pending = ac.resume()
          if (pending && typeof pending.catch === 'function') pending.catch(() => {})
        }
      }
      try {
        window.addEventListener('pointerdown', unlock, true)
        window.addEventListener('keydown', unlock, true)
        document.addEventListener('visibilitychange', onVisibility)
        disposers.push(() => {
          window.removeEventListener('pointerdown', unlock, true)
          window.removeEventListener('keydown', unlock, true)
          document.removeEventListener('visibilitychange', onVisibility)
        })
      } catch (error) {
        console.error('[project-sounds] gesture unlock', error)
      }

      return () => {
        engine.dispose()
        for (const timer of doneTimers.values()) clearTimeout(timer)
        doneTimers.clear()
        for (const release of jobWatches.values()) {
          try {
            release()
          } catch (error) {
            console.error('[project-sounds] job release', error)
          }
        }
        jobWatches.clear()
        jobStatus.clear()
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch (error) {
            console.error('[project-sounds] dispose', error)
          }
        }
      }
    }

    /**
     * Observe the frame-wide quota notice chain without claiming the surface:
     * the selector records the notice and lets the shipped UI render it.
     * @param ctx - Client context.
     * @param engine - sound engine.
     * @returns one disposer.
     */
    function observeQuotaNotices(ctx, engine) {
      const seen = new Map()
      const select = owner => {
        if (owner !== null && typeof owner === 'object' && typeof owner.code === 'string') {
          const now = Date.now()
          const previous = seen.get(owner.code)
          if (previous === undefined || now - previous > QUOTA_THROTTLE_MS) {
            seen.set(owner.code, now)
            engine.error(undefined)
          }
        }
        return null
      }
      try {
        if (ctx.slots && typeof ctx.slots.inject === 'function') {
          const dispose = ctx.slots.inject('shell.quota-notice', () =>
            ctx.slots.register(
              {
                name: 'shell.quota-notice',
                select,
              },
              function QuotaSoundObserver() {
                return null
              },
            ),
          )
          return typeof dispose === 'function' ? dispose : () => {}
        }
      } catch (error) {
        console.error('[project-sounds] quota observer', error)
      }
      return () => {}
    }

    /* ------------------------------------------------------------------ *
     * Locale dictionaries
     * ------------------------------------------------------------------ */

    const en = {
      title: 'Project sounds',
      subtitle:
        'Play a distinct sound when a turn finishes, when a decision is needed, and on failures. Every project can override any of the three sounds or use the shared one.',
      enabled: 'Enable sound notifications',
      volume: 'Volume',
      events: 'Shared sounds',
      done: 'Turn finished',
      attention: 'Approval or question',
      error: 'Error',
      errorHint:
        'One failure sound covers errors, quotas, context limits, blocked goals, failed background jobs and crashed subagents.',
      preview: 'Preview',
      onlyWhenHidden: 'Only while the tab is in the background',
      onlyWhenHiddenHint: 'Do not ring when the DSH window is active.',
      repeat: 'Repeat until noticed',
      repeatHint:
        'Repeat the cue when it may have been missed. Opening the project acknowledges it; alerts without a project stop when the tab becomes visible.',
      repeatEnabled: 'Repeat the sound until the project is opened',
      repeatMode: 'Stop condition',
      repeatModeAck: 'When the project is opened',
      repeatModeCount: 'After a set number of plays',
      repeatInterval: 'Interval, seconds',
      repeatCount: 'Number of plays',
      repeatAckNote: 'A repeat stops after 10 minutes even if the project was never opened.',
      projects: 'Sounds per project',
      projectHint:
        'Pick a sound for a project to override the shared one; leave it on “Shared” to inherit. The approval/question and error rows work the same way.',
      inheritShort: 'Shared',
      reset: 'Restore defaults',
      storageHost: 'Settings are stored in the DSH profile and shared between browsers.',
      storageLocal: 'Settings are stored in this browser.',
      emptyProjects: 'No projects yet — they appear once a workspace has sessions.',
      soundChime: 'Chime',
      soundBell: 'Bell',
      soundMarimba: 'Marimba',
      soundBlip: 'Blip',
      soundDigital: 'Digital',
      soundWood: 'Wood',
      soundDrop: 'Drop',
      soundSuccess: 'Success',
      soundAttention: 'Attention',
      soundAlarm: 'Alarm',
      soundBuzz: 'Buzz',
      soundNone: 'Silent',
    }

    const ru = {
      title: 'Звуки проектов',
      subtitle:
        'Звук при завершении работы, при запросе разрешения или ответа и при сбоях. Каждый проект может переопределить любой из трёх звуков или использовать общий.',
      enabled: 'Включить звуковые уведомления',
      volume: 'Громкость',
      events: 'Общие звуки',
      done: 'Работа завершена',
      attention: 'Нужно разрешение или ответ',
      error: 'Ошибка',
      errorHint:
        'Один звук ошибки покрывает ошибки, квоты, лимит контекста, заблокированные цели, упавшие фоновые задачи и падения сабагентов.',
      preview: 'Прослушать',
      onlyWhenHidden: 'Только когда вкладка в фоне',
      onlyWhenHiddenHint: 'Не играть, пока окно DSH активно.',
      repeat: 'Автоповтор',
      repeatHint:
        'Повторять сигнал, если его могли не услышать. Открытие проекта считается прочтением; сигналы без проекта замолкают, когда вкладка снова видна.',
      repeatEnabled: 'Повторять звук, пока проект не открыт',
      repeatMode: 'Когда остановиться',
      repeatModeAck: 'Когда проект открыт',
      repeatModeCount: 'После заданного числа повторов',
      repeatInterval: 'Интервал, секунд',
      repeatCount: 'Число повторов',
      repeatAckNote: 'Повтор прекращается через 10 минут, даже если проект так и не открыли.',
      projects: 'Звуки по проектам',
      projectHint:
        'Выберите звук для проекта, чтобы заменить общий; «Общий» — наследовать. Строки «Нужно разрешение» и «Ошибка» работают так же.',
      inheritShort: 'Общий',
      reset: 'Вернуть значения по умолчанию',
      storageHost: 'Настройки хранятся в профиле DSH и общие для всех браузеров.',
      storageLocal: 'Настройки хранятся в этом браузере.',
      emptyProjects: 'Проектов пока нет — они появятся, когда в рабочей папке будут сессии.',
      soundChime: 'Перезвон',
      soundBell: 'Колокольчик',
      soundMarimba: 'Маримба',
      soundBlip: 'Бип',
      soundDigital: 'Цифровой',
      soundWood: 'Дерево',
      soundDrop: 'Капля',
      soundSuccess: 'Успех',
      soundAttention: 'Внимание',
      soundAlarm: 'Сирена',
      soundBuzz: 'Зуммер',
      soundNone: 'Тишина',
    }

    /* ------------------------------------------------------------------ *
     * Settings page
     * ------------------------------------------------------------------ */

    const CSS = `
.ps-page{display:flex;flex-direction:column;gap:18px;box-sizing:border-box;padding:4px 0 32px;color:var(--dsw-alias-label-primary);}
.ps-head{display:flex;flex-direction:column;gap:4px;}
.ps-title{margin:0;font-size:16px;font-weight:500;line-height:24px;}
.ps-sub{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;}
.ps-card{border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}
.ps-cardHead{padding:10px 14px;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:13px;font-weight:500;line-height:20px;}
.ps-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 14px;border-top:.5px solid var(--dsw-alias-border-l2);}
.ps-row:first-of-type{border-top:0;}
.ps-rowMain{display:flex;flex-direction:column;gap:2px;min-width:0;}
.ps-rowTitle{font-size:13px;line-height:20px;}
.ps-rowHint{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;}
.ps-rowEnd{display:flex;align-items:center;gap:8px;flex:none;}
.ps-select{appearance:auto;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;font:inherit;font-size:12.5px;line-height:18px;padding:4px 8px;max-width:220px;}
.ps-select:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.ps-btn{flex:none;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:4px 10px;cursor:pointer;}
.ps-btn:active{background:var(--dsw-alias-interactive-bg-active);}
@media (hover:hover){.ps-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}}
.ps-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.ps-switch{position:relative;flex:none;width:34px;height:20px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);cursor:pointer;padding:0;transition:background .15s ease;}
.ps-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.ps-switch[aria-checked='true']{background:var(--dsw-alias-brand-primary);border-color:transparent;}
.ps-thumb{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:999px;background:var(--dsw-alias-bg-base);transition:transform .15s ease;display:block;}
.ps-switch[aria-checked='true'] .ps-thumb{transform:translateX(14px);}
.ps-slider{flex:none;width:140px;accent-color:var(--dsw-alias-brand-primary);}
.ps-value{flex:none;width:42px;text-align:right;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;}
.ps-number{flex:none;width:74px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;font:inherit;font-size:12.5px;line-height:18px;padding:4px 8px;box-sizing:border-box;text-align:right;font-variant-numeric:tabular-nums;}
.ps-number:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.ps-projects{max-height:440px;overflow:auto;}
.ps-project{padding:10px 14px;border-top:.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:8px;}
.ps-project:first-of-type{border-top:0;}
.ps-projectHead{display:flex;flex-direction:column;gap:1px;min-width:0;}
.ps-projectTitle{font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ps-projectPath{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ps-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;}
.ps-field{display:flex;flex-direction:column;gap:3px;min-width:0;}
.ps-fieldLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;}
.ps-field .ps-select{max-width:none;width:100%;box-sizing:border-box;}
.ps-empty{padding:12px 14px;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:18px;}
.ps-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}
.ps-note{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;}
`

    /** Page-local stylesheet. @returns the style element. */
    function StyleSheet() {
      return h('style', { 'data-project-sounds': '' }, CSS)
    }

    /**
     * Subscribe to a store snapshot.
     * @param source - store exposing `subscribe` and `getSnapshot`.
     * @returns the current snapshot.
     */
    function useSnapshot(source) {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
      }
      const pair = React.useState(() => source.getSnapshot())
      React.useEffect(() => source.subscribe(() => pair[1](source.getSnapshot())), [source])
      return pair[0]
    }

    /**
     * One labelled settings row.
     * @param props - row props.
     * @returns the row element.
     */
    function Row(props) {
      return h(
        'div',
        { className: 'ps-row' },
        h(
          'div',
          { className: 'ps-rowMain' },
          h('span', { className: 'ps-rowTitle' }, props.title),
          props.hint === undefined ? null : h('span', { className: 'ps-rowHint' }, props.hint),
        ),
        h('div', { className: 'ps-rowEnd' }, props.children),
      )
    }

    /**
     * A native select over the sound catalogue.
     * @param props - select props.
     * @returns the select element.
     */
    function SoundSelect(props) {
      const options = [props.allowInherit ? 'inherit' : undefined, ...SOUND_IDS].filter(Boolean)
      return h(
        'select',
        {
          className: 'ps-select',
          value: props.value,
          onChange: event => props.onChange(event.target.value),
          'aria-label': props.label,
        },
        options.map(id =>
          h(
            'option',
            { key: id, value: id },
            id === 'inherit'
              ? props.inheritLabel
              : props.t('sound' + id.charAt(0).toUpperCase() + id.slice(1)),
          ),
        ),
      )
    }

    /**
     * A labelled numeric input.
     * @param props - input props.
     * @returns the input element.
     */
    function NumberInput(props) {
      return h('input', {
        type: 'number',
        className: 'ps-number',
        min: props.min,
        max: props.max,
        step: props.step,
        value: props.value,
        onChange: event => props.onChange(Number(event.target.value)),
        'aria-label': props.label,
      })
    }

    /**
     * The settings navigation icon, matching the bundle's `icon.svg`.
     * @param props - `{ size, active }` from the settings shell.
     * @returns the SVG element.
     */
    function SectionIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          viewBox: '0 0 32 32',
          width: size,
          height: size,
          fill: 'none',
          'aria-hidden': true,
        },
        h('rect', { x: 5, y: 12, width: 6, height: 8, rx: 1.5, stroke: 'currentColor', strokeWidth: 2 }),
        h('path', { d: 'M11 12.5 17.5 7v18L11 19.5', stroke: 'currentColor', strokeWidth: 2, strokeLinejoin: 'round' }),
        h('path', { d: 'M21.5 11.5a6.5 6.5 0 0 1 0 9', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
        h('path', { d: 'M24.5 8.5a10.5 10.5 0 0 1 0 15', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
      )
    }

    /**
     * The Settings → Project sounds page.
     * @param props - injected props (store, engine, t) plus standard props.
     * @returns the page element.
     */
    function SettingsPage(props) {
      const { store, engine, t, useWorkspaces } = props
      const config = useSnapshot(store)
      let workspacesSnapshot
      try {
        workspacesSnapshot = useWorkspaces(snapshot => snapshot)
      } catch (error) {
        workspacesSnapshot = undefined
      }
      const items = workspacesSnapshot && Array.isArray(workspacesSnapshot.items) ? workspacesSnapshot.items : []

      // Drop overrides of projects that no longer exist, but never before the
      // workspace list has loaded (otherwise every entry would look stale).
      React.useEffect(() => {
        if (items.length === 0) return
        store.pruneProjects(new Set(items.map(workspace => String(workspace.workspaceId))))
      }, [items, store])

      const eventRow = (key, title, hint) =>
        h(
          Row,
          { key, title, hint },
          h(SoundSelect, {
            value: config[key],
            label: title,
            t,
            onChange: value => {
              store.update({ [key]: value })
              engine.preview(value)
            },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'ps-btn',
              onClick: () => engine.preview(config[key]),
            },
            t('preview'),
          ),
        )

      const switchRow = (key, title, hint) =>
        h(
          Row,
          { key, title, hint },
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              className: 'ps-switch',
              'aria-label': title,
              'aria-checked': config[key] ? 'true' : 'false',
              onClick: () => store.update({ [key]: !config[key] }),
            },
            h('span', { className: 'ps-thumb' }),
          ),
        )

      return h(
        'div',
        { className: 'ps-page' },
        h(StyleSheet),
        h(
          'header',
          { className: 'ps-head' },
          h('h1', { className: 'ps-title' }, t('title')),
          h('p', { className: 'ps-sub' }, t('subtitle')),
        ),
        h(
          'section',
          { className: 'ps-card' },
          switchRow('enabled', t('enabled')),
          h(
            Row,
            { title: t('volume') },
            h('input', {
              type: 'range',
              className: 'ps-slider',
              min: 0,
              max: 100,
              step: 5,
              value: Math.round(config.volume * 100),
              onChange: event => store.update({ volume: Number(event.target.value) / 100 }),
              'aria-label': t('volume'),
            }),
            h('span', { className: 'ps-value' }, Math.round(config.volume * 100) + '%'),
          ),
          switchRow('onlyWhenHidden', t('onlyWhenHidden'), t('onlyWhenHiddenHint')),
        ),
        h(
          'section',
          { className: 'ps-card' },
          h('div', { className: 'ps-cardHead' }, t('events')),
          eventRow('done', t('done')),
          eventRow('attention', t('attention')),
          eventRow('error', t('error'), t('errorHint')),
        ),
        h(
          'section',
          { className: 'ps-card' },
          h('div', { className: 'ps-cardHead' }, t('repeat')),
          h('div', { className: 'ps-empty' }, t('repeatHint')),
          switchRow('repeatEnabled', t('repeatEnabled')),
          h(
            Row,
            { title: t('repeatMode') },
            h(SoundModeSelect, {
              value: config.repeatMode,
              t,
              onChange: value => store.update({ repeatMode: value }),
            }),
          ),
          h(
            Row,
            { title: t('repeatInterval'), hint: config.repeatMode === 'ack' ? t('repeatAckNote') : undefined },
            h(NumberInput, {
              min: REPEAT_MIN_SECONDS,
              max: REPEAT_MAX_SECONDS,
              step: 5,
              value: config.repeatIntervalSeconds,
              label: t('repeatInterval'),
              onChange: value => store.update({ repeatIntervalSeconds: value }),
            }),
          ),
          config.repeatMode === 'count'
            ? h(
                Row,
                { title: t('repeatCount') },
                h(NumberInput, {
                  min: REPEAT_MIN_COUNT,
                  max: REPEAT_MAX_COUNT,
                  step: 1,
                  value: config.repeatCount,
                  label: t('repeatCount'),
                  onChange: value => store.update({ repeatCount: value }),
                }),
              )
            : null,
        ),
        h(
          'section',
          { className: 'ps-card' },
          h('div', { className: 'ps-cardHead' }, t('projects')),
          h('div', { className: 'ps-empty' }, t('projectHint')),
          items.length === 0
            ? h('div', { className: 'ps-empty' }, t('emptyProjects'))
            : h(
                'div',
                { className: 'ps-projects' },
                items.map(workspace => {
                  const workspaceId = String(workspace.workspaceId)
                  const entry = config.projects[workspaceId] || {}
                  const title = workspace.title || workspace.path || workspaceId
                  const field = (event, label) =>
                    h(
                      'div',
                      { className: 'ps-field', key: event },
                      h('span', { className: 'ps-fieldLabel' }, label),
                      h(SoundSelect, {
                        value: entry[event] === undefined ? 'inherit' : entry[event],
                        label: title + ' — ' + label,
                        t,
                        allowInherit: true,
                        inheritLabel: t('inheritShort') + ' · ' + t(
                          'sound' + config[event].charAt(0).toUpperCase() + config[event].slice(1),
                        ),
                        onChange: value => {
                          store.setProject(workspaceId, event, value)
                          if (value !== 'inherit') engine.preview(value)
                        },
                      }),
                    )
                  return h(
                    'div',
                    { className: 'ps-project', key: workspaceId },
                    h(
                      'div',
                      { className: 'ps-projectHead' },
                      h('span', { className: 'ps-projectTitle', title }, title),
                      workspace.path === undefined
                        ? null
                        : h('span', { className: 'ps-projectPath', title: workspace.path }, workspace.path),
                    ),
                    h(
                      'div',
                      { className: 'ps-grid' },
                      field('done', t('done')),
                      field('attention', t('attention')),
                      field('error', t('error')),
                    ),
                  )
                }),
              ),
        ),
        h(
          'footer',
          { className: 'ps-foot' },
          h('span', { className: 'ps-note' }, config.hostBacked ? t('storageHost') : t('storageLocal')),
          h(
            'button',
            { type: 'button', className: 'ps-btn', onClick: () => store.reset() },
            t('reset'),
          ),
        ),
      )
    }

    /**
     * Select over the repeat stop condition.
     * @param props - select props.
     * @returns the select element.
     */
    function SoundModeSelect(props) {
      return h(
        'select',
        {
          className: 'ps-select',
          value: props.value,
          'aria-label': props.t('repeatMode'),
          onChange: event => props.onChange(event.target.value),
        },
        h('option', { value: 'ack' }, props.t('repeatModeAck')),
        h('option', { value: 'count' }, props.t('repeatModeCount')),
      )
    }

    /* ------------------------------------------------------------------ *
     * Plugin
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale', 'sessions', 'workspaces', 'uiSession', 'remote'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { en, ru }),
          'project-sounds: dictionaries',
        )
        const t = ctx.locale.bind(NS)
        const store = createConfigStore(ctx)
        const engine = createSoundEngine(store)
        const disposeWatchers = installWatchers(ctx, store, engine)
        ctx.effect(() => () => disposeWatchers(), 'project-sounds: session watchers')
        ctx.effect(
          () => store.subscribe(() => engine.sync()),
          'project-sounds: engine sync',
        )
        ctx.effect(() => {
          const dispose = observeQuotaNotices(ctx, engine)
          return () => {
            engine.dispose()
            dispose()
          }
        }, 'project-sounds: quota observer')
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: SECTION_ID,
              order: 25,
              locale: NS,
              label: () => t('title'),
              inject: () => ({ store, engine, t }),
            },
            SettingsPage,
          ),
        )
        ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register(
            {
              name: 'settings.section.icon',
              id: SECTION_ID,
            },
            SectionIcon,
          ),
        )
      },
    }
  },
})
