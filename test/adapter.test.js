import assert from "node:assert/strict";
import test from "node:test";

import { answersToForm, createLegacyApi, formToQuestion } from "../index.js";

// A minimal V2 TUI plugin context: recorded data listeners, a state store,
// and recorded client replies.
function fakeContext() {
  const listeners = new Map();
  const calls = [];
  const context = {
    listeners,
    calls,
    data: {
      on(type, handler) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
        return () => listeners.get(type).splice(listeners.get(type).indexOf(handler), 1);
      },
    },
    client: {
      permission: {
        reply: async (input) => {
          calls.push(["permission.reply", input]);
        },
      },
      session: {
        form: {
          reply: async (input) => {
            calls.push(["form.reply", input]);
          },
          cancel: async (input) => {
            calls.push(["form.cancel", input]);
          },
        },
      },
    },
    storage: {
      store(name, { initial }) {
        const store = { ...initial };
        return [
          store,
          async (mutation) => {
            mutation(store);
          },
        ];
      },
    },
    keymap: { layer: () => {} },
    ui: { toast: { show: () => {} } },
  };
  return context;
}

function emit(context, type, item) {
  for (const handler of context.listeners.get(type) ?? []) handler(item);
}

test("formToQuestion prefers the field description as the question text", () => {
  const question = formToQuestion({
    sessionID: "ses_1",
    id: "form_1",
    fields: [
      {
        key: "deploy",
        title: "Deploy",
        description: "Deploy to production now?",
        type: "select",
        options: [{ label: "Yes", value: "yes" }],
      },
      { key: "note", title: "Note" },
    ],
  });

  assert.equal(question.questions[0].question, "Deploy to production now?");
  assert.equal(question.questions[0].header, "Deploy");
  assert.equal(question.questions[1].question, "Note");
});

test("answersToForm maps single-select labels to option values", () => {
  const form = {
    fields: [
      {
        key: "deploy",
        type: "select",
        options: [
          { label: "Yes, ship it", value: "yes" },
          { label: "No", value: "no" },
        ],
      },
      { key: "note", type: "string" },
      { key: "flags", type: "multiselect", options: [{ label: "Force", value: "--force" }] },
      { key: "confirmed", type: "boolean" },
      { key: "count", type: "integer" },
    ],
  };

  assert.deepEqual(answersToForm([["Yes, ship it"], ["a note"], ["Force"], ["yes"], ["3"]], form), {
    deploy: "yes",
    note: "a note",
    flags: ["--force"],
    confirmed: true,
    count: 3,
  });
  // A value sent as-is (typed reply echoing the value) still works.
  assert.deepEqual(answersToForm([["no"]], form), { deploy: "no" });
  // Free text for an option field that matches nothing is passed through.
  assert.deepEqual(answersToForm([["maybe"]], form), { deploy: "maybe" });
});

test("the adapter maps permission.asked onto the V1 shape with location", async () => {
  const context = fakeContext();
  const api = createLegacyApi(context);
  const seen = [];
  api.event.on("permission.asked", (event) => seen.push(event));

  emit(context, "permission.asked", {
    data: {
      id: "per_1",
      sessionID: "ses_1",
      action: "bash",
      resources: ["rm -rf *"],
      save: ["rm -rf *"],
    },
    location: { directory: "/tabs/one" },
  });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].properties.permission, "bash");
  assert.deepEqual(seen[0].properties.patterns, ["rm -rf *"]);
  assert.deepEqual(seen[0].properties.always, ["rm -rf *"]);
  assert.deepEqual(seen[0].location, { directory: "/tabs/one" });
});

