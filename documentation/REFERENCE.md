# SuperAgents

You've got one model writing the roleplay. SuperAgents gives you a whole crew of little helpers running alongside it, each doing one job — tracking the weather, catching continuity slip-ups, polishing prose, texting you in-character, sharing off-scene social posts, quietly plotting what happens next turn.

An **agent** is a small prompt with a job and a schedule. It fires before or after the main reply, does its one thing, and gets out of the way. Some inject a note the main model reads, some rewrite the reply after the fact, some just track state in the background and show it in a little panel. You can use the built-ins as-is, tweak them, or write your own.

Enjoy :) -moki

---

## How It Works

Every agent has a **phase** — when it runs relative to your main reply:

- **Pre-gen** — runs *before* the main model writes, and usually injects its result into the prompt. This is how you steer a reply: a scene director outlining the next beat, a randomizer tossing in an event, dynamic writing instructions. Pre-gen sidecars can instead keep their result private when another component only needs their remembered state.
- **Post-gen** — runs *after* the reply lands. Reads what happened and does something with it: tracking state, checking continuity, cleaning up prose.

And a **mode** — what it actually does:

- **Sidecar** — a separate LLM call that produces a note or a tracked value. Doesn't touch your reply's text. Most trackers work this way.
- **Rewrite / Append** — an LLM pass that edits the reply itself (rewrites it) or tacks something onto the end.
- **Extract / Merge Variable** — pulls structured data out of a response (via regex) and stores it, no extra LLM call needed. This is what feeds the HUD bars and state panels.

Structured tracker updates can be schema-validated before they commit. The built-in State Card, World State, Narrative Engine, Relationship Ledger, Social Web Ledger, Knowledge Ledger, and Parallel Off-Screen reject malformed updates and preserve their last good state. Validation can also enforce cross-turn rules such as nondecreasing history, maximum per-turn changes, append-only milestones, bounded keyed collections, and conditional caps or minimums. Tracker state and validation records are stored per swipe, so changing branches restores the appropriate state. Deleting messages restores live tracker values from the last surviving branch snapshot, including World State's clock, and removes Phone, Feed, Calendar, and Activity records anchored in the deleted tail so they cannot reappear when new messages reuse those positions.

Parallel Off-Screen additionally uses bounded retention. It keeps at most eight characters in its active simulation frontier, hides unchanged entries after two tracker runs, and prunes them after five. Imminent, countdown, approaching, and urgent threads receive a longer grace period. Dormant characters remain recoverable through chat, Phone history, and durable memory rather than consuming tracker tokens forever.

Knowledge Ledger uses a conservative token budget instead of ordinary age-based deletion. Sixteen records is its normal working target and 24 is the hard schema ceiling. Unchanged records become dormant after four tracker runs, but structural, durable, open, private/secret, unresolved, gated, linked, or perspective-divergent records are never automatically pruned. Only resolved public contextual records with no remaining information split can age out. The main chat receives compact detail for the 12 highest-priority records plus tiny warning stubs for the rest; the tracker and State Card keep the full validated state.

Optional consumers use a separate fail-closed Knowledge Access API. It checks one character's recorded perspective before offering non-disclosing capabilities such as noticing, investigating, concealing, cover-story strain, or approaching evidence. Candidate payloads omit the proposition, truth status, evidence basis, disclosure policy, and prerequisite text. Automatic disclosure is deliberately unsupported while reveal prerequisites remain authorial prose rather than machine-verifiable gates.

Agents can run on their own **connection profile**, so your trackers and polishers can use a cheap fast model while your main model handles the actual roleplay. SuperAgents Settings can also define an optional default connection for every agent that does not have an explicit profile.

Agents can also be scoped to selected character cards, native SillyTavern tags, or group chats. This lets setting- and character-specific workers stay dormant everywhere else.

Agents also have reusable **initialization / one-shot policies** in addition to their ordinary cadence. **Run until remembered state exists** retries an initializer until its Memory output successfully validates and commits, then sleeps. **Once per chat** and **once per story branch** run on the first eligible generation in that scope and then sleep. Sleeping agents do not consume probability rolls or every-N attempts. `/sa-clear [agent name]` clears that agent's current-chat memory and re-arms its policy.

