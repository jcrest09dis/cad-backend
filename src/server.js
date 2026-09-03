import { buildApp } from './app.js';
import { startOutboxWorker } from './services/outboxWorker.js';
import { startEscalationWorker } from './services/escalationWorker.js';
import { seedFirstAdminIfNeeded } from './lib/seedAdmin.js';

const app = buildApp();

const stopOutbox = startOutboxWorker();
const stopEscalation = startEscalationWorker();

await seedFirstAdminIfNeeded();

app.listen({ port: process.env.PORT ?? 3000, host: '0.0.0.0' })
  .catch(err => {
    app.log.error(err);
    process.exit(1);
  });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    stopOutbox();
    stopEscalation();
    await app.close();
    process.exit(0);
  });
}