test("the adapter maps form.created onto the V1 question shape", async () => {
  const context = fakeContext();
  const api = createLegacyApi(context);
  const seen = [];
  api.event.on("question.asked", (event) => seen.push(event));

  emit(context, "form.created", {
    data: {
      form: {
        id: "form_1",
        sessionID: "ses_1",
        fields: [{ key: "deploy", title: "Deploy", description: "Deploy now?", type: "select" }],
      },
    },
    location: { directory: "/tabs/one" },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "question.asked");
  assert.equal(seen[0].properties.id, "form_1");
  assert.equal(seen[0].properties.questions[0].question, "Deploy now?");
  assert.deepEqual(seen[0].location, { directory: "/tabs/one" });
});

test("the adapter maps form replies and cancellations onto request ids", () => {
  const context = fakeContext();
  const api = createLegacyApi(context);
  const replied = [];
  const rejected = [];
  api.event.on("question.replied", (event) => replied.push(event));
  api.event.on("question.rejected", (event) => rejected.push(event));

  emit(context, "form.replied", { data: { id: "form_1" }, location: {} });
  emit(context, "form.cancelled", { data: { id: "form_2" }, location: {} });

  assert.deepEqual(replied[0].properties, { requestID: "form_1" });
  assert.deepEqual(rejected[0].properties, { requestID: "form_2" });
});

test("permission and question replies route through the tracked session", async () => {
  const context = fakeContext();
  const api = createLegacyApi(context);
  // The real plugin subscribes to the attention events; that is how the
  // owning sessions are learned.
  api.event.on("permission.asked", () => {});
  api.event.on("question.asked", () => {});

  emit(context, "permission.asked", {
    data: { id: "per_1", sessionID: "ses_1", action: "bash", resources: ["ls"] },
  });
  emit(context, "form.created", {
    data: {
      form: {
        id: "form_1",
        sessionID: "ses_2",
        fields: [
          {
            key: "deploy",
            title: "Deploy",
            type: "select",
            options: [{ label: "Yes", value: "yes" }],
          },
        ],
      },
    },
  });

  await api.client.permission.reply({ requestID: "per_1", reply: "once", message: "ok" });
  await api.client.question.reply({ requestID: "form_1", answers: [["Yes"]] });
  await api.client.question.reject({ requestID: "form_1" });

  assert.deepEqual(context.calls, [
    [
      "permission.reply",
      { sessionID: "ses_1", requestID: "per_1", decision: "once", message: "ok" },
    ],
    ["form.reply", { sessionID: "ses_2", formID: "form_1", answer: { deploy: "yes" } }],
    ["form.cancel", { sessionID: "ses_2", formID: "form_1" }],
  ]);

  await assert.rejects(
    () => api.client.permission.reply({ requestID: "per_unknown", reply: "once" }),
    /unknown permission request/,
  );
  await assert.rejects(
    () => api.client.question.reply({ requestID: "form_unknown", answers: [] }),
    /unknown form/,
  );
});

test("event listeners are removable: on returns the unsubscribe and dispose clears all", () => {
  const context = fakeContext();
  const api = createLegacyApi(context);
  const seen = [];
  const unsubscribe = api.event.on("permission.asked", (event) => seen.push(event));
  api.event.on("permission.asked", (event) => seen.push(event));

  emit(context, "permission.asked", { data: { id: "per_1", sessionID: "ses_1", action: "bash" } });
  assert.equal(seen.length, 2);

  unsubscribe();
  emit(context, "permission.asked", { data: { id: "per_2", sessionID: "ses_1", action: "bash" } });
  assert.equal(seen.length, 3);

  api.event.dispose();
  emit(context, "permission.asked", { data: { id: "per_3", sessionID: "ses_1", action: "bash" } });
  assert.equal(seen.length, 3);
  // Disposing twice is safe.
  api.event.dispose();
});

test("kv is backed by the V2 storage store", async () => {
  const context = fakeContext();
  const api = createLegacyApi(context);

  assert.equal(api.kv.get("notify.pushMode", "auto"), "auto");
  api.kv.set("notify.pushMode", "on");
  assert.equal(api.kv.get("notify.pushMode", "auto"), "on");
});