## The Modal

Open it from the wand menu (the people-group icon) or `/sa-open`. From here you manage your agents, browse the built-in library, build groups, and change settings. The editor starts with two choices — **when it runs** and **what it does** — then reveals only the settings used by that route. The execution section includes normal cadence, run-until-initialized, once-per-chat, and once-per-branch policies. Custom post-gen sidecars can remember their complete output without a regex and optionally show it as a generic collapsible note under the message.

On the Agents tab, the square checkbox selects an agent for bulk actions, the pill switch enables or disables it, and clicking the card opens its editor. The compact header icons select/deselect all, enable/disable the checked agents, delete the checked agents with confirmation, create an agent, import, or export. Hover an icon for its label.

The every-N throttle can reuse the original reply's run/skip decision on swipes (default) or count every swipe and regeneration as a new attempt. The global **Defer post-agents while swiping** option avoids automatic post-reply model calls while you choose a reroll, keeps the last committed snapshots available, and catches due agents up once after the next regular reply; pre-generation helpers still prepare each reroll. Memory agents can also opt into **Reuse saved snapshot between runs**: skipped turns make no provider call, while the latest branch snapshot remains available to the main prompt, macros, and integrations. The icon gallery is collapsed by default to keep the identity section compact.

**Economy Mode** in Settings gives newly added Library agents curated lower-call cadences without changing custom or existing agents. Its separate apply action can update cadence-related settings on existing Library instances after confirmation, or restore the standard Library defaults when the mode is off.

For tracker-style agents, choose **Structured fields** under Memory. The visual builder supports text, numbers, booleans, lists, nested groups, one-entry-per-name collections, limits, required fields, and common across-turn rules. It generates a live JSON example for the prompt and maintains the validation schema automatically. Existing structured library agents open in the same builder. Raw regex and schema controls remain available under **Developer details** for unusual formats and legacy tagged output.

## Built-In Agents

A starting library you can use directly or copy and modify. Roughly by job:

**Trackers** — quiet post-gen state tracking, shown in HUD bars or floating panels.
- **World State** — the authoritative current environment and clock: location, date, time of day, weather, temperature, and indoor/outdoor/in-transit staging. It renders a compact bar and exposes validated branch-aware fields to Dynamic Events.
- **Scene State** — a floating panel tracking {{user}}'s physical state and each present character's immediate condition, feeling, resources, and allegiance. Routine environmental facts stay in World State; background developments stay in World Events; relationship meters stay in Relationship Ledger.
- **Narrative Engine** — spatial positioning, physical state, dress, motifs, themes, and open threads.
- **Relationship Ledger** — separate affection, attraction, trust, comfort, respect, familiarity, fear, and jealousy meters for every relevant named character, plus their interpretation, stance, milestones, and significant events. It keeps off-screen characters and treats scenario or multi-character card titles separately from narrative character names. Canonical arc milestones distinguish acknowledged love from its constraints, meaningful vulnerability or repaired trust from meter thresholds, and who betrayed whom from confrontation, accountability, restitution, forgiveness, and the relationship's later terms. Affection may remain high without granting access, and forgiveness never restores a relationship automatically.
- **Social Web Ledger** — a bounded directional graph of important NPC-to-NPC ties, including public/private stance, trust, tension, obligation, current pressure, power, visibility, and durable milestones. Dynamic Events can bind both endpoints of an edge and turn the graph into long-term story motion.
- **Knowledge Ledger** — a token-budgeted information graph that keeps objective truth separate from what each character knows, believes, suspects, or rejects. It admits only continuity-relevant information asymmetry, safely retires fully resolved contextual records, and injects a compact disclosure-critical projection into the main chat rather than its verbose tracker state.
- **Parallel Off-Screen** — a bounded, validated active roster for independent character life: presence, location, activity, goal, next action, availability, contact intent, visibility, social targets, and relevance. Unchanged threads decay out instead of accumulating forever; Dynamic Events and Phone consume the same branch-aware record.

