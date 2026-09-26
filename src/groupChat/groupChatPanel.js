/** Draggable UtilitiesApp UI for the OOC Group Chat. */

import { eventSource, event_types } from '../../../../../../script.js';
import { debug } from '../core/runtime.js';
import { getCurrentProfileName, listConnectionProfiles } from '../core/profiles.js';
import { getGlobalSettings } from '../data/store.js';
import { makeDraggablePanel, mountDraggablePanel } from '../ui/draggablePanel.js';
import { refreshSurfaceDock } from '../ui/surfaceDock.js';
import {
    clearGroupChatMemory,
    deleteGroupChatMessage,
    ensureBasicKnowledge,
    isGroupChatAvailable,
    getGroupChatActivity,
    getGroupChatUnread,
    getGroupChatWriters,
    isGroupChatBusy,
    onGroupChatChange,
    sendGroupChatMessage,
    setGroupChatAutoEnabled,
    setGroupChatVisible,
    startGroupChatConversation,
    updateGroupChatSettings,
} from './groupChatAgent.js';
import { getUserParticipant } from './groupChatContext.js';
import { GROUP_CHAT_LIMITS, readGroupChatRoom } from './groupChatStore.js';

const CSS_HREF = '/scripts/extensions/third-party/SillyTavern-SuperAgents/src/groupChat/groupChatPanel.css?v=0.45.1';
const GROUP_CHAT_ICON = '/scripts/extensions/third-party/SillyTavern-SuperAgents/images/icons/group-chat.png';
const PANEL_ID = 'sa-group-chat-panel';
const LOG_PREFIX = '[SuperAgents/groupChatPanel]';
const COMPOSING_PHASES = new Set(['composing-opening', 'composing-commentary', 'composing-reply']);
const EMOJIS = [
    '😀', '😂', '😅', '🙃', '😉', '😍', '🤩', '🤔', '🤨', '😐', '😑', '🙄', '😏',
    '😮', '😌', '😛', '😒', '😔', '😤', '😢', '😭', '😬', '😱', '😳', '😠', '🤬',
    '🤢', '🤡', '😈', '💀', '🥺', '🫠', '🫡', '🤝', '👏', '🙏', '💅', '👀', '❤️',
    '💔', '🔥', '💯', '✨', '🎉', '👍', '👎',
];

let panel = null;
let controller = null;
let typingCharacter = '';
let detailsOpen = false;
let emojiOpen = false;
let unsubscribe = null;
let rosterSignature = '';
let profileSignature = '';
let renderedMessageIds = [];
let messagePeopleSignature = '';

function esc(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function injectStylesheet() {
    let link = document.querySelector('link[data-sa-group-chat]');
    if (!link) {
        link = document.createElement('link');
        link.rel = 'stylesheet';
        link.setAttribute('data-sa-group-chat', '');
        document.head.appendChild(link);
    }
    link.href = CSS_HREF;
}

function timeLabel(timestamp) {
    if (!timestamp) return '—';
    return new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));
}

function initials(name) {
    return String(name || '?').split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
}

function avatarMarkup(person, size = 32) {
    const style = `--sa-gc-avatar-size:${size}px;--sa-gc-speaker:${esc(person.color || '#92989c')}`;
    const image = person.avatar
        ? `<img src="${esc(person.avatar)}" alt="" loading="lazy"><span hidden>${esc(initials(person.name))}</span>`
        : `<span>${esc(initials(person.name))}</span>`;
    return `<span class="sa-gc-avatar" style="${style}" aria-hidden="true">${image}</span>`;
}

