/**
 * ui/iconPicker.js — a searchable FontAwesome grid for the agent/group editor.
 *
 * ST ships the full FA free solid set, so any "fa-xxx" renders. FA's CSS does
 * not expose an enumerable name list to JS, though, so a genuinely searchable
 * picker needs names in hand. Rather than parse the stylesheet at runtime
 * (brittle), we ship a large curated set skewed toward roleplay/agent use
 * (characters, masks, books, dice, brains, eyes, scrolls, hearts, swords…),
 * each tagged with a few keywords so the search box matches on meaning, not
 * just the class name. The free-text field at the bottom still accepts ANY
 * fa-class for power users who want something off-list.
 *
 * Usage:
 *   const picker = createIconPicker({ value: 'fa-mask', onChange: cls => {} });
 *   container.appendChild(picker.el);
 *   picker.getValue();           // current "fa-xxx" or ''
 *   picker.setValue('fa-book');
 */

// [class, ...searchKeywords]
const ICON_SET = [
    ['fa-mask', 'mask theatre disguise actor persona character'],
    ['fa-masks-theater', 'drama theatre comedy tragedy acting'],
    ['fa-user', 'person character human'],
    ['fa-user-secret', 'spy secret agent hidden'],
    ['fa-user-tie', 'formal manager director suit'],
    ['fa-user-ninja', 'ninja stealth assassin'],
    ['fa-user-group', 'people group party cast'],
    ['fa-users', 'people group crowd cast'],
    ['fa-people-group', 'people group party'],
    ['fa-children', 'kids people group'],
    ['fa-face-smile', 'emotion happy mood'],
    ['fa-face-meh', 'emotion neutral mood'],
    ['fa-face-angry', 'emotion anger mood rage'],
    ['fa-brain', 'mind thought psychology think planner'],
    ['fa-lightbulb', 'idea insight think'],
    ['fa-eye', 'watch observe see vision continuity'],
    ['fa-eye-low-vision', 'hidden secret unseen'],
    ['fa-glasses', 'read review proofread editor'],
    ['fa-comment', 'speech talk dialogue message'],
    ['fa-comments', 'chat dialogue conversation'],
    ['fa-comment-dots', 'typing chat message phone'],
    ['fa-message', 'text message phone sms'],
    ['fa-quote-left', 'quote prose writing dialogue'],
    ['fa-pen', 'write edit author prose'],
    ['fa-pen-nib', 'write author prose calligraphy'],
    ['fa-pen-fancy', 'write author prose quill'],
    ['fa-feather', 'quill write prose light'],
    ['fa-feather-pointed', 'quill write prose'],
    ['fa-highlighter', 'edit polish prose markup'],
    ['fa-spell-check', 'grammar proofread editor check'],
    ['fa-book', 'lore story read knowledge'],
    ['fa-book-open', 'lore story read worldbook'],
    ['fa-book-bookmark', 'lore reference saved'],
    ['fa-scroll', 'lore parchment summary history quest'],
    ['fa-file-lines', 'document notes summary text'],
    ['fa-clipboard', 'notes track checklist'],
    ['fa-clipboard-list', 'track checklist tasks state'],
    ['fa-list-check', 'tasks checklist track todo'],
    ['fa-bars-staggered', 'list log notes'],
    ['fa-chart-line', 'tracker stats progress metrics'],
    ['fa-chart-simple', 'tracker stats bars'],
    ['fa-chart-pie', 'stats data breakdown'],
    ['fa-gauge', 'meter state level status'],
    ['fa-temperature-half', 'mood tension heat meter'],
    ['fa-heart', 'love affection relationship romance'],
    ['fa-heart-pulse', 'health life vitals relationship'],
    ['fa-hand-holding-heart', 'care affection kindness'],
    ['fa-fire', 'intensity passion heat danger'],
    ['fa-bolt', 'energy spark event sudden'],
    ['fa-explosion', 'event spark drama conflict'],
    ['fa-wand-magic-sparkles', 'magic generate create spell'],
    ['fa-hat-wizard', 'magic mage wizard fantasy'],
    ['fa-dragon', 'fantasy monster creature'],
    ['fa-ghost', 'spooky horror spirit'],
    ['fa-skull', 'death danger dark horror'],
    ['fa-dice', 'random chance randomizer roll'],
    ['fa-dice-d20', 'random rpg roll tabletop'],
    ['fa-shuffle', 'random shuffle variety mix'],
    ['fa-clover', 'luck chance random fortune'],
    ['fa-chess', 'strategy plan director tactics'],
    ['fa-chess-knight', 'strategy move plan'],
    ['fa-bullseye', 'target goal focus aim'],
    ['fa-compass', 'direction guide navigate'],
    ['fa-map', 'world setting location geography'],
    ['fa-location-dot', 'place location setting pin'],
    ['fa-earth-americas', 'world global setting worldstate'],
    ['fa-clock', 'time schedule continuity timeline'],
    ['fa-hourglass-half', 'time waiting pacing'],
    ['fa-calendar', 'date schedule event'],
    ['fa-bell', 'alert notify event'],
    ['fa-flag', 'marker milestone event'],
    ['fa-key', 'secret unlock access keeper'],
    ['fa-lock', 'secret hidden private locked'],
    ['fa-shield', 'guard protect defense guardian'],
    ['fa-shield-halved', 'guard protect defense'],
    ['fa-gavel', 'judge rule decision'],
    ['fa-scale-balanced', 'balance judge fairness'],
    ['fa-link', 'connection relationship chain'],
    ['fa-network-wired', 'connections graph relationships'],
    ['fa-diagram-project', 'plan structure flow director'],
    ['fa-sitemap', 'structure hierarchy plan'],
    ['fa-layer-group', 'group stack layers collection'],
    ['fa-cubes', 'group blocks modules collection'],
    ['fa-puzzle-piece', 'custom piece misc generic'],
    ['fa-gear', 'settings config mechanism'],
    ['fa-gears', 'settings config machine process'],
    ['fa-robot', 'ai bot agent automation'],
    ['fa-microchip', 'ai compute processor'],
    ['fa-terminal', 'code command prompt'],
    ['fa-code', 'code script programming'],
    ['fa-filter', 'filter condition trigger'],
    ['fa-syringe', 'inject injection prompt'],
    ['fa-flask', 'experiment test lab'],
    ['fa-film', 'content scene cinematic story'],
    ['fa-clapperboard', 'scene director film action'],
    ['fa-camera', 'scene capture snapshot'],
    ['fa-music', 'sound mood audio'],
    ['fa-theater-masks', 'drama acting performance'],
    ['fa-wine-glass', 'social drink scene tavern'],
    ['fa-utensils', 'food meal scene dining'],
    ['fa-bed', 'rest intimacy scene sleep'],
    ['fa-moon', 'night dark mood'],
    ['fa-sun', 'day light bright mood'],
    ['fa-cloud', 'weather sky mood'],
    ['fa-bolt-lightning', 'storm weather event'],
    ['fa-snowflake', 'cold winter weather'],
    ['fa-leaf', 'nature organic calm'],
    ['fa-seedling', 'growth seed development'],
    ['fa-spider', 'web trap horror creature'],
    ['fa-paw', 'animal creature beast'],
    ['fa-crown', 'royalty power status ruler'],
    ['fa-chess-queen', 'royalty power status'],
    ['fa-gem', 'treasure value precious'],
    ['fa-star', 'favorite special highlight'],
    ['fa-trophy', 'reward win achievement'],
    ['fa-tag', 'label category tag'],
    ['fa-bookmark', 'save mark reference'],
    ['fa-thumbtack', 'pin note fixed'],
    ['fa-magnifying-glass', 'search inspect detail analyze'],
    ['fa-microscope', 'analyze detail inspect close'],
    ['fa-wrench', 'tool fix utility'],
    ['fa-toolbox', 'tools utility kit'],
    ['fa-hand', 'stop gesture touch'],
    ['fa-handshake', 'deal agreement relationship'],
    ['fa-person-running', 'action chase movement'],
    ['fa-person-walking', 'movement travel pace'],
    ['fa-road', 'journey path travel'],
    ['fa-route', 'path plan journey direction'],
    ['fa-anchor', 'stable ground hold'],
    ['fa-compass-drafting', 'plan design blueprint'],
];