**Continuity & prose** — keep the writing honest and clean.
- **Continuity Check** — flags character mix-ups, location jumps, timeline drift, and environment slips against the history.
- **Prose Guardian** — pre-gen dynamic writing directives: bans repeated words, rotates rhetorical devices, enforces sensory variety.
- **Prose Polisher** — post-gen cleanup that rewrites repetitive tropes and weak patterns (ported from SillyBunny, expanded).

**Direction & randomizers** — steer or shake up the scene.
- **Prompt Base + Prompt NSFW** — a staged pair for the optional Dynamic Events
  Adaptive Prompt Kit and Bodies & Pairings preset. Base silently classifies author, focus character, mood,
  impairment, recent injury, NSFW status, and violence before every reply.
  Prompt NSFW runs only after Base stores a fresh validated `nsfw=true` result,
  then classifies the specialized body, pairing, participant-count, established
  experience, and relationship fields. Unknown experience remains unknown rather
  than being inferred from an absent sexual history.
  Neither agent injects raw output into the writer prompt.
- **Director** — a pre-gen scene director. A separate (ideally smarter) model reads the whole scene and outlines what should happen next turn, injected into the reply and shown as an editable block.
- **World Events** — every eight replies by default, reads the character/persona, lore, summaries, recent history, and—when installed—eligible Simple Summarizer batch memory and context archives. It proposes five varied major/average/minor, local/distant, positive/neutral/negative developments. The distinct Utilities button at the far right of the Story Apps row opens **World Threads**, where Suggestions wait until reviewed, approved threads can be edited or resolved, and finished threads form a compact branch history. Use Generate or Refresh in that utility whenever you want a new set immediately. Only active threads enter the story prompt; None explicitly discards a suggestion set.
- **Direction Menu** — after each reply, offers four ways forward: a variation, the opposite, an outside intrusion, and a wildcard.
- **Event Spark** — legacy/deprecated; use Dynamic Events → Presets → Event Spark for branch-aware scheduling.
- **Intimacy & Kink Randomiser** — rolls position, kink, pacing, and mental-state variables at the start of a sexual scene.
- **After Dark** — an on-demand NSFW planning UtilityApp. It privately proposes several character-aware setups, pairings, dynamics, and kinks, then lets you preview or adapt only the beats you want and steer the live beat from a compact draggable controller. Choose one chat-local progression mode: deterministic Auto advances one beat per completed reply without another model call, Smart Nudge can share a compatible post-reply batch and quietly signal when the beat looks complete, diverged, or overshot, and None leaves progression fully manual. The private lorebook probe can wake keyword-gated NSFW entries without posting those terms to chat.
- **Drama Queen** — a private dramatic-pressure planner. It finds grounded fault lines and proposes six-beat engines, then lets you manually steer the live beat, pressure, and damage ceiling. Previewing future beats stays private and never changes writer injection; the compact controller and optional Smart Nudge keep the current beat close at hand.
- **Dead Dove Escalation** — lets characters act on their worst impulses when the context supports it. Enable per scene, disable to return to normal tone.

**Character perspective** — optional post-scene flavor without a separate Story app.
- **Character Diary** — writes a candid private entry from the focus character's point of view and displays it as a collapsed parchment page beneath the message. It uses World State's in-story date and time when available, falls back without inventing calendar details, and can also be run manually. Its Standard cadence averages about one entry per 20 eligible replies (every 10 with a 50% chance); Economy averages about one per 27 (every 20 with a 75% chance).

**Phone / Messenger** — a diegetic private-communication channel. Under Modern, characters text {{user}}'s persona through an in-story phone and you text back. Presentation profiles can change both the surface and its communication rules without changing the stored thread or integration ID.

**Social Feed / Moments** — a branch-aware shared social surface. Under Modern it supports posts, comments, reactions, and privacy-aware audiences. Presentation profiles may reinterpret the same stable artifacts as another social medium and disable affordances that do not belong there. The panel works manually in every chat; enable the library agent to let characters publish from their own lives. Dynamic Events → Social Ripples can supply restrained posting cues.

