import { requireAuth, requireEventMembership, requireRole } from '../middleware/auth.js';
import { closeEvent } from '../services/eventLifecycle.js';

/**
 * Event lifecycle actions available to a dispatcher on their own event,
 * as opposed to the admin-only equivalents in routes/admin.js (which
 * can act on any event, not just one the caller is currently working).
 * Closing an event after it's wrapped up is routine dispatcher work,
 * not something that should require finding an admin - reopening
 * stays admin-only, since undoing a close is more of a correction than
 * routine work.
 */
export default async function eventRoutes(fastify) {
  fastify.post(
    '/events/:eventId/close',
    { preHandler: [requireAuth, requireEventMembership, requireRole('dispatcher')] },
    async (request, reply) => {
      try {
        const result = await closeEvent({ eventId: request.params.eventId });
        reply.send(result);
      } catch (err) {
        reply.code(500).send({ error: err.message });
      }
    }
  );
}
