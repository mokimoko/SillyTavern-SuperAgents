# SuperAgents

A SillyTavern extension. Successor to VerseManager's `agents` feature —
extracted into a standalone extension, restructured, and improved.

**Status:** v0.8.0 — feature-complete core. Lifecycle engine, batching,
renderers, phone, slash commands, and the cost hint are all live. Remaining
work is optional polish (see the gameplan).

SuperAgents runs small LLM "agents" against your roleplay — before and after
each message — to extract structured state, rewrite prose, or text you back in
character. Its differentiator over similar tools is **per-agent connection
profile selection** plus **JSON-envelope batching**: many trackers on one
profile collapse into a single call.

## Features

- **Sidecar / tracker agents** — post-gen LLM calls that extract structured
  state (world state, continuity, narrative engine, off-screen action, etc.)
  into persistent variables, with per-swipe storage and styled HUD rendering
  that survives swipes.
- **Pre-gen agents** — analyze recent history *before* the main generation and
  inject the result into the upcoming prompt.
- **Rich context** — any sidecar/pre-gen agent can opt into the same inputs the
  main chat sees: character card, player persona, active World Info, the running
  summary, the author's note, and the *pending* user message (read from the
  textarea before it's committed to chat). Per-agent toggles in the editor.
- **Director** — a built-in pre-gen agent that uses rich context to outline what
  should happen next turn, injects the plan wrapped in `<director>` tags, and
  displays it as a HUD block under the reply. The Director extension's idea,
  rebuilt on the shared agent pipeline (batching, persistence, per-swipe state).
- **Injection templates** — pre-gen output can be wrapped before it enters the
  prompt (`{{output}}` placeholder), so a plan reads as direction, not dialogue.
- **Batched sidecars** — agents sharing a connection profile are combined into
  one JSON-envelope call, capped to avoid backend truncation, with per-key
  salvage so one malformed key doesn't drop the whole batch.
- **Rewrite / append agents** — post-gen prose rewrite or append.
- **Phone agent** — diegetic texting via a floating messenger panel.
- **Groups** — sequential or parallel execution ordering across agents.
- **Renderers** — World State, Continuity Check, Narrative Engine, Direction
  Menu, Parallel Off-Screen, and Director-plan HUDs.
- **Cost hint** — a per-turn line showing agents-run vs actual calls, so the
  batching saving is visible (toggle: `showCostHint`).
- **Compatibility guard + macros** — coexists with other generation-driving
  extensions; exposes tracker state as `{{agent_<var>}}` macros.

## Slash commands

| Command | What it does |
|---|---|
| `/sa-run [name]` | Run an agent on the last assistant message. `message=N` targets a specific index. |
| `/sa-list` | List configured agents with enabled state, phase, and category. |
| `/sa-toggle [name]` | Toggle an agent on/off. |
| `/sa-open` | Open the management modal. |

Commands are namespaced `sa-*` so SuperAgents and VerseManager can stay
installed side by side without colliding.

## Layout

```
SillyTavern-SuperAgents/
  manifest.json
  index.js              ← thin entry: namespace + init wiring
  style.css
  src/
    core/
      llm.js            ← single LLM call path (callAgentLLM)
      profiles.js       ← connection-profile resolution + legacy swap
      lifecycle.js      ← generation event engine (the orchestrator)
      activation.js     ← shouldActivate / snapshot
      idempotency.js    ← per-message run tracking
      compatibility.js  ← mutex guard vs other gen-driving extensions
      macros.js         ← {{agent_<var>}} state macros
      callStats.js      ← per-turn / per-session call accounting (cost hint)
      slashCommands.js  ← /sa-* commands
    modes/
      sidecar.js        ← solo + pre-gen sidecar
      batch.js          ← JSON-envelope batching by profile
      mergeVariable.js  ← accumulate / snapshot structured state
      rewrite.js        ← rewrite + append
      postProcess.js    ← non-LLM extract / append
    data/
      store.js          ← CRUD + persistence
      normalize.js · templateSync.js · importExport.js
    render/
      renderer.js       ← MutationObserver + HUD injection
      regexProcessor.js ← structured-tag extraction (length/time-bounded)
      hooks/            ← per-template renderers
    phone/              ← phoneAgent.js, phonePanel.js
    ui/                 ← modal + tabs, editor, stateCard
    templates/          ← built-in agent JSON templates
```

## Global settings

Set via `SuperAgents.settings.set({ ... })`:

| Key | Default | Meaning |
|---|---|---|
| `connectionProfile` | `''` | default profile when an agent has none |
| `defaultExecutionMode` | `parallel` | group execution mode default |
| `showNotifications` | `true` | per-batch progress toasts |
| `showCostHint` | `true` | per-turn agents-vs-calls hint |
| `batchByProfile` | `true` | group sidecars by profile into one envelope |
| `batchMaxTokens` | `16384` | cap on the batched envelope |
| `respectMutex` | `true` | honor other extensions' generation mutex |
| `useNativeStopButton` | `true` | reuse ST's native ✕ to cancel a run + hide the send button while it runs; `false` uses a separate `#sa_stop` button |

## Cost hint (dev console)

```js
SuperAgents.stats.get();
// → { turnCalls, turnAgents, sessionCalls, sessionAgents }

SuperAgents.stats.formatTurn();
// → "3 agents · 1 call this turn (batched 2 away) · 12 this session"
```

## Verifying the keystone (dev console)

```js
await SuperAgents.callAgentLLM({
    systemPrompt: 'You are a one-word echo. Reply with a single word.',
    userContent: 'echo back the word "fish"',
    profileRef: '',          // current profile
    maxTokens: 16,
    callerName: 'manual-test',
});
// → "fish"

SuperAgents.profiles.listConnectionProfiles();
// → [{id, name}, ...]
```

See `AGENTS_EXTRACTION_GAMEPLAN.md` for the full design rationale and the
remaining optional polish.