**Activity + Notifications** — a small shared artifact spine connecting the digital surfaces without replacing them. Phone still owns messages, Feed owns posts, and Calendar owns commitments; Activity stores bounded, branch-aware references and projects their unread items into one source-linked notification center. Opening an item returns to its exact source artifact. Existing visible source history is indexed on upgrade, and every source continues working if Notifications is hidden or unused. Future apps can publish the same neutral artifact envelope and register their own opener through the public API.

**Calendar / Commitments** — a branch-aware source for appointments, promises, deadlines, reminders, availability, and obligations. Its records use setting-neutral exact, relative, windowed, recurring, story-anchored, or unscheduled time expressions; Gregorian dates belong only to the modern presentation profile. The included Almanac reference profile proves that authored local-calendar labels survive without conversion. Active commitments receive a compact prompt projection, but they never declare themselves completed, missed, cancelled, or fulfilled without an explicit status change. Calendar can passively capture one newly established, persona-accessible canonical plan from a response while refusing tentative proposals, vague intentions, repeated mentions, inferred outcomes, private/off-screen NPC plans, or plans already recorded; it never introduces or steers toward a plan merely to fill the Calendar. Missed or cancelled commitments can open a branch-authorized, multi-turn reconciliation window: tentative negotiation does nothing, a concrete canonical replacement creates one linked successor, and the original remains history. An unresolved window becomes a non-steering dormant watcher after sixteen messages so later rescheduling can still be captured without repeatedly pushing the story toward it. Deleting messages or changing swipes restores already-authorized capabilities on the surviving branch without leaking records into sibling branches. Calendar publishes source references through Activity and can be opened directly from Notifications.

**Group Chat** — an OOC UtilitiesApp for texting with the imagined writers responsible for story characters. Its first opening shows each stage while it builds a compact shared story reference and composes the opener. Cards act as ownership/avatar sources rather than automatic writer names: the generated roster resolves the actual current characters, supports several characters from one card, and maps short names and aliases without creating duplicate writers. Writers receive unique playful chat handles and distinct OOC identities designed to contrast interestingly with their characters, discuss those characters in third person, and exchange short, loose, intentionally chatty messages rather than polished story critiques. The composer includes a compact emoji picker, response generation uses an unlabeled typing ellipsis, and individual room messages can be deleted. Room settings live in Room Details; compact roster controls rebuild knowledge or wipe conversation memory. The per-room connection selector inherits the SuperAgents default or current SillyTavern connection when left blank. Full character names such as `@Ren Tully`, short names, aliases, and writer handles highlight and route correctly; otherwise one or two suitable writers may answer in a single provider call and can respond to one another. Optional auto mode comments after a configurable base interval plus randomized delay. At 30 room messages, the oldest 20 become a compact summary while the newest 10 remain verbatim; five summaries consolidate into historical memory. Wiping conversation memory keeps the generated story reference.

State Card, Notifications, Phone, Feed, and Calendar have compact **Story apps** launchers in the top-left of the chat. Available launchers appear whenever a story chat is open, independent of whether that panel's saved default is on or off. Use them—or a panel's X—to show or hide a surface for that chat without disabling its agent or changing the default for new chats. Each chat remembers those open/closed choices across reloads. A muted dot appears when a closed surface has unread activity.