function regexEscape(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatMessageText(text, writers = []) {
    const source = String(text ?? '').replace(/\r/g, '');
    const knownNames = [...new Set(writers.flatMap(writer => [
        writer.name,
        writer.writerName?.replace(/^@/, ''),
        ...(writer.aliases || []),
    ]).map(name => String(name || '').trim()).filter(Boolean))]
        .sort((a, b) => b.length - a.length)
        .map(regexEscape);
    const known = knownNames.length ? `${knownNames.join('|')}|` : '';
    const mentionPattern = new RegExp(`(^|\\s)(@(?:${known}[\\p{L}\\p{N}_'’.-]+))(?=$|[\\s.,!?;:()[\\]{}])`, 'giu');
    let html = '';
    let cursor = 0;
    for (const match of source.matchAll(mentionPattern)) {
        html += esc(source.slice(cursor, match.index));
        html += `${esc(match[1])}<span class="sa-gc-mention">${esc(match[2])}</span>`;
        cursor = match.index + match[0].length;
    }
    return (html + esc(source.slice(cursor))).replaceAll('\n', '<br>');
}

function writerForMessage(message, writers) {
    const character = String(message.character || '').toLowerCase();
    return writers.find(writer => (
        writer.name.toLowerCase() === character
        || writer.aliases?.some(alias => alias.toLowerCase() === character)
    )) || {
        name: message.character || message.speaker || 'Writer',
        writerName: message.speaker || 'Writer',
        avatar: '',
        color: '#92989c',
    };
}

function messageMarkup(message, writers, user) {
    if (message.role === 'system' || message.role === 'warning') {
        return `<div class="sa-gc-system ${message.role === 'warning' ? 'is-warning' : ''}" data-message-id="${esc(message.id)}"><b>${message.role === 'warning' ? '!' : '◆'}</b><span>${formatMessageText(message.text, writers)}</span><button class="sa-gc-delete-message" type="button" data-action="delete-message" data-message-id="${esc(message.id)}" aria-label="Delete message" title="Delete message"><i class="fa-solid fa-trash-can"></i></button></div>`;
    }
    const own = message.role === 'user';
    const person = own ? user : writerForMessage(message, writers);
    const speaker = own ? 'You' : (message.speaker || person.writerName);
    return `<article class="sa-gc-message ${own ? 'is-own' : ''}" data-message-id="${esc(message.id)}" style="--sa-gc-speaker:${esc(person.color)}">
        ${avatarMarkup(person, 34)}
        <div class="sa-gc-message-main">
            <div class="sa-gc-message-head"><strong>${esc(speaker)}</strong><time>${esc(timeLabel(message.timestamp))}</time></div>
            ${message.replyTo ? `<span class="sa-gc-reply">Replying to ${esc(message.replyTo)}</span>` : ''}
            <p>${formatMessageText(message.text, writers)}</p>
        </div>
        <button class="sa-gc-delete-message" type="button" data-action="delete-message" data-message-id="${esc(message.id)}" aria-label="Delete message" title="Delete message"><i class="fa-solid fa-trash-can"></i></button>
    </article>`;
}

function createPanel() {
    panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.className = 'sa-group-chat-panel';
    panel.style.display = 'none';
    panel.setAttribute('aria-label', 'Group Chat writers room');
    panel.innerHTML = `
        <header class="sa-gc-header">
            <div class="sa-gc-title">
                <span class="sa-gc-mark" aria-hidden="true"><img src="${GROUP_CHAT_ICON}" alt=""></span>
                <div><h2>Group Chat</h2><p>OOC · Writers’ room</p></div>
            </div>
            <div class="sa-gc-header-actions" data-no-drag>
                <button class="sa-gc-auto" type="button" data-action="auto" aria-pressed="false"><span class="sa-gc-switch"><i></i></span><span data-auto-label>Auto off</span></button>
                <button type="button" data-action="details" aria-label="Room details" aria-expanded="false" title="Room details"><i class="fa-solid fa-circle-info"></i></button>
                <button type="button" data-action="close" aria-label="Close Group Chat" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
        </header>
        <div class="sa-gc-body">
            <aside class="sa-gc-roster">
                <div class="sa-gc-section-label"><span>Writers</span><span data-roster-count>0</span></div>
                <ul data-roster></ul>
                <div class="sa-gc-roster-tools" data-no-drag>
                    <button type="button" data-action="regenerate" aria-label="Rebuild basic knowledge" title="Rebuild basic knowledge"><i class="fa-solid fa-rotate"></i></button>
                    <button class="is-danger" type="button" data-action="wipe" aria-label="Wipe conversation memory" title="Wipe conversation memory"><i class="fa-solid fa-trash-can"></i></button>
                </div>
                <p class="sa-gc-roster-note"><strong>@mention</strong> a writer to request them. Otherwise the room decides who has something to say.</p>
            </aside>
            <section class="sa-gc-chat">
                <div class="sa-gc-messages" data-messages aria-live="polite"><div data-message-list></div><div data-typing></div></div>
                <div class="sa-gc-activity" data-activity role="status" aria-live="polite" hidden><i></i><span></span></div>
                <div class="sa-gc-composer-shell">
                    <div class="sa-gc-mentions" data-mentions><span>Address</span></div>
                    <div class="sa-gc-emoji-picker" data-emoji-picker hidden>
                        <div class="sa-gc-emoji-header"><strong>Pick an emoji</strong><button type="button" data-action="emoji-close" aria-label="Close emoji picker"><i class="fa-solid fa-xmark"></i></button></div>
                        <div class="sa-gc-emoji-grid">${EMOJIS.map(emoji => `<button type="button" data-emoji="${emoji}" aria-label="Insert ${emoji}">${emoji}</button>`).join('')}</div>
                    </div>
                    <form class="sa-gc-composer" data-composer>
                        <button class="sa-gc-emoji-button" type="button" data-action="emoji" aria-label="Add emoji" aria-expanded="false" title="Add emoji"><i class="fa-solid fa-face-smile"></i></button>
                        <textarea rows="2" maxlength="6000" data-input placeholder="Message the writers’ room…"></textarea>
                        <button type="submit" data-send aria-label="Send message"><i class="fa-solid fa-arrow-up"></i></button>
                        <small>Enter to send · Shift+Enter for a new line</small>
                    </form>
                </div>
            </section>
            <aside class="sa-gc-details" data-details aria-hidden="true">
                <section>
                    <h3>Story awareness</h3>
                    <div class="sa-gc-status"><span>Basic knowledge</span><strong data-knowledge-status>Missing</strong></div>
                    <div class="sa-gc-status"><span>Built</span><strong data-knowledge-time>—</strong></div>
                    <div class="sa-gc-status"><span>Story messages</span><strong data-story-count>Last 5</strong></div>
                    <div class="sa-gc-status"><span>SimpleSummarizer</span><strong data-summarizer>Not detected</strong></div>
                </section>
                <section>
                    <h3>Room memory</h3>
                    <div class="sa-gc-status"><span>Recent messages</span><strong data-memory-count>0 / 30</strong></div>
                    <div class="sa-gc-memory-meter"><i data-memory-meter></i></div>
                    <p>At 30 messages, the oldest 20 are condensed. The newest 10 remain verbatim.</p>
                    <div class="sa-gc-status"><span>Room summaries</span><strong data-summary-count>0 / 5</strong></div>
                    <div class="sa-gc-status"><span>Historical memory</span><strong data-history-count>0</strong></div>
                </section>
                <section>
                    <h3>Room controls</h3>
                    <button class="sa-gc-plain-button" type="button" data-action="start">▶ Start an autonomous conversation</button>
                </section>
                <section class="sa-gc-detail-settings">
                    <h3>Room settings</h3>
                    <label class="is-wide"><span>Connection profile</span><select data-setting="connectionProfile" data-connection-profile><option value="">Use SuperAgents default / current</option></select></label>
                    <label><span>Base auto interval</span><input data-setting="baseInterval" type="number" min="1" max="50"></label>
                    <label><span>Random delay</span><select data-setting="jitterMax"><option value="5">+ 1–5 messages</option><option value="3">+ 1–3 messages</option><option value="0">None</option></select></label>
                    <label><span>Recent story context</span><select data-setting="recentStoryMessages"><option value="5">5 messages</option><option value="8">8 messages</option><option value="10">10 messages</option><option value="15">15 messages</option></select></label>
                    <label><span>Maximum responders</span><select data-setting="maxWriters"><option value="2">2 writers</option><option value="1">1 writer</option></select></label>
                    <label><span>Messages per writer</span><select data-setting="maxMessagesPerWriter"><option value="2">Up to 2</option><option value="1">Exactly 1</option></select></label>
                    <p data-auto-progress>Auto mode is off.</p>
                </section>
            </aside>
        </div>
        <div class="sa-gc-confirm" data-confirm hidden data-no-drag>
            <section role="dialog" aria-modal="true" aria-labelledby="sa-gc-wipe-title">
                <h3 id="sa-gc-wipe-title">Wipe conversation memory?</h3>
                <p>This removes Group Chat messages, room summaries, and historical room memory. Generated basic knowledge is kept.</p>
                <footer><button type="button" data-action="wipe-cancel">Cancel</button><button class="is-confirm" type="button" data-action="wipe-confirm">Wipe memory</button></footer>
            </section>
        </div>`;
    mountDraggablePanel(panel);
    controller = makeDraggablePanel(panel, {
        id: PANEL_ID,
        handle: '.sa-gc-header',
        defaultAnchor: 'center-right',
        resizable: true,
        minW: 430,
        minH: 420,
    });
    bindEvents();
}

function renderRoster(writers, user) {
    const signature = JSON.stringify([...writers, user].map(person => [
        person.id, person.name, person.writerName, person.avatar, person.color, person.hasCard,
    ]));
    if (signature === rosterSignature) return;
    rosterSignature = signature;
    panel.querySelector('[data-roster-count]').textContent = String(writers.length + 1);
    panel.querySelector('[data-roster]').innerHTML = [...writers, user].map(person => {
        const isUser = person.id === 'user';
        return `<li><button type="button" data-mention="${isUser ? '' : esc(person.name)}" ${isUser ? 'disabled' : ''} style="--sa-gc-speaker:${esc(person.color)}">
            ${avatarMarkup(person)}
            <span><strong>${esc(isUser ? 'You' : person.writerName)}</strong><small><i></i>${isUser ? 'Here' : (person.hasCard === false ? 'Known from story' : 'Available')}</small></span>
        </button></li>`;
    }).join('');
    panel.querySelector('[data-mentions]').innerHTML = '<span>Address</span>' + writers.map(writer => (
        `<button type="button" data-mention="${esc(writer.name)}" style="--sa-gc-speaker:${esc(writer.color)}">@${esc(writer.name)}</button>`
    )).join('');
}

function renderMessages(room, writers, user) {
    const container = panel.querySelector('[data-messages]');
    const wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 90;
    const target = panel.querySelector('[data-message-list]');
    const messageIds = room.messages.map(message => message.id);
    const nextPeopleSignature = JSON.stringify([
        ...writers.map(writer => [writer.name, writer.writerName, writer.avatar, writer.color]),
        [user.name, user.avatar, user.color],
    ]);
    const canAppend = renderedMessageIds.length > 0
        && messagePeopleSignature === nextPeopleSignature
        && messageIds.length >= renderedMessageIds.length
        && renderedMessageIds.every((id, index) => id === messageIds[index]);

    if (canAppend) {
        const added = room.messages.slice(renderedMessageIds.length);
        if (added.length) target.insertAdjacentHTML('beforeend', added.map(message => messageMarkup(message, writers, user)).join(''));
    } else {
        let html = room.messages.map(message => messageMarkup(message, writers, user)).join('');
        if (!html) {
        const status = room.knowledge.status === 'building'
            ? 'Building the room’s compact story reference…'
            : 'The room is quiet. Send a message or start an autonomous conversation.';
            html = `<div class="sa-gc-day-divider">Writers’ room</div><div class="sa-gc-empty">${esc(status)}</div>`;
        }
        target.innerHTML = html;
    }
    renderedMessageIds = messageIds;
    messagePeopleSignature = nextPeopleSignature;
    if (wasNearBottom) requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
}

function renderTyping(writers = []) {
    const container = panel.querySelector('[data-messages]');
    const target = panel.querySelector('[data-typing]');
    const writer = typingCharacter
        ? writers.find(candidate => candidate.name === typingCharacter) || writers[0]
        : null;
    const composing = COMPOSING_PHASES.has(getGroupChatActivity());
    if (writer) {
        target.innerHTML = `<div class="sa-gc-typing" style="--sa-gc-speaker:${esc(writer.color)}">${avatarMarkup(writer, 30)}<span><strong>${esc(writer.writerName)}</strong><span class="sa-gc-typing-dots" aria-label="is typing"><i></i><i></i><i></i></span></span></div>`;
    } else if (composing) {
        target.innerHTML = `<div class="sa-gc-typing is-room"><span class="sa-gc-typing-dots" aria-label="Writers are typing"><i></i><i></i><i></i></span></div>`;
    } else {
        target.innerHTML = '';
    }
    if (writer || composing) requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
}

function renderStatus(room) {
    const status = panel.querySelector('[data-knowledge-status]');
    const labels = { missing: 'Missing', building: 'Building', current: 'Current', degraded: 'Degraded' };
    status.textContent = labels[room.knowledge.status] || 'Missing';
    status.className = room.knowledge.status === 'current' ? 'is-good' : room.knowledge.status === 'missing' ? '' : 'is-warn';
    panel.querySelector('[data-knowledge-time]').textContent = room.knowledge.builtAt ? timeLabel(room.knowledge.builtAt) : '—';
    panel.querySelector('[data-story-count]').textContent = `Last ${room.settings.recentStoryMessages}`;
    const summarizer = globalThis.Summarizer;
    const connected = !!summarizer?.isInstalled && summarizer.isEnabled?.() !== false;
    const summarizerEl = panel.querySelector('[data-summarizer]');
    summarizerEl.textContent = connected ? 'Connected' : 'Not detected';
    summarizerEl.className = connected ? 'is-good' : '';
    renderMemoryStatus(room);

    const autoButton = panel.querySelector('[data-action="auto"]');
    autoButton.setAttribute('aria-pressed', String(room.settings.autoEnabled));
    panel.querySelector('[data-auto-label]').textContent = room.settings.autoEnabled ? 'Auto on' : 'Auto off';
    const remaining = Math.max(0, room.settings.nextAutoAt - room.settings.storyRepliesSinceAuto);
    panel.querySelector('[data-auto-progress]').textContent = room.settings.autoEnabled
        ? `Next autonomous commentary in approximately ${remaining || room.settings.nextAutoAt} story replies.`
        : 'Auto mode is off.';

    const profileSelect = panel.querySelector('[data-connection-profile]');
    const profiles = listConnectionProfiles();
    const globalSettings = getGlobalSettings();
    const inheritedProfile = profiles.find(profile => (
        profile.name === globalSettings.connectionProfile || profile.id === globalSettings.connectionProfile
    ));
    const currentProfileName = getCurrentProfileName();
    const inheritedLabel = globalSettings.useDefaultConnection && globalSettings.connectionProfile
        ? `Inherit SuperAgents — ${inheritedProfile?.name || globalSettings.connectionProfile}`
        : `Inherit current connection${currentProfileName ? ` — ${currentProfileName}` : ''}`;
    const selectedRef = String(room.settings.connectionProfile || '');
    const selectedProfile = profiles.find(profile => profile.name === selectedRef || profile.id === selectedRef);
    const missingOption = selectedRef && !selectedProfile
        ? `<option value="${esc(selectedRef)}">${esc(selectedRef)} (missing)</option>`
        : '';
    const nextProfileSignature = JSON.stringify([
        inheritedLabel,
        selectedRef,
        profiles.map(profile => [profile.id, profile.name]),
    ]);
    if (nextProfileSignature !== profileSignature) {
        profileSignature = nextProfileSignature;
        profileSelect.innerHTML = `<option value="">${esc(inheritedLabel)}</option>${missingOption}${profiles.map(profile => (
            `<option value="${esc(profile.name)}">${esc(profile.name)}</option>`
        )).join('')}`;
    }
    profileSelect.value = selectedProfile?.name || selectedRef;

    for (const input of panel.querySelectorAll('[data-setting]')) {
        input.value = String(room.settings[input.dataset.setting]);
    }
}

function renderActivityState(room = readGroupChatRoom(), writers = null) {
    const isBusy = isGroupChatBusy();
    panel.querySelector('[data-send]').disabled = isBusy;
    panel.querySelector('[data-input]').disabled = isBusy;
    panel.querySelector('[data-action="start"]').disabled = isBusy;
    panel.querySelector('[data-action="regenerate"]').disabled = isBusy;
    panel.querySelector('[data-action="wipe"]').disabled = isBusy
        || (!room.messages.length && !room.summaries.length && !room.historicalSummary);
    panel.querySelector('[data-action="emoji"]').disabled = isBusy;
    for (const button of panel.querySelectorAll('[data-action="delete-message"]')) button.disabled = isBusy;
    if (isBusy && emojiOpen) setEmojiPickerOpen(false);
    for (const input of panel.querySelectorAll('[data-setting]')) input.disabled = isBusy;
    for (const button of panel.querySelectorAll('[data-mentions] [data-mention]')) button.disabled = isBusy;

    const activity = getGroupChatActivity();
    const activityLabels = {
        'preparing-knowledge': 'Preparing story context…',
        'building-roster': 'Building the writer roster…',
        'preparing-turn': 'Preparing the writers’ context…',
        archiving: 'Condensing older room memory…',
    };
    const activityEl = panel.querySelector('[data-activity]');
    const activityLabel = activityLabels[activity] || '';
    const busyTitle = activityLabel || (COMPOSING_PHASES.has(activity) || activity === 'typing' ? 'Waiting for the room…' : 'Group Chat is busy…');
    activityEl.hidden = !activityLabel;
    activityEl.querySelector('span').textContent = activityLabel;
    panel.querySelector('[data-composer] small').textContent = activityLabel || 'Enter to send · Shift+Enter for a new line';
    panel.querySelector('[data-input]').title = isBusy ? busyTitle : '';
    panel.querySelector('[data-send]').title = isBusy ? busyTitle : 'Send message';
    renderTyping(writers || []);
}

function setEmojiPickerOpen(open) {
    emojiOpen = Boolean(open);
    panel.querySelector('[data-emoji-picker]').hidden = !emojiOpen;
    panel.querySelector('[data-action="emoji"]').setAttribute('aria-expanded', String(emojiOpen));
}

function insertEmoji(emoji) {
    const input = panel.querySelector('[data-input]');
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.setRangeText(emoji, start, end, 'end');
    input.focus();
}

function renderLayout() {
    panel.classList.toggle('is-details-open', detailsOpen);
    panel.querySelector('[data-action="details"]').setAttribute('aria-expanded', String(detailsOpen));
    panel.querySelector('[data-details]').setAttribute('aria-hidden', String(!detailsOpen));
    panel.querySelector('[data-details]').hidden = !detailsOpen;
    refreshSurfaceDock();
}

function renderMemoryStatus(room) {
    panel.querySelector('[data-memory-count]').textContent = `${room.messages.length} / ${GROUP_CHAT_LIMITS.activeMessages}`;
    panel.querySelector('[data-memory-meter]').style.width = `${Math.min(100, room.messages.length / GROUP_CHAT_LIMITS.activeMessages * 100)}%`;
    panel.querySelector('[data-summary-count]').textContent = `${room.summaries.length} / ${GROUP_CHAT_LIMITS.roomSummaries}`;
    panel.querySelector('[data-history-count]').textContent = room.historicalSummary ? '1' : '0';
}

function render() {
    if (!panel) return;
    const room = readGroupChatRoom();
    const writers = getGroupChatWriters();
    const user = getUserParticipant();
    renderLayout();
    renderRoster(writers, user);
    renderMessages(room, writers, user);
    renderStatus(room);
    renderActivityState(room, writers);
}

function insertMention(name) {
    if (!name) return;
    const input = panel.querySelector('[data-input]');
    const prefix = input.value && !/\s$/.test(input.value) ? ' ' : '';
    input.value += `${prefix}@${name} `;
    input.focus();
}

function showError(error) {
    if (String(error?.message || error) === 'chat changed') return;
    toastr.error(String(error?.message || error), 'Group Chat');
}

function bindEvents() {
    panel.addEventListener('error', event => {
        if (!event.target.matches?.('.sa-gc-avatar img')) return;
        event.target.hidden = true;
        if (event.target.nextElementSibling) event.target.nextElementSibling.hidden = false;
    }, true);
    panel.addEventListener('click', event => {
        const emoji = event.target.closest('[data-emoji]');
        if (emoji) {
            insertEmoji(emoji.dataset.emoji);
            setEmojiPickerOpen(false);
            return;
        }
        const mention = event.target.closest('[data-mention]');
        if (mention) insertMention(mention.dataset.mention);
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (emojiOpen && action !== 'emoji' && !event.target.closest('[data-emoji-picker]')) setEmojiPickerOpen(false);
        if (!action) return;
        if (action === 'close') hide(false);
        if (action === 'emoji') setEmojiPickerOpen(!emojiOpen);
        if (action === 'emoji-close') setEmojiPickerOpen(false);
        if (action === 'auto') setGroupChatAutoEnabled(!readGroupChatRoom().settings.autoEnabled);
        if (action === 'details') {
            detailsOpen = !detailsOpen;
            renderLayout();
            if (detailsOpen) renderStatus(readGroupChatRoom());
        }
        if (action === 'start') {
            detailsOpen = false;
            renderLayout();
            startGroupChatConversation({ autonomous: true }).catch(showError);
        }
        if (action === 'regenerate') ensureBasicKnowledge({ force: true }).catch(showError);
        if (action === 'wipe') panel.querySelector('[data-confirm]').hidden = false;
        if (action === 'wipe-cancel') panel.querySelector('[data-confirm]').hidden = true;
        if (action === 'wipe-confirm') {
            panel.querySelector('[data-confirm]').hidden = true;
            clearGroupChatMemory();
            toastr.success('Conversation memory wiped. Basic knowledge was kept.', 'Group Chat');
        }
        if (action === 'delete-message') {
            const messageId = event.target.closest('[data-message-id]')?.dataset.messageId;
            if (messageId && confirm('Delete this Group Chat message?')) deleteGroupChatMessage(messageId);
        }
    });
    panel.querySelector('[data-composer]').addEventListener('submit', event => {
        event.preventDefault();
        const input = panel.querySelector('[data-input]');
        const text = input.value.trim();
        if (!text || isGroupChatBusy()) return;
        setEmojiPickerOpen(false);
        input.value = '';
        sendGroupChatMessage(text).catch(showError);
    });
    panel.querySelector('[data-input]').addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            panel.querySelector('[data-composer]').requestSubmit();
        }
    });
    panel.querySelectorAll('[data-setting]').forEach(input => {
        input.addEventListener('change', () => updateGroupChatSettings({
            [input.dataset.setting]: input.dataset.setting === 'connectionProfile'
                ? input.value
                : Number(input.value),
        }));
    });
    panel.querySelector('[data-confirm]').addEventListener('click', event => {
        if (event.target.matches('[data-confirm]')) event.currentTarget.hidden = true;
    });
    panel.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        panel.querySelector('[data-confirm]').hidden = true;
        setEmojiPickerOpen(false);
        detailsOpen = false;
        renderLayout();
    });
    document.addEventListener('pointerdown', event => {
        if (emojiOpen && panel?.isConnected && !panel.contains(event.target)) setEmojiPickerOpen(false);
    }, true);
}

