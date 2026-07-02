# SuperAgents

You've got one model writing the roleplay. SuperAgents gives you a whole crew of little helpers running alongside it, each doing one job — tracking the weather, catching continuity slip-ups, polishing prose, texting you in-character, quietly plotting what happens next turn.

An **agent** is a small prompt with a job and a schedule. It fires before or after the main reply, does its one thing, and gets out of the way. Some inject a note the main model reads, some rewrite the reply after the fact, some just track state in the background and show it in a little panel. You can use the built-ins as-is, tweak them, or write your own.

Enjoy :) -moki

---

## How It Works

Every agent has a **phase** — when it runs relative to your main reply:

- **Pre-gen** — runs *before* the main model writes, and injects its result into the prompt. This is how you steer a reply: a scene director outlining the next beat, a randomizer tossing in an event, dynamic writing instructions.
- **Post-gen** — runs *after* the reply lands. Reads what happened and does something with it: tracking state, checking continuity, cleaning up prose.

And a **mode** — what it actually does:

- **Sidecar** — a separate LLM call that produces a note or a tracked value. Doesn't touch your reply's text. Most trackers work this way.
- **Rewrite / Append** — an LLM pass that edits the reply itself (rewrites it) or tacks something onto the end.
- **Extract / Merge Variable** — pulls structured data out of a response (via regex) and stores it, no extra LLM call needed. This is what feeds the HUD bars and state panels.

Agents can run on their own **connection profile**, so your trackers and polishers can use a cheap fast model while your main model handles the actual roleplay.

## The Modal

Open it from the wand menu (the people-group icon) or `/sa-open`. From here you manage your agents, browse the built-in library, build groups, and change settings. Toggle agents on and off, edit their prompts, set their phase/mode, assign connection profiles, and import/export.

## Built-In Agents

A starting library you can use directly or copy and modify. Roughly by job:

**Trackers** — quiet post-gen state tracking, shown in HUD bars or floating panels.
- **World State** — location, date, time, weather, temperature in a compact bar at the top of each message.
- **State Card** — a floating panel tracking world events, {{user}}'s physical state, and per-character relationship dynamics.
- **Narrative Engine** — spatial positioning, physical state, dress, motifs, themes, and open threads.
- **Parallel Off-Screen** — what absent characters and factions are up to between scenes.
- **Secret Keeper** — who knows what, who's lying, and who's still in the dark.

**Continuity & prose** — keep the writing honest and clean.
- **Continuity Check** — flags character mix-ups, location jumps, timeline drift, and environment slips against the history.
- **Prose Guardian** — pre-gen dynamic writing directives: bans repeated words, rotates rhetorical devices, enforces sensory variety.
- **Prose Polisher** — post-gen cleanup that rewrites repetitive tropes and weak patterns (ported from SillyBunny, expanded).

**Direction & randomizers** — steer or shake up the scene.
- **Director** — a pre-gen scene director. A separate (ideally smarter) model reads the whole scene and outlines what should happen next turn, injected into the reply and shown as an editable block.
- **Direction Menu** — after each reply, offers four ways forward: a variation, the opposite, an outside intrusion, and a wildcard.
- **Event Spark** — randomly drops in a narrative event or story seed (~30% chance per turn).
- **Intimacy & Kink Randomiser** — rolls position, kink, pacing, and mental-state variables at the start of a sexual scene.
- **Dead Dove Escalation** — lets characters act on their worst impulses when the context supports it. Enable per scene, disable to return to normal tone.

**Phone / Messenger** — a diegetic texting channel. Characters text {{user}}'s persona through an in-story phone and you text back — for scheming, flirting, logistics, the things they wouldn't say out loud. Has its own floating panel.

*Note: Many of these are either ports or remakes of agents originally part of Marinara Engine, SillyBunny, or just ones I've found while browsing. These don't currently have versions for SillyTavern afaik, that's why I ported them. All credit goes to the original creators!*

## Groups

Bundle agents that belong together and toggle them as a unit. Handy for a "tracking suite" you want on every chat, or a scene-specific set (say, the intimacy randomizer + escalation) you flip on and off together.

## Settings

In the modal's Settings tab.

- **Connection Profiles** — default profile for agent calls, overridable per agent.
- **State Card & Phone panels** — show/hide the floating panels.
- **Stop button style** — reuse ST's native stop (✕) to cancel an in-flight agent run, or use a separate dedicated button.
- **Debug** — verbose console logging.

## Macros

Agents that track state expose it as macros you can drop into prompts, world info, or author's notes:

- `{{agent_<var>}}` — the formatted value of a tracked variable (e.g. the current world state).
- `{{agent_<var>_raw}}` — the same value unformatted.

The exact variable names depend on your agents; check an agent's Merge Variable settings for its variable name.

## Slash Commands

- `/sa-open` — open the management modal
- `/sa-list` — list configured agents and their enabled state
- `/sa-run [name]` — run an agent on the last assistant message (accepts `message=N` to target a specific one)
- `/sa-toggle [name]` — enable/disable an agent

## Installation

Use SillyTavern's built-in extension installer:

1. Open **Extensions** → **Install Extension**
2. Paste this URL:
   ```
   https://github.com/mokimoko/SillyTavern-SuperAgents
   ```
3. Click **Install** and reload if prompted

## Tips

- Put your trackers and polishers on a cheap, fast connection profile. They don't need your best model, and you'll save time and tokens on every turn.
- Start small. Turn on one or two agents, get a feel for them, then add more. Running everything at once means a lot of extra calls per turn.
- Pre-gen agents cost you latency before the reply (you wait on them first); post-gen agents run after, so the reply shows up right away and the extras fill in behind it.
- Post-gen rewrite agents keep the original — there's a per-message diff viewer to see what changed, with a revert.
