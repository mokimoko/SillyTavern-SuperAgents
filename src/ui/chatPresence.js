/** Cross-version chat-presence check shared by floating panels and launchers. */

import { this_chid } from '../../../../../../script.js';
import { selected_group } from '../../../../../group-chats.js';

export function isStoryChatOpen() {
    if (this_chid != null || !!selected_group) return true;
    try {
        const context = globalThis.SillyTavern?.getContext?.();
        return context?.characterId != null
            || context?.groupId != null
            || (context?.chatId != null && String(context.chatId).trim() !== '');
    } catch {
        return false;
    }
}
