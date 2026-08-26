import assert from "node:assert/strict";
import test from "node:test";

import { getSessionTitle } from "../lib/session.js";

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
