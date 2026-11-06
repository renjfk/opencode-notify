import assert from "node:assert/strict";
import test from "node:test";

import { createOwnership, processAlive } from "../lib/ownership.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

// One shared store standing in for OpenCode's live-synced `storage.store`:
// every update loads a draft, mutates it, and replaces the stored value, the
// same way the host applies writes from any instance.
function sharedStore() {
  const state = { instances: {}, viewers: {} };
  let writes = 0;
  let failNext = false;
  const update = async (mutation) => {
    if (failNext) {
      failNext = false;
      throw new Error("write failed");
    }
    const draft = structuredClone(state);
    mutation(draft);
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, draft);
    writes += 1;
  };
  return {
    state,
    entry: [state, update],
    get writes() {
      return writes;
    },
    failNextWrite() {
      failNext = true;
    },
  };
}

// A TUI instance: its own route, the shared store, an injected process table
// and a manual publish tick.
function createInstance(shared, id, { alive, roots = {} }) {
  let route;
  let tick = () => {};
  alive.add(id);
  const ownership = createOwnership({
    id,
    root: (sessionID) => roots[sessionID] ?? sessionID,
    current: () => route,
    store: shared.entry,
    isAlive: (key) => alive.has(key),
    setInterval: (callback) => {
      tick = callback;
      return { unref() {} };
    },
    clearInterval: () => {},
  });
  return {
    owns: (sessionID, options) => ownership.owns(sessionID, options),
    dispose: () => ownership.dispose(),
    async show(sessionID) {
      route = sessionID;
      tick();
      await flush();
    },
    async tick() {
      tick();
      await flush();
    },
  };
}

function setup(ids, options = {}) {
  const shared = sharedStore();
  const alive = new Set();
  const instances = ids.map((id) => createInstance(shared, id, { alive, ...options }));
  return { shared, alive, instances };
}

test("the instance displaying a session owns it, other instances do not", async () => {
  const {
    instances: [one, two],
  } = setup(["100", "200"]);
  await one.show("ses_1");
  await two.show("ses_2");

  assert.equal(one.owns("ses_1"), true);
  assert.equal(two.owns("ses_1"), false);
  assert.equal(two.owns("ses_2"), true);
  assert.equal(one.owns("ses_2"), false);
});

test("instances sharing one launch directory do not all own the same session", async () => {
  // The bug this replaces: every instance in one directory shares the
  // session-tab list, so a tab-list match made all of them signal.
  const {
    instances: [one, two, three],
  } = setup(["100", "200", "300"]);
  await one.show("ses_1");

  const owners = [one, two, three].filter((instance) => instance.owns("ses_1"));
  assert.equal(owners.length, 1);
  assert.equal(owners[0], one);
});

test("a background session belongs to the instance that showed it last", async () => {
  const {
    instances: [one, two],
  } = setup(["100", "200"]);
  await one.show("ses_1");
  await two.show("ses_2");
  // The first instance switches to another session tab while ses_1 runs.
  await one.show("ses_3");

  assert.equal(one.owns("ses_1"), true);
  assert.equal(two.owns("ses_1"), false);
});

test("showing a session in another instance moves its ownership there", async () => {
  const {
    instances: [one, two],
  } = setup(["100", "200"]);
  await one.show("ses_1");
  await one.show("ses_3");
  await two.show("ses_1");
  await two.show("ses_2");

  assert.equal(one.owns("ses_1"), false);
  assert.equal(two.owns("ses_1"), true);
});

test("a session nobody has shown is owned by exactly one instance", async () => {
  const {
    instances: [one, two, three],
  } = setup(["300", "100", "200"]);
  await one.show("ses_a");
  await two.show("ses_b");
  await three.show("ses_c");

  assert.deepEqual(
    [one, two, three].map((instance) => instance.owns("ses_new")),
    [false, true, false],
  );
});

test("strict ownership never elects an instance", async () => {
  const {
    instances: [one, two],
  } = setup(["100", "200"]);
  await one.show("ses_1");
  await two.show("ses_2");

  assert.equal(one.owns("ses_new", { claim: false }), false);
  assert.equal(two.owns("ses_new", { claim: false }), false);
  assert.equal(one.owns("ses_1", { claim: false }), true);
});

test("an instance that exited no longer owns its sessions", async () => {
  const {
    shared,
    alive,
    instances: [one, two],
  } = setup(["100", "200"]);
  await one.show("ses_1");
  await two.show("ses_2");

  // The first TUI crashes without cleaning up.
  alive.delete("100");
  assert.equal(two.owns("ses_1"), true);

  // The next write prunes it from the shared store.
  await two.show("ses_3");
  assert.deepEqual(Object.keys(shared.state.instances), ["200"]);
  assert.equal(shared.state.viewers.ses_1, undefined);
});

test("subagent sessions resolve to their root session", async () => {
  const {
    instances: [one, two],
  } = setup(["100", "200"], { roots: { ses_child: "ses_1" } });
  await one.show("ses_1");
  await two.show("ses_2");

  assert.equal(one.owns("ses_child"), true);
  assert.equal(two.owns("ses_child"), false);
});

test("publishes only when the displayed session changes", async () => {
  const {
    shared,
    instances: [one],
  } = setup(["100"]);
  await flush();
  const registered = shared.writes;

  await one.show("ses_1");
  await one.tick();
  await one.tick();
  assert.equal(shared.writes, registered + 1);
  assert.deepEqual(shared.state.instances["100"], { session: "ses_1" });
});

test("a failed write is retried on the next tick", async () => {
  const {
    shared,
    instances: [one],
  } = setup(["100"]);
  await flush();

  shared.failNextWrite();
  await one.show("ses_1");
  assert.equal(shared.state.instances["100"].session, null);

  await one.tick();
  assert.equal(shared.state.instances["100"].session, "ses_1");
});

test("dispose removes the instance and the sessions it last viewed", async () => {
  const {
    shared,
    instances: [one, two],
  } = setup(["100", "200"]);
  await one.show("ses_1");
  await two.show("ses_2");

  await one.dispose();
  assert.deepEqual(Object.keys(shared.state.instances), ["200"]);
  assert.deepEqual(shared.state.viewers, { ses_2: "200" });
});

test("processAlive probes the process table", () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(0), false);
  assert.equal(processAlive(-1), false);
  assert.equal(processAlive(Number.NaN), false);
});