State Card has its own chat-scoped **State Card style** control beneath Story presentation. **SillyTavern Theme** preserves the original theme-aware glass card and remains the compatibility default. **Match Story Presentation** follows the active profile automatically. **Modern** is a fixed graphite/stone editorial design with clean uniform outlines; it stays nearly monochrome except for restrained semantic colors on Relationship Ledger and Social Web meters, so their collapsed summaries remain readable without labels. **Cute Retro** presents the same tracker data as a cream-plastic, tabbed personal organizer. **Retro Analog** turns it into a compact pastel 1990s story-database window with beveled chrome, an aqua desktop grid, file-like tracker sections, and software-style progress meters. **Gamer Modern** presents a dark, modular VRMMO Status Panel with luminous cyan telemetry, source-aware magenta/violet/amber accents, crisp channel frames, and schema-authored meter colors. **Grounded Historical** uses a leather-bound commonplace-book treatment with warm CSS-drawn parchment, antiquity gold, olive and sage, weathered slate-teal, terra cotta, and umber. Its paper is built from broad translucent tonal layers and edge shading rather than tiled dots, distressed imagery, or striped ornament. **Historical Fantasy** turns the same validated data into a compact charcoal **Story Ledger** with black leather, deep crimson seals, aged-brass rules, bone text, and schema-aware segmented meters inspired by dense fantasy character sheets without inheriting game mechanics. **Xianxia** turns the same validated tracker data into a light celadon-and-mist **Cloud Ledger** with quiet symmetrical silk-glass folios, mountain blue-grey, dusk blush, clean schema-colored meters, and tiny cinnabar accents. Its profile-specific header visually uses **Cloud Ledger** alone while retaining the generic State Card identity underneath. **Post-Apocalyptic** presents the same validated data as smoked-alloy **Field Status**: near-black equipment glass, bone-gray type, thin worn-metal frames, restrained rust signaling, and muted schema-colored segmented meters. It avoids neon, military-command decoration, hazard-stripe clutter, and generic wasteland props. **Near Future** presents the same validated data as a coral-and-cyan **Context Matrix**: transparent navy infographic glass, calm section headers, open information rows, hairline separators, tabular labels, and luminous schema-aware segmented meters. Explicit profile styles stay locked even when Story presentation changes; tracker data, section behavior, collapse state, and resizing are unaffected.

Knowledge Ledger records can be folded individually or expanded/collapsed together from the Ledger section header. Each record also has a small delete control. Deletion asks for confirmation, preserves sibling records, and removes the selected record from the live ledger, current-turn baseline, retention bookkeeping, and every stored branch snapshot in that chat. Because the Knowledge Ledger remains an active tracker, a later run may recreate a deleted record if ongoing story evidence makes it relevant again.

Phone, Feed, Notifications, Calendar, and their Story apps launchers read from one **chat-scoped story presentation profile**. The profile owns visible names, icons, copy, vocabulary, theme hooks, capability flags, and model-facing medium rules while storage keys, action types, branch state, and source IDs remain stable. **Modern** is the default digital profile. **Cute Retro** presents Answering Machine, Bulletin Board, Updates, and Planner with asynchronous recorded calls, physical postings, no typing/read receipts or Feed reactions, and playful cream-plastic/corkboard/stationery styling. Bulletin Board replies appear as smaller notes tucked beneath the original pin. **Retro Analog** is the separate dot-com-era home-computer profile: E-Mail, BB Board, Desktop Alerts, and Personal Organizer use pastel beveled desktop chrome, asynchronous dial-up semantics, threaded BBS replies, and no modern social algorithms or reactions. **Gamer Modern** presents Whispers, World Board, System Alerts, and Event Tracker as one contemporary VRMMO interface. Its behavior contract keeps private channels private, treats the World Board as deliberate audience-scoped publication rather than surveillance, refuses to invent player/NPC status or game mechanics, and prevents Event Tracker from promoting ordinary commitments into system-issued quests. **Grounded Historical** presents Correspondence, Society Pages, Notices, and an Engagement Book. Its model contract treats letters as separately composed physical artifacts with plausible delivery and privacy boundaries; Society Pages as bounded, edited circulation whose delayed replies are filed as **Letters & Corrections**, not live comments; and historical time as authored watches, bells, seasons, regnal dates, or local reckoning rather than automatically Gregorian, minute-precise scheduling. All five Grounded Historical panel headers share deep leather brown, and the paper surfaces use quiet CSS parchment without dot or stripe motifs. Its Story-app launchers have no shared tray: four material-colored controls float independently, while State Card is a round terra-cotta seal. The profile deliberately avoids assuming European aristocracy, Regency/Victorian conventions, common literacy, reliable post, or universal readership. **Historical Fantasy** presents **Missives**, a **Rumor Board**, **Dispatches**, and an **Almanac** as a dark guild-ledger suite with charcoal panels, crimson accents, aged brass, and bone text. Missives use only canon-established couriers, institutions, creatures, spells, or artifacts; the Rumor Board is tied to a real gathering place and treats replies as delayed pinned scraps rather than live comments; Dispatches open exact source artifacts; and the Almanac preserves authored calendars, moons, festivals, watches, bells, tides, and magical cycles without inventing prophecy, quests, omens, precision, or outcomes. **Xianxia** presents Missives, a Tidings Board, Tidings, and a Seasonal Register in restrained celadon, silk ivory, mountain blue-grey, dusk blush, and small cinnabar-seal accents. Missives are separately composed and access-bound; talismans, jade slips, spirit messengers, and rapid transmission are permitted only when canon already establishes them. The Tidings Board is deliberately posted or circulated through a bounded place or institution, with delayed **Annotations & Replies**, no reactions, no algorithms, and no omniscient realm-wide audience. Seasonal Register preserves authored lunisolar, regnal, festival, solar-term, watch, double-hour, incense, local, and canon-established cultivation-cycle wording without inventing precision, auspiciousness, breakthroughs, or supernatural timing. **Post-Apocalyptic** presents Comms, a Signal Board, Incoming, and a Field Log through restrained smoked equipment glass. Comms uses only canon-established radio, terminal, courier, runner, note, dead-drop, recorded, or other access methods; it never invents infrastructure, power, range, stable networks, or immediate delivery. Signal Board entries and delayed follow-ups are deliberately circulated to bounded audiences rather than auto-broadcast character state, caches, locations, or protected knowledge. Incoming opens exact source artifacts without becoming an omniscient threat detector, and Field Log preserves rendezvous, watches, runs, promises, deadlines, and obligations without inventing missions or proving outcomes. **Near Future** presents **Link**, **Stream**, **Signals**, and **Timeline** through transparent navy infographic glass with coral priority lines, cyan status light, clean editorial rows, and quiet hairline structure. Link supports rapid personal communication without inventing devices, implants, assistants, accounts, coverage, or presence data. Stream allows attributed comments and reactions but remains bounded by a canonical platform and audience rather than becoming surveillance or a truth engine. Signals is a minimal source-linked list; Timeline uses a simple linear time rail and records plans without predictions, optimization, automatic rescheduling, or proof of outcomes. Its five Story App controls float independently without a shared tray. A compatibility alias keeps chats saved under Cute Retro's temporary former ID on Cute Retro rather than silently changing their presentation. **Almanac Reference** remains only a compatibility proof for Calendar/local dates. Choose the profile in SuperAgents Settings; the active chat updates in place.

