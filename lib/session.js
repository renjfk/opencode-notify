// Shared session helpers for OpenCode TUI plugin.

/**
 * Get the title of a specific session by ID. Returns "" if unknown or on error.
 */
export async function getSessionTitle(client, sessionID) {
  if (!sessionID) return "";
  try {
    const result = await client.session.list();
    const session = result.data?.find((s) => s.id === sessionID);
    return session?.title || "";
  } catch {
    return "";
  }
}

/**
 * Extract an assistant message's text and creation time. The v2 API returns
 * projected messages ({ type: "assistant", content, time }); the v1 API
 * returns { info: { role, time }, parts }. Both are handled.
 */
function assistantEntry(message) {
  if (message.type === "assistant") {
    return {
      text: joinText(message.content),
      created: message.time?.created ?? 0,
    };
  }
  if (message.info?.role === "assistant") {
    return {
      text: joinText(message.parts),
      created: message.info?.time?.created ?? 0,
    };
  }
  return null;
}

function joinText(parts) {
  return (parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

/**
 * Get the text of the most recent assistant message, empty string if none.
 * The reply channel includes it above a question or permission prompt so the
 * push shows why the model is asking.
 *
 * Prefers the v2 session API (client.v2.session: projected messages,
 * returned as { data: { items } }); falls back to the v1 one (client.session:
 * { info, parts } messages, returned as { data: [...] }). The two endpoints
 * read different storage, and a session is often visible to only one of
 * them, so an empty or text-less v2 page falls through to v1 instead of
 * being trusted as final. Neither endpoint's ordering is trusted - the
 * newest assistant message by creation time wins, whatever order the page
 * came in.
 */
export async function getLastAgentText(client, sessionID) {
  if (!sessionID) return "";
  if (typeof client.v2?.session?.messages === "function") {
    try {
      const result = await client.v2.session.messages({ sessionID, limit: 10, order: "desc" });
      // The SDK does not throw by default: a failed call returns an error
      // result, which falls through to the v1 endpoint.
      if (!result?.error) {
        // SDK builds wrap the returned page differently: some put the
        // messages at data.items, others at data.data. An unrecognized
        // shape also falls through to v1 rather than reading an empty page.
        const page = result?.data;
        const items = page?.items ?? (Array.isArray(page?.data) ? page.data : null);
        // A v2 page without assistant text is not proof that there is none:
        // the v2 and v1 endpoints read different storage, and a session is
        // often visible to only one of them. Fall through to v1 instead of
        // trusting an empty page.
        const text = items ? newestAssistantText(items) : null;
        if (text) return text;
      }
    } catch {}
  }
  try {
    const result = await client.session.messages({ sessionID, limit: 10 });
    if (!result?.error && Array.isArray(result?.data)) {
      return newestAssistantText(result.data) ?? "";
    }
  } catch {}
  return "";
}

function newestAssistantText(messages) {
  let best = null;
  for (const message of messages) {
    const entry = assistantEntry(message);
    if (entry?.text && (!best || entry.created >= best.created)) best = entry;
  }
  return best?.text ?? null;
}
