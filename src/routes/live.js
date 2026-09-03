import { pool } from '../db/pool.js';
import { registerConnection, unregisterConnection } from '../services/liveUpdates.js';

/**
 * Browsers' native WebSocket API can't send custom headers on the
 * handshake request, so this can't go through the normal requireAuth
 * (Authorization header) + requireEventMembership preHandler chain used
 * everywhere else. Auth travels as a query param instead
 * (?token=<jwt>) and gets verified manually here. Same trust level as
 * the header-based JWT elsewhere - just a different transport, since
 * that's the only transport the browser's WebSocket constructor allows.
 */
export default async function liveRoutes(fastify) {
  fastify.get('/events/:eventId/live', { websocket: true }, async (socket, request) => {
    const { eventId } = request.params;
    const { token } = request.query;

    let staffId;
    try {
      const decoded = fastify.jwt.verify(token);
      staffId = decoded.staffId;
    } catch {
      socket.close(4401, 'unauthorized');
      return;
    }

    const { rows } = await pool.query(
      `SELECT 1 FROM event_staffing
       WHERE event_id = $1 AND staff_id = $2 AND checked_out_at IS NULL`,
      [eventId, staffId]
    );
    if (rows.length === 0) {
      socket.close(4403, 'not checked in to this event');
      return;
    }

    registerConnection(eventId, socket);

    socket.on('close', () => unregisterConnection(eventId, socket));
    socket.on('error', () => unregisterConnection(eventId, socket));
  });
}
