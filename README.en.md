# Project sounds — per-project audio notifications for DeepSeek Harness

[Русский](README.md) | English

Repository: [github.com/cyberx3mal/DSH-Sounds](https://github.com/cyberx3mal/DSH-Sounds)

A DeepSeek Harness (DSH) Web UI plugin that plays a short synthesized cue when:

- **a turn finished** (successfully);
- **your decision is needed** — an approval request, a question, or a plan awaiting review;
- **something failed** — agent error, exhausted quota, context near its limit, blocked goal, failed background job, crashed subagent, or a turn that ended as an error or hit the output-token ceiling.

Every project (working directory / Workspace) can override **any of the three sounds** or share the global one. If a cue may have been missed, **repeat until the project is opened** — or repeat a set number of times at a chosen interval.

## What's new in 1.1.0

- The sound distinguishes why a turn ended: "Stop" no longer sounds like "Work finished", while errors and token limits ring the alarm.
- Failed background jobs (`ctx.jobs`) play the error cue.
- Settings live in the DSH profile (shared by all browsers) with a `localStorage` fallback.
- Repeat until the project is opened, or N times at an interval.
- "Only while the tab is in the background" mode, a settings icon, and `aria-label`s on switches.
- Bogus alarm sounds after page reload (already blocked goal or full context) are gone.
- Tests, GitHub Actions, and cleanup of overrides for deleted projects.

## Requirements

- DSH with bundle-plugin support (`dsh.bundle.patch`, `dsh.profile.bundles`) — verified on Desktop `0.2.2-rc.2`.
- The Host half needs the `@deepseek-ai/schemastery` package (declared in `dependencies`; installed automatically by `dsh plugin`).
- No system dependencies: audio is synthesized in the browser through Web Audio.

## Installation

### 1. From npm

```sh
npm publish --access public
```

On the receiving machine (profile `desktop` for DSH Desktop, `web` for `dsh web` — use yours):

```sh
dsh plugin --profile desktop add dsh-plugin-project-sounds
```

### 2. From GitHub

```sh
dsh plugin --profile desktop add github:cyberx3mal/DSH-Sounds

# pin the version (recommended):
dsh plugin --profile desktop add github:cyberx3mal/DSH-Sounds#v1.1.0
```

### 3. From a local folder (for testing or handing over an archive)

```sh
dsh plugin --profile desktop add file:C:/path/to/dsh-plugin-project-sounds
```

A local install creates a link (`link:`), so dependencies are not installed automatically — run this in the plugin folder:

```sh
npm install
```

Without it the Host half cannot import `@deepseek-ai/schemastery`; browser sounds keep working, but settings stay in the browser.

> Do not move or delete the folder after installation — the plugin will stop loading. For a permanent setup, unpack the archive into a stable location.

### 4. Manually, without the CLI

1. Unpack the package folder.
2. Copy it to `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-plugin-project-sounds`.
3. In `%USERPROFILE%\.dsh\profiles\<profile>\package.json` add:
   - to `dependencies`: `"dsh-plugin-project-sounds": "1.1.0"`;
   - to `dsh.profile.bundles`: `"dsh-plugin-project-sounds"`.
4. Run `npm install` in the plugin folder and restart DSH.

Changing the Host half (plugin version, `index.js`) requires a DSH restart; client-only changes are picked up by refreshing the page (`Ctrl+R`).

## Usage

1. Open **Settings** (the gear icon at the bottom left).
2. Choose the **Project sounds** section — it now has an icon.
3. What is inside:
   - **Enable sound notifications** — the master switch;
   - **Volume** — 0–100%;
   - **Only while the tab is in the background** — do not ring while the DSH window is active;
   - **Shared sounds** — the three defaults: "Turn finished" → **Chime**, "Approval or question" → **Wood**, "Error" → **Alarm**; with a "Preview" button next to each;
   - **Repeat until noticed** — repeat the cue when it may have been missed:
     - **Stop condition**: "When the project is opened" or "After a set number of plays";
     - **Interval**: 5–300 seconds;
     - **Number of plays**: 1–30 (for the count mode).
   - **Sounds per project** — three dropdowns per project: "Done", "Attention", "Error". The **"Shared"** value inherits the sound from the block above (the label shows which one); picking a sound previews it immediately;
   - **Restore defaults**.
4. After the first click or key press the browser unlocks Web Audio — sounds then play on their own.

### What counts as "read"

- A project repeat stops when the project **is open in the main area** (any of its sessions is visible), or when a pending approval/question is closed. If the project was already open when the cue fired, it rings once — no repeat is needed.
- Cues without a project (quota, expired sign-in) stop when the tab is visible again or you click inside the window.
- In the "until the project is opened" mode the repeat still stops after 10 minutes so it cannot ring forever.

### Where settings are stored

Settings live in the **DSH profile** (the Host settings document) and are shared by all browsers connected to that profile. On the first run, fields the profile has not overridden yet are taken from the browser and written to the profile once; values explicitly saved in the profile win. While Host settings are unavailable or the profile is read-only, the browser's `localStorage` is used. The bottom of the settings page states which mode is active.

## How it works

- The client half (`client.js`) subscribes only to public DSH surfaces:
  `api-session/status` (turn start/finish), `api-session/error`, `deepseek-account/*`,
  `ctx.uiSession.sessionStatus` (pending approval/question/plan-review),
  the `goal`, `contextPressure`, and `lastTurnEnd` projections from `ctx.sessions.list`,
  the `ctx.jobs` background-job roster, the `shell.quota-notice` chain,
  and `retainedBy.mainView` on session rows (an open project counts as read).
- The Host half (`index.js`) registers the `lastTurnEnd` projection (`turn/end` reasons:
  `completed`, `aborted`, `blocked`, `error`, `max-tokens`, `interrupted`, `forked`)
  and declares a volatile `Config` with every setting so the client reads and writes it through `ctx.configForms`.
- Sounds are 12 built-in presets synthesized on the spot (oscillators plus envelopes); there are no audio files.
- Subagents do not ring the "finished" cue (to keep things quiet), but their errors do ring the error cue.
- A user "Stop" produces `aborted` and stays silent; errors and token limits ring the alarm.

## Limitations

- Web UI only (DSH Desktop and `dsh web`); with the window fully closed there is no sound — that would need a Host plugin with a system sound.
- Background jobs are watched for sessions running now or during the last 5 minutes (at most 24 sessions at a time); a job that fails much later does not ring.
- "Read" means an open project, not open settings: opening the settings page does not stop a repeat.
- Host-profile settings are shared between browsers, so volume and repeat settings are shared too (unlike the old localStorage-only behavior).
- If the profile is read-only, settings stay local to the browser.

## Development

```sh
npm install
npm test          # node --test: host + client, including migration and repeats
npm run check     # node --check index.js && node --check client.js
```

The code is plain ESM plus the browser's `window.__ModuleLoader__.load`; no build step. Tests load the real `client.js` with stubs for `window`, `localStorage`, Web Audio, and DSH services, so they exercise behavior rather than a copy of the logic. CI — `.github/workflows/ci.yml`.

## Structure

```
package.json          bundle manifest + dsh.client + schemastery dependency
cordis.patch.yml      inserts the Loader row
index.js              Host half: Config + lastTurnEnd projection
client.js             sound engine, detectors, repeats, settings page
locale/en.json        Plugin Manager metadata (en)
locale/ru.json        Plugin Manager metadata (ru)
README.md             Russian version of this readme
test/                 host and client tests (node --test)
.github/workflows/    CI
icon.svg              icon
LICENSE               MIT
```

## Credits

The plugin started as a simple turn-completion sound and grew together with the DSH notification-sound plugin ecosystem. The early version was assembled and customized on top of one of those plugins; the exact upstream source could not be identified — the public plugins did not match the code, and the early version has since been substantially rewritten. If you recognize your code or idea here and would like credit, open an issue and we will add it.

## License

MIT — see [LICENSE](./LICENSE).
