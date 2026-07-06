/**
 * modes/continuityDetect.js — Stage 1 deterministic continuity detector.
 *
 * Pure JS, no LLM. Reads the State Card blob (sa_state_card) and runs cheap,
 * deterministic checks against a message's prose. When it finds a likely
 * continuity break it returns a compact finding; the render hook draws a quiet
 * clickable flag, and only on a human click does the (expensive) combined
 * confirm+repair LLM call run. Because the click gates the costly step, this
 * detector may lean slightly LIBERAL — a false flag costs nothing if ignored.
 *
 * Ported from AetherState's linter.py:
 *   - _SPEECH_VERBS               → SPEECH_VERBS (same verb family)
 *   - _attributions()             → findAttributions() (3 regex families:
 *                                    `Name:` line prefix, quote→name+verb,
 *                                    name+verb→quote)
 *   - _l5_absent_voice()          → checkAbsentVoice() (PRIMARY check)
 * The condition-conflict check (SECONDARY) has no AetherState analog — L1/L3
 * check presence, not incapacity words — so it's built fresh here with a
 * deliberately SMALL incapacity vocabulary for precision.
 *
 * The roster in SuperAgents is the set of keys under `characters` in the state
 * blob: a character being tracked there == present/known this scene. A name
 * attributed dialogue/action in prose that is NOT a roster key is the flag.
 */

// ============================================================================
// PORTED VOCABULARY (AetherState linter.py _SPEECH_VERBS)
// ============================================================================

/** Speech verbs, as an alternation fragment (no groups). */
const SPEECH_VERBS =
    'said|says|say|whispered|whispers|murmured|murmurs|replied|replies|asked|asks|'
    + 'shouted|shouts|called|calls|muttered|mutters|breathed|breathes|moaned|moans|'
    + 'growled|growls|purred|purrs|gasped|gasps|hissed|hisses|snapped|snaps|added|adds|'
    + 'answered|answers|laughed|laughs|sighed|sighs|cried|cries|exclaimed|exclaims|'
    + 'continued|continues|offered|offers|promised|promises|warned|warns|teased|teases|'
    + 'drawled|drawls|husked|cooed|coos|groaned|groans';

/**
 * Incapacity vocabulary for the condition-conflict check (SECONDARY). Kept
 * SMALL and unambiguous on purpose: a "hard-incapacity" condition string means
 * the character physically cannot be speaking or acting. Soft states (tired,
 * dazed, drunk) are excluded — they don't reliably contradict prose.
 *
 * Matched against the character's `condition` field, substring, lowercased.
 */
const INCAPACITY_WORDS = [
    'unconscious', 'dead', 'deceased', 'asleep', 'sleeping',
    'comatose', 'coma', 'passed out', 'knocked out', 'fainted',
    'paralyzed', 'paralysed',
];

/** Action/speech verbs that contradict a hard-incapacity condition. Reuses the
 *  speech-verb family plus a few overt physical-action verbs. */
const ACTION_VERBS = SPEECH_VERBS
    + '|walked|walks|walk|ran|runs|run|stood|stands|stand|stepped|steps|'
    + 'grabbed|grabs|grab|reached|reaches|reach|lunged|lunges|leapt|leaps|'
    + 'strode|strides|rushed|rushes|swung|swings|threw|throws|nodded|nods|'
    + 'shrugged|shrugs|smiled|smiles|grinned|grins|winked|winks';

/**
 * Capitalized tokens that look like a name to the regex but never are one. The
 * absent-voice scan extracts arbitrary `[A-Z]\w+` tokens sitting before a
 * speech verb (or as a `Name:` prefix); without this filter, sentence-initial
 * pronouns ("She said"), quantifiers ("Nobody answered"), and bare titles
 * ("The Captain said") flag on ordinary prose and drown the signal — exactly
 * the precision failure that gets a linter switched off. AetherState avoids
 * this by only ever testing KNOWN registry names; we extract open-set tokens
 * (to catch names not yet in the roster), so we need an explicit stoplist.
 *
 * Extends AetherState linter.py `_STOP` with pronouns, common sentence openers,
 * and generic titles. Matched case-insensitively.
 */
