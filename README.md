# SuperAgents

You've got one model writing the roleplay. SuperAgents gives you a crew of little helpers running alongside it, each with one job: tracking the weather, catching continuity slip-ups, polishing prose, texting you in-character, or quietly plotting what happens next.

An **agent** is a prompt with a job and a schedule. It can run before the main reply to give the model a nudge, or afterward to track what happened or edit the reply. Use the built-in agents, tweak them, or make your own.

Enjoy :) -moki

## What can it do?

- **Keep track of the story.** World State, Scene State, Relationship Ledger, Knowledge Ledger, and other trackers remember details across turns and swipes.
- **Help with the writing.** Pre-reply agents can suggest the next beat; post-reply agents can check continuity, rewrite, or append.
- **Bring the world to life.** Optional Phone, Feed, Calendar, notifications, and other story panels give off-screen characters somewhere to do things.
- **Fit your setup.** Choose when agents run, which chats or characters they apply to, and which connection profile they use. Groups let you toggle a bunch together.

Agents that make LLM calls use extra time and tokens. I'd start with one or two, then add the ones you actually want.

## Installation

In SillyTavern, open **Extensions → Install Extension** and paste:

```text
https://github.com/mokimoko/SillyTavern-SuperAgents
```

Install it and reload if prompted.

## Getting started

1. Open **SuperAgents** from the wand menu (the people-group icon), or type `/sa-open`.
2. Browse the **Library** and add an agent that sounds useful. World State is a good place to start if you want a tracker.
3. Enable it, then chat normally. Open the agent again whenever you want to change its prompt, schedule, or connection profile.

You can also create an agent from scratch. The editor walks through *when it runs* and *what it does*.

## Dynamic Events

[Dynamic Events](https://github.com/mokimoko/SillyTavern-DynamicEvents) is a separate extension for scheduled story events and changing prompt instructions. It can read validated SuperAgents tracker state, so an event can respond to things like the current location or a relationship change. Either extension can be used on its own.

## More detail

The [reference guide](documentation/REFERENCE.md) covers the built-in agents, settings, macros, commands, and integration API.

See the [changelog](CHANGELOG.md) and [license](LICENSE).