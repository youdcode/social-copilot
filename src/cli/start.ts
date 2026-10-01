import { startService } from '../service.ts';
import { buildServiceDeps, runCli } from './context.ts';

await runCli(async () => {
  const deps = buildServiceDeps();
  const service = startService(deps);
  deps.log('Service démarré.');
  const shutdown = () => {
    service.stop();
    deps.release();
    deps.log('Service arrêté.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
});