The old **Almanac Reference** ID is retained only for saved-chat and API compatibility; it is no longer listed as a selectable Story Presentation.

*Note: Many of these are either ports or remakes of agents originally part of Marinara Engine, SillyBunny, or just ones I've found while browsing. These don't currently have versions for SillyTavern afaik, that's why I ported them. All credit goes to the original creators!*

The earlier ported **Secret Keeper** source remains in the extension only for compatibility and provenance reference. It is no longer offered in the built-in Library; the first-party Knowledge Ledger replaces it for new installs without silently rewriting existing user-created agent instances.

## Groups

Bundle agents that belong together and toggle them as a unit. Handy for a "tracking suite" you want on every chat, or a scene-specific set (say, the intimacy randomizer + escalation) you flip on and off together. An agent belongs to one execution group. In **Parallel** mode, active sidecars that share a connection profile are combined into one JSON-envelope call; different profiles run concurrently, and duplicate response keys are automatically separated. Edit Group can set an optional output-token ceiling for each profile batch; blank inherits the global SuperAgents ceiling. In **Sequential** mode, members run one at a time in order so later agents can consume earlier stored results, and the batch ceiling does not apply. Each member still keeps its own probability, every-N cadence, scope, validation, and failure handling.

## Settings

In the modal's Settings tab.

