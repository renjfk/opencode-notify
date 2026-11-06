// Cross-instance session ownership for the V2 shared server.
//
// Every TUI instance receives every event, so exactly one of them should
// signal a given session. Neither the project directory nor the session-tab
// list can decide this: several Zellij tabs commonly share one launch
// directory, and session tabs are persisted per launch directory and
// live-synced across every instance, so all of them see the same tab strip.
// What is per instance is the route - the session it is actually showing.
//
// Each instance therefore publishes its displayed root session to a store
// shared by all instances (OpenCode's `storage.store`, persisted to disk and
// reloaded on change), keyed by process id, and remembers the last instance
// that displayed each session. A session is owned by, in order:
//
//   1. the instance displaying it (read live from its own route);
//   2. nobody else, when another live instance displays it;
//   3. the live instance that displayed it last (a background session tab
//      signals where the user last saw it);
//   4. otherwise exactly one live instance, the one with the lowest id, so a
//      session nobody has shown (started from another client, or last shown
//      by an instance that has exited) still signals once instead of in
//      every tab or in none.
//
// Liveness is a signal-0 probe of the process id, so instances that crashed
// without cleaning up stop counting immediately and are pruned on the next
// write. The route has no change event a plain plugin can subscribe to, so
// it is polled and written only when it changes.

const PUBLISH_INTERVAL_MS = 1000;

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return error?.code === "EPERM";
  }
}

function byId(a, b) {
  return a.localeCompare(b, undefined, { numeric: true });
}

export function createOwnership({
  // Maps a session (or subagent) id to its root session id.
  root,
  // Root session id this instance displays, or undefined.
  current,
  // A live-synced shared store: [state, update(mutation) => Promise].
  store,
  id = String(process.pid),
  isAlive = (key) => processAlive(Number(key)),
  setInterval: every = setInterval,
  clearInterval: cancel = clearInterval,
  intervalMs = PUBLISH_INTERVAL_MS,
}) {
  const [state, update] = store;
  // `undefined` means "never published": the first publish always writes,
  // which also registers this instance.
  let published;
  let disposed = false;

  function live(key) {
    return key === id || isAlive(key);
  }

  // Drop instances (and the sessions they last viewed) whose process is
  // gone, so a crashed TUI never keeps ownership of a session.
  function prune(draft) {
    draft.instances ??= {};
    draft.viewers ??= {};
    for (const key of Object.keys(draft.instances)) {
      if (!live(key)) delete draft.instances[key];
    }
    for (const [session, viewer] of Object.entries(draft.viewers)) {
      if (!draft.instances[viewer] && viewer !== id) delete draft.viewers[session];
    }
  }

  function publish() {
    if (disposed) return;
    const session = current() ?? null;
    if (session === published) return;
    published = session;
    update((draft) => {
      prune(draft);
      draft.instances[id] = { session };
      if (session) draft.viewers[session] = id;
    }).catch(() => {
      // Retry on the next tick.
      if (published === session) published = undefined;
    });
  }

  // `claim: false` skips the last-resort election: an instance that neither
  // displays nor last viewed the session does not own it. Used for busy
  // events, whose side effects (stopping a blink, clearing a notification)
  // belong to the tab the user is actually working in.
  function owns(sessionID, { claim = true } = {}) {
    const target = root(sessionID);
    if (current() === target) return true;

    const instances = state.instances ?? {};
    const alive = Object.keys(instances).filter(live);
    if (alive.some((key) => key !== id && instances[key]?.session === target)) return false;

    const viewer = state.viewers?.[target];
    if (viewer !== undefined && live(viewer)) return viewer === id;

    if (!claim) return false;
    const [leader] = [...new Set([...alive, id])].sort(byId);
    return leader === id;
  }

  publish();
  const timer = every(publish, intervalMs);
  timer?.unref?.();

  function dispose() {
    disposed = true;
    cancel(timer);
    return update((draft) => {
      prune(draft);
      delete draft.instances[id];
      for (const [session, viewer] of Object.entries(draft.viewers)) {
        if (viewer === id) delete draft.viewers[session];
      }
    }).catch(() => {});
  }

  return { owns, publish, dispose };
}
