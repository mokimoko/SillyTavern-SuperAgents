/** Shared Library-template link semantics. */

export function isTemplateLinked(agent) {
    return Boolean(String(agent?.sourceTemplateId || '').trim())
        && agent.sourceTemplateLinked !== false;
}
