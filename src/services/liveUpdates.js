/**
 * Console-only real-time layer. Deliberately NOT used by the field app -
 * see the original design discussion: a WebSocket only makes sense for
 * the dispatcher console (few connections, always foregrounded) not
 * field dispatch (mobile OSes aggressively kill backgrounded sockets,
 * which is exactly why the field app uses push+ack+escalate instead).
 *
 * In-memory only, single process. Fine at this scale (a handful of
 * concurrent events, a few dispatchers each) - if this ever needs to run
 * as multiple backend instances behind a load balancer, this registry
 * would need to move to something shared (Redis pub/sub, etc.) since a
 * broadcast from one process can't currently reach a socket held open by
 * another.
 *
 * Deliberately sends a lightweight "something changed, refetch" signal
 * rather than pushing full diffed payloads over the socket - the console
 * already has correct, RBAC-filtered REST endpoints for every list it
 * shows, and re-deriving exactly what changed and to what payload shape
 * for a push-delivered diff is a lot of surface area for a marginal
 * latency win at this connection count. Polling stays in place under
 * this as a resilience backstop (lengthened interval, see console's
 * usePolling call sites) - if a socket silently drops, data still
 * self-heals within a few seconds instead of going stale indefinitely.
 */

const connectionsByEvent = new Map(); // eventId -> Set<WebSocket>

export function registerConnection(eventId, socket) {
  if (!connectionsByEvent.has(eventId)) {
    connectionsByEvent.set(eventId, new Set());
  }
  connectionsByEvent.get(eventId).add(socket);
}

export function unregisterConnection(eventId, socket) {
  connectionsByEvent.get(eventId)?.delete(socket);
}

export function broadcastEventUpdate(eventId, payload) {
  const sockets = connectionsByEvent.get(eventId);
  if (!sockets || sockets.size === 0) return;

  const message = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(message);
    }
  }
}
