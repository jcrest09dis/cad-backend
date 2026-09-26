import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import 'dotenv/config';

import assignmentRoutes from './routes/assignments.js';
import unitRoutes from './routes/units.js';
import incidentRoutes from './routes/incidents.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import meRoutes from './routes/me.js';
import liveRoutes from './routes/live.js';
import reportRoutes from './routes/reports.js';
import eventRoutes from './routes/events.js';
import venueMapRoutes from './routes/venueMaps.js';

export function buildApp() {
  const app = Fastify({
    logger: { transport: { target: 'pino-pretty' } },
    // Default (1MB) is too small for a base64-encoded venue map image
    // upload (admin.js's POST /admin/venues/:venueId/map) - base64 adds
    // ~33% overhead on top of the image's own size.
    bodyLimit: 10 * 1024 * 1024,
  });

  app.register(fastifyJwt, { secret: process.env.JWT_SECRET });
  app.register(fastifyWebsocket);

  // Explicit allowlist instead of reflecting any origin. Defaults to the
  // console's local dev port so nothing breaks out of the box; set
  // CORS_ALLOWED_ORIGINS (comma-separated) to your real console URL(s)
  // before deploying anywhere reachable from the public internet.
  // The field app isn't affected either way - React Native fetch calls
  // don't carry a browser Origin header, so CORS doesn't apply to them.
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.register(fastifyCors, {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'), false);
      }
    },
  });

  app.get('/health', async () => ({ ok: true }));

  app.register(authRoutes);
  app.register(adminRoutes);
  app.register(meRoutes);
  app.register(assignmentRoutes);
  app.register(unitRoutes);
  app.register(incidentRoutes);
  app.register(liveRoutes);
  app.register(reportRoutes);
  app.register(eventRoutes);
  app.register(venueMapRoutes);

  return app;
}