import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { ConfigValidationError, loadConfig } from './config/app-config';
import { WorkerModule } from './worker.module';

/** Background worker entry: `node dist/worker.js` (outbox relay + scheduled jobs; no HTTP). */
async function bootstrap(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.get(Logger).log(`Worker started (${config.env})`, 'Bootstrap');
}

bootstrap().catch((err: unknown) => {
  console.error('Fatal error during worker bootstrap', err);
  process.exit(1);
});