- **Story presentation** — choose this chat's declarative surface profile. This changes vocabulary, visual treatment, advertised capabilities, and model-facing medium behavior, not stored story facts or integration IDs.
- **Enable Group Chat** — show or hide the OOC writers’ room in Utilities. Disabling it also prevents autonomous Group Chat commentary.
- **Pause automatic agent calls** — stop scheduled and per-turn agent runs while keeping their enabled states and last stored state in the main chat. Manual runs remain available. **Disable active set** turns those agents off and removes their injection until you restore the saved set. Group Chat, After Dark, and Drama Queen remain available under either control, including their own auto modes and beat checks.
- **Default connection for SuperAgents** — an opt-in profile inherited by agents set to “Use default connection.” Agents with an explicit profile keep their own choice; with the toggle off, unassigned agents use SillyTavern’s current connection.
- **Sync story plans to Calendar** — accept only branch-authorized, validated replacement plans established in narration. Tentative suggestions are ignored, and the original historical record is preserved.
- **State Card, Notifications, Phone, Feed & Calendar panels** — choose which floating panels open by default in new chats. The in-story app buttons and each panel's close button set a remembered open/closed state for the current chat.
- **Stop button style** — reuse ST's native stop (✕) to cancel an in-flight agent run, or use a separate dedicated button.
- **Debug** — verbose console logging.

## Macros

Agents that track state expose it as macros you can drop into prompts, world info, or author's notes:

- `{{agent_<var>}}` — the formatted value of a tracked variable (e.g. the current world state).
- `{{agent_<var>_raw}}` — the same value unformatted.
- `{{agent_<var>_<field>}}` — one declared field from that tracker.
- `{{sa_<name>}}` — an optional friendly macro name configured in the agent's
  Memory section. Turn off automatic main-prompt injection when you want this
  macro to be the only placement path.

The exact variable names depend on your agents; check an agent's Merge Variable settings for its variable name.
Prompt Base and Prompt NSFW deliberately disable automatic injection because
Dynamic Events consumes their validated state and exposes only the authored
`{{de_...}}` outlets you place. A pre-gen agent can also use **Wait for another
agent’s state** in Conditions: ordinary agents run first, then the gated agent
runs only when the chosen freshly stored field matches.

## Extension Integration

Other extensions can feature-detect `window.SuperAgents.integration` and its `apiVersion` to read the current branch-aware tracker state. API version 10 exposes validated schema descriptions, including portable wildcard paths such as `characters.$subject.trust`, plus an explicit live-state read for same-generation pre-gen consumers and narrow `integration.phone`, `integration.feed`, `integration.calendar`, `integration.knowledge`, `integration.activity`, and `integration.presentation` surfaces. Presentation API version 1 returns cloned declarative profiles and active surface/action descriptors; consumers should retain stable IDs and use these descriptors only for visible vocabulary, icons, themes, and feature detection. Calendar API version 2 supports validated create, update, status, and removal commands and exact-record reconciliation grants. `integration.knowledge.listCandidates()` returns only disclosure-safe opportunities; `check()` fails closed and always rejects automatic `disclose` requests. Phone requests accept `behavior: 'consider'` or `behavior: 'send'`; Feed requests accept `behavior: 'consider'` or `behavior: 'publish'`. Same-turn requests for the same surface and branch are merged and executed serially.

`integration.activity` API version 1 lets optional apps publish a bounded observable artifact, list the current branch's artifacts or notifications, update notification read state, and register a source opener. The artifact envelope carries a stable source ID, type, actor, visible summary, story timestamp, visibility, branch anchor, causal references, and small source context. It does not grant knowledge access or own the source content. Presentation consumers can listen for `superagents:presentation-changed`; Activity consumers can listen for `superagents:activity-changed`; state consumers should continue listening for `superagents:state-committed` or `superagents:state-rejected`, then retrieve values through the matching API. Direct imports from SuperAgents internals are unsupported.

Phone conversations, Feed artifacts, and Calendar commitments are branch-aware. Changing an earlier swipe hides texts, posts, comments, reactions, and commitments created on the abandoned path and restores them when that path is selected again. Social-surface model calls also receive matching validated character state and active Dynamic Events State Track capsules when those integrations are available.

## Slash Commands

- `/sa-open` — open the management modal
- `/sa-list` — list configured agents and their enabled state
- `/sa-run [name]` — run an agent on the last assistant message (accepts `message=N` to target a specific one)
- `/sa-toggle [name]` — enable/disable an agent
- `/sa-clear [name]` — clear this chat's stored memory for an agent and re-arm its initialization/one-shot policy

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

## Changelog

See [CHANGELOG.md](../CHANGELOG.md).

## License

MIT. See [LICENSE](../LICENSE).
