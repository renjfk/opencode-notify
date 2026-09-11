import assert from "node:assert/strict";
import test from "node:test";

import { getLastAgentText, getSessionTitle } from "../lib/session.js";

test("gets the matching session title", async () => {
  const client = {
    session: {
      list: async () => ({
        data: [
          { id: "one", title: "First" },
          { id: "two", title: "Second" },
        ],
      }),
    },
  };

  assert.equal(await getSessionTitle(client, "two"), "Second");
});

test("returns an empty title for missing IDs and client errors", async () => {
  assert.equal(await getSessionTitle({}, undefined), "");
  assert.equal(
    await getSessionTitle(
      {
        session: {
          list: async () => {
            throw new Error("offline");
          },
        },
      },
      "one",
    ),
    "",
  );
});

test("gets the text of the latest assistant message, skipping reasoning", async () => {
  const client = {
    v2: {
      session: {
        // The v2 endpoint returns { data: { items, cursor } }.
        messages: async () => ({
          data: {
            items: [
              {
                type: "assistant",
                time: { created: 2 },
                content: [
                  { type: "reasoning", text: "thinking hard" },
                  { type: "text", text: "I need a decision." },
                  { type: "text", text: "Which database?" },
                  { type: "tool", id: "t1" },
                ],
              },
              { type: "user", content: [{ type: "text", text: "earlier" }] },
            ],
            cursor: {},
          },
        }),
      },
    },
  };

  assert.equal(await getLastAgentText(client, "ses_1"), "I need a decision.\n\nWhich database?");
});

test("picks the newest assistant message regardless of the order the API returned", async () => {
  const client = {
    v2: {
      session: {
        messages: async () => ({
          data: {
            items: [
              {
                type: "assistant",
                time: { created: 1 },
                content: [{ type: "text", text: "I'll read the file first." }],
              },
              { type: "user", content: [{ type: "text", text: "go" }] },
              {
                type: "assistant",
                time: { created: 5 },
                content: [{ type: "text", text: "All done, file read." }],
              },
            ],
          },
        }),
      },
    },
  };

  assert.equal(await getLastAgentText(client, "ses_1"), "All done, file read.");
});

test("falls back to the v1 endpoint when the v2 call fails", async () => {
  const client = {
    v2: {
      session: {
        // The SDK does not throw by default; a failed call returns an error.
        messages: async () => ({ data: undefined, error: { message: "not found" } }),
      },
    },
    session: {
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", time: { created: 5 } },
            parts: [{ type: "text", text: "From the v1 endpoint." }],
          },
        ],
      }),
    },
  };

  assert.equal(await getLastAgentText(client, "ses_1"), "From the v1 endpoint.");
});

test("reads the published SDK envelope that wraps messages at data.data", async () => {
  const client = {
    v2: {
      session: {
        messages: async () => ({
          data: {
            data: [
              {
                type: "assistant",
                time: { created: 5 },
                content: [{ type: "text", text: "From the published envelope." }],
              },
            ],
          },
        }),
      },
    },
  };

  assert.equal(await getLastAgentText(client, "ses_1"), "From the published envelope.");
});

test("falls back to v1 when the v2 page shape is unrecognized", async () => {
  const client = {
    v2: {
      session: {
        messages: async () => ({ data: { something: "unexpected" } }),
      },
    },
    session: {
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", time: { created: 5 } },
            parts: [{ type: "text", text: "From the v1 endpoint." }],
          },
        ],
      }),
    },
  };

  assert.equal(await getLastAgentText(client, "ses_1"), "From the v1 endpoint.");
});

test("falls back to v1 when the v2 page is empty or has no assistant text", async () => {
  // The two endpoints read different storage: a session can return an
  // empty v2 page while its messages are fully readable via v1.
  const v1 = {
    session: {
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", time: { created: 5 } },
            parts: [{ type: "text", text: "From the v1 endpoint." }],
          },
        ],
      }),
    },
  };
  const emptyPage = {
    v2: { session: { messages: async () => ({ data: { data: [], cursor: {} } }) } },
    ...v1,
  };
  assert.equal(await getLastAgentText(emptyPage, "ses_1"), "From the v1 endpoint.");
  const textlessPage = {
    v2: {
      session: {
        messages: async () => ({
          data: {
            data: [
              { type: "assistant", time: { created: 5 }, content: [{ type: "tool", id: "t" }] },
            ],
          },
        }),
      },
    },
    ...v1,
  };
  assert.equal(await getLastAgentText(textlessPage, "ses_1"), "From the v1 endpoint.");
});

test("reads assistant text from the v1 message shape when the v2 API is absent", async () => {
  const client = {
    session: {
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", time: { created: 5 } },
            parts: [
              { type: "reasoning", text: "thinking hard" },
              { type: "text", text: "I need a decision." },
            ],
          },
          {
            info: { role: "assistant", time: { created: 1 } },
            parts: [{ type: "text", text: "Older step." }],
          },
          { info: { role: "user" }, parts: [{ type: "text", text: "earlier" }] },
        ],
      }),
    },
  };

  assert.equal(await getLastAgentText(client, "ses_1"), "I need a decision.");
});

test("returns empty agent text for missing IDs, errors, and text-less sessions", async () => {
  assert.equal(await getLastAgentText({}, undefined), "");
  assert.equal(
    await getLastAgentText(
      {
        v2: {
          session: {
            messages: async () => {
              throw new Error("offline");
            },
          },
        },
      },
      "ses_1",
    ),
    "",
  );
  const noAssistant = {
    v2: {
      session: { messages: async () => ({ data: { items: [{ type: "user", content: [] }] } }) },
    },
  };
  assert.equal(await getLastAgentText(noAssistant, "ses_1"), "");
  const noText = {
    v2: {
      session: {
        messages: async () => ({ data: { items: [{ type: "assistant", content: [] }] } }),
      },
    },
  };
  assert.equal(await getLastAgentText(noText, "ses_1"), "");
});