function esc(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
}

/**
 * @param {{ value?: string, onChange?: (cls: string) => void }} opts
 */
export function createIconPicker({ value = '', onChange } = {}) {
    let current = (value || '').trim();

    const el = document.createElement('div');
    el.className = 'sae-iconpicker';
    el.innerHTML = `
        <div class="sae-iconpicker-bar">
            <div class="sae-iconpicker-preview"><i class="fa-solid ${esc(current || 'fa-puzzle-piece')}"></i></div>
            <input type="text" class="sae-iconpicker-search sae-input" placeholder="Search icons (e.g. mask, dice, book)…">
            <button type="button" class="sam-icon-btn sae-iconpicker-clear" title="Use category default">
                <i class="fa-solid fa-rotate-left"></i>
            </button>
        </div>
        <div class="sae-iconpicker-grid"></div>
        <div class="sae-iconpicker-custom">
            <span class="sae-iconpicker-customlabel">Custom class:</span>
            <input type="text" class="sae-iconpicker-customclass sae-input" placeholder="fa-anything" value="${esc(current)}">
        </div>
    `;

    const preview = el.querySelector('.sae-iconpicker-preview i');
    const search = el.querySelector('.sae-iconpicker-search');
    const grid = el.querySelector('.sae-iconpicker-grid');
    const clearBtn = el.querySelector('.sae-iconpicker-clear');
    const customInput = el.querySelector('.sae-iconpicker-customclass');

    function setCurrent(cls, { syncCustom = true } = {}) {
        current = (cls || '').trim();
        preview.className = `fa-solid ${current || 'fa-puzzle-piece'}`;
        if (syncCustom) customInput.value = current;
        grid.querySelectorAll('.sae-iconpicker-cell').forEach(c => {
            c.classList.toggle('sae-iconpicker-cell-active', c.dataset.cls === current);
        });
        onChange?.(current);
    }

    function renderGrid(filter = '') {
        const q = filter.trim().toLowerCase();
        const matches = q
            ? ICON_SET.filter(([cls, kw]) => cls.includes(q) || kw.includes(q))
            : ICON_SET;
        grid.innerHTML = matches.map(([cls]) => `
            <button type="button" class="sae-iconpicker-cell ${cls === current ? 'sae-iconpicker-cell-active' : ''}"
                    data-cls="${cls}" title="${cls.replace('fa-', '')}">
                <i class="fa-solid ${cls}"></i>
            </button>
        `).join('') || `<div class="sae-iconpicker-empty">No matches — try a custom class below.</div>`;
    }

    grid.addEventListener('click', (e) => {
        const cell = e.target.closest('.sae-iconpicker-cell');
        if (!cell) return;
        setCurrent(cell.dataset.cls);
    });
    search.addEventListener('input', () => renderGrid(search.value));
    clearBtn.addEventListener('click', () => setCurrent(''));
    customInput.addEventListener('input', () => setCurrent(customInput.value, { syncCustom: false }));

    renderGrid();

    return {
        el,
        getValue: () => current,
        setValue: (cls) => setCurrent(cls),
    };
}