export function initGroupChatPanel() {
    if (panel?.isConnected) return;
    injectStylesheet();
    createPanel();
    unsubscribe?.();
    unsubscribe = onGroupChatChange(event => {
        typingCharacter = event.kind === 'typing' ? event.character : (event.kind === 'typing-end' ? '' : typingCharacter);
        if (event.kind === 'message' || event.kind === 'chat-changed' || event.kind === 'disabled') typingCharacter = '';
        if (event.kind === 'disabled') {
            hide(false);
            return;
        }
        if (!controller?.isOpen()) return;
        if (event.kind === 'activity') {
            renderActivityState();
        } else if (event.kind === 'typing' || event.kind === 'typing-end') {
            const writers = getGroupChatWriters();
            renderActivityState(readGroupChatRoom(), writers);
        } else if (event.kind === 'message') {
            const room = readGroupChatRoom();
            const writers = getGroupChatWriters();
            renderMessages(room, writers, getUserParticipant());
            renderMemoryStatus(room);
            renderActivityState(room, writers);
        } else if (['settings', 'auto-progress', 'read'].includes(event.kind)) {
            const room = readGroupChatRoom();
            renderStatus(room);
            renderActivityState(room);
        } else if (event.kind === 'archived') {
            const room = event.room || readGroupChatRoom();
            const writers = getGroupChatWriters();
            renderMessages(room, writers, getUserParticipant());
            renderMemoryStatus(room);
            renderActivityState(room, writers);
        } else {
            rosterSignature = '';
            profileSignature = '';
            messagePeopleSignature = '';
            render();
        }
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (controller?.isOpen()) hide(false);
    });
    render();
    debug(`${LOG_PREFIX} initialized`);
}

export function show() {
    if (!panel?.isConnected) initGroupChatPanel();
    if (!isGroupChatAvailable()) {
        toastr.info('Enable Group Chat in SuperAgents Settings first.', 'Group Chat');
        return;
    }
    setGroupChatVisible(true);
    controller.show();
    render();
    const room = readGroupChatRoom();
    // Any persisted knowledge marks this as an existing room, including after
    // a wipe; only a genuinely empty room receives the automatic opener.
    if (!room.started && !room.knowledge.data && !isGroupChatBusy()) {
        startGroupChatConversation({ autonomous: true }).catch(showError);
    }
}

export function hide() {
    setGroupChatVisible(false);
    controller?.hide();
    if (emojiOpen) setEmojiPickerOpen(false);
    detailsOpen = false;
    refreshSurfaceDock();
}

export function isOpen() {
    return controller?.isOpen() ?? false;
}

export { getGroupChatUnread as getUnread };
