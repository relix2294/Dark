import { loadConfig } from './config.js';
import { buildApp, createDeps } from './app.js';
import { startWorkers } from './workers.js';

const config = loadConfig();
const deps = createDeps(config);
const app = await buildApp(deps);
const workers = await startWorkers(deps, app.log);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'остановка');
  await workers.stop();
  await app.close();
  await deps.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: config.HOST });