const NON_NAME_WORDS = new Set([
    // Pronouns / determiners as sentence subjects.
    'he', 'she', 'they', 'it', 'we', 'you', 'i', 'him', 'her', 'them', 'his',
    'hers', 'its', 'their', 'theirs', 'that', 'this', 'these', 'those', 'who',
    'whom', 'which', 'what', 'someone', 'somebody', 'something', 'anyone',
    'anybody', 'everyone', 'everybody', 'nobody', 'nothing', 'noone', 'none',
    'one', 'both', 'either', 'neither', 'all', 'each', 'another', 'other',
    // Common sentence openers / conjunctions / adverbs (capitalized at BOS).
    'the', 'a', 'an', 'and', 'but', 'or', 'so', 'yet', 'then', 'there', 'here',
    'when', 'while', 'where', 'though', 'although', 'because', 'after', 'before',
    'once', 'suddenly', 'finally', 'slowly', 'now', 'still', 'again', 'soon',
    'perhaps', 'maybe', 'meanwhile', 'instead', 'however', 'later', 'eventually',
    'together', 'somewhere', 'everything', 'everywhere', 'nowhere',
    // Generic titles / roles that precede speech verbs without being a name.
    'sir', 'madam', 'maam', 'mister', 'miss', 'lord', 'lady', 'king', 'queen',
    'prince', 'princess', 'captain', 'sergeant', 'doctor', 'professor', 'father',
    'mother', 'brother', 'sister', 'master', 'mistress', 'boss', 'chief',
    'guard', 'soldier', 'stranger', 'man', 'woman', 'boy', 'girl', 'child',
    'voice', 'someone',
]);

/** True if a captured token is a plausible character name (not a stopword). */
function isCandidateName(token) {
    if (!token || token.length < 3) return false;
    return !NON_NAME_WORDS.has(token.toLowerCase());
}

// ============================================================================
// ROSTER + STATE
// ============================================================================

/**
 * Parse the State Card blob out of the raw merge-variable string.
 * Shape (snapshot mode, first item's `json` field is a JSON string):
 *   [{ json: '{"worldEvents":[...],"user":{...},"characters":{...}}', ... }]
 * @param {string|null|undefined} rawVar — chat_metadata.variables[varName]
 * @returns {object|null} parsed state object, or null on any failure
 */
export function parseStateBlob(rawVar) {
    if (!rawVar || typeof rawVar !== 'string') return null;
    try {
        const arr = JSON.parse(rawVar);
        if (!Array.isArray(arr) || arr.length === 0) return null;
        const first = arr[0];
        const blob = first?.json
            ?? first?.[Object.keys(first).find(k => !k.startsWith('_')) ?? ''];
        if (typeof blob !== 'string') return null;
        const parsed = JSON.parse(blob.trim());
        return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * The roster: character names tracked in the state blob. Case-sensitive keys,
 * filtered to len>=3 for precision (mirrors AetherState _char_names len>=3;
 * short keys like "Al" produce too many false hits against ordinary prose).
 * @param {object} state
 * @returns {string[]}
 */
function rosterNames(state) {
    const chars = state?.characters;
    if (!chars || typeof chars !== 'object') return [];
    return Object.keys(chars).filter(n => typeof n === 'string' && n.trim().length >= 3);
}

// ============================================================================
// ATTRIBUTION DETECTION (AetherState _attributions)
// ============================================================================

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find dialogue/action attributed to a specific name in the prose. Three
 * deterministic families, ported from AetherState linter._attributions:
 *   1. `Name:` at the start of a line (script-style prefix).
 *   2. "quote" [,—-] Name speech-verb   (trailing attribution).
 *   3. Name speech-verb ... "quote"     (leading attribution).
 * Returns evidence snippets (the matched span, trimmed to 80 chars).
 * @param {string} text
 * @param {string} name
 * @returns {string[]} evidence snippets (empty if none)
 */
function findAttributions(text, name) {
    const pat = escapeRegex(name);
    const out = [];

    const push = (m) => {
        const span = (m[0] ?? '').slice(0, 80).trim();
        if (span) out.push(span);
    };

    // 1. Line prefix `Name:`
    const rePrefix = new RegExp(`^[ \\t]*${pat}[ \\t]*:[ \\t]*(.+)$`, 'gm');
    for (const m of text.matchAll(rePrefix)) push(m);

    // 2. "quote" , Name said
    const reTrailing = new RegExp(
        `["“][^"”“]+["”]\\s*[,—-]?\\s*${pat}\\s+(?:${SPEECH_VERBS})\\b`, 'g');
    for (const m of text.matchAll(reTrailing)) push(m);

    // 3. Name said ... "quote"
    const reLeading = new RegExp(
        `\\b${pat}\\s+(?:${SPEECH_VERBS})\\b[^"“\\n]{0,40}["“][^"”“]+["”]`, 'g');
    for (const m of text.matchAll(reLeading)) push(m);

    return out;
}

/**
 * Does the prose give this name an overt action (not just mention it)? Used by
 * the condition-conflict check: an incapacitated character "grabbed", "walked",
 * or spoke. Matches `Name <action-verb>`.
 * @param {string} text
 * @param {string} name
 * @returns {string|null} evidence snippet, or null
 */
function findAction(text, name) {
    const pat = escapeRegex(name);
    const re = new RegExp(`\\b${pat}\\s+(?:${ACTION_VERBS})\\b`, 'g');
    const m = re.exec(text);
    if (m) return (m[0] ?? '').slice(0, 80).trim();
    // Also count attributed dialogue as "acting".
    const attrs = findAttributions(text, name);
    return attrs.length ? attrs[0] : null;
}

// ============================================================================
// THE CHECKS
// ============================================================================

/**
 * PRIMARY — roster / absent-voice (AetherState L5).
 * A name that carries dialogue or a `Name:` prefix in the prose but is NOT a
 * roster key is voiced-while-absent. This is the single highest-value check.
 * @param {string} text
 * @param {string[]} roster — current tracked character names
 * @param {string[]} extraKnownNames — names to never flag (e.g. {{user}}, {{char}})
 * @returns {{reason:string, subjects:string[], evidence:string}|null}
 */
function checkAbsentVoice(text, roster, extraKnownNames) {
    // Build a candidate name set from proper-noun-looking tokens that appear
    // with an attribution, then keep only those NOT in the roster / known set.
    // We can't enumerate all possible absent names, so instead we scan the
    // prose for `Name:`-prefixed or name+speech-verb constructions and test the
    // captured name against the roster.
    const known = new Set([
        ...roster.map(n => n.toLowerCase()),
        ...extraKnownNames.map(n => String(n).toLowerCase()),
    ]);

    const suspects = new Map(); // name -> evidence

    // Family 1: `Name:` line prefix — capture the name token.
    const rePrefix = /^[ \t]*([A-Z][\w'-]{2,30})[ \t]*:[ \t]*\S/gm;
    for (const m of text.matchAll(rePrefix)) {
        const name = m[1];
        if (!isCandidateName(name)) continue;
        if (!known.has(name.toLowerCase()) && !suspects.has(name)) {
            suspects.set(name, (m[0] ?? '').slice(0, 80).trim());
        }
    }

    // Family 2/3: Name + speech-verb adjacency (leading form is the cheap scan).
    const reLeading = new RegExp(
        `\\b([A-Z][\\w'-]{2,30})\\s+(?:${SPEECH_VERBS})\\b`, 'g');
    for (const m of text.matchAll(reLeading)) {
        const name = m[1];
        if (!isCandidateName(name)) continue;
        if (!known.has(name.toLowerCase()) && !suspects.has(name)) {
            suspects.set(name, (m[0] ?? '').slice(0, 80).trim());
        }
    }

    if (suspects.size === 0) return null;

    // Report the first suspect (one flag per message; the LLM pass sees the
    // full message anyway and can catch siblings).
    const [name, evidence] = suspects.entries().next().value;
    return {
        reason: `prose voices "${name}", who is not in the tracked roster `
            + `(${roster.length ? roster.join(', ') : 'no characters tracked'})`,
        subjects: [name],
        evidence,
    };
}

/**
 * SECONDARY — condition conflict (no AetherState analog; built fresh).
 * A rostered character whose `condition` is a hard-incapacity word but whom the
 * prose has speaking or acting. Keyword-gated on a SMALL vocabulary.
 * @param {string} text
 * @param {object} state
 * @param {string[]} roster
 * @returns {{reason:string, subjects:string[], evidence:string}|null}
 */
function checkConditionConflict(text, state, roster) {
    const chars = state?.characters || {};
    for (const name of roster) {
        const condition = String(chars[name]?.condition ?? '').toLowerCase();
        if (!condition) continue;
        const hit = INCAPACITY_WORDS.find(w => condition.includes(w));
        if (!hit) continue;

        const evidence = findAction(text, name);
        if (evidence) {
            return {
                reason: `${name} is "${chars[name].condition}" in tracked state but the `
                    + `prose has them speaking or acting`,
                subjects: [name],
                evidence,
            };
        }
    }
    return null;
}

// ============================================================================
// PUBLIC ENTRY
// ============================================================================

/**
 * Run Stage-1 deterministic detection on a message's prose against tracked
 * state. Returns the first finding (PRIMARY before SECONDARY) or null.
 *
 * @param {string} text — the message prose (message.mes)
 * @param {object} state — parsed State Card blob (from parseStateBlob)
 * @param {object} [opts]
 * @param {string[]} [opts.knownNames] — names to never flag (user/char persona)
 * @returns {{reason:string, subjects:string[], evidence:string, check:string}|null}
 */
export function detectContinuityBreak(text, state, opts = {}) {
    if (!text || typeof text !== 'string' || !state || typeof state !== 'object') {
        return null;
    }
    const roster = rosterNames(state);
    const knownNames = Array.isArray(opts.knownNames) ? opts.knownNames : [];

    // PRIMARY: absent voice.
    const absent = checkAbsentVoice(text, roster, knownNames);
    if (absent) return { ...absent, check: 'absent_voice' };

    // SECONDARY: condition conflict.
    const cond = checkConditionConflict(text, state, roster);
    if (cond) return { ...cond, check: 'condition_conflict' };

    return null;
}

// Exposed for unit-poking / reuse.
export { SPEECH_VERBS, INCAPACITY_WORDS, rosterNames, findAttributions };
