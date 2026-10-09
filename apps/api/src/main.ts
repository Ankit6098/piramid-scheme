import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap/configure-app';
import { ConfigValidationError, loadConfig } from './config/app-config';

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

  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    bodyParser: false,
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  configureApp(app, config);
  await app.listen(config.app.port);
  app.get(Logger).log(`API listening on :${config.app.port} (${config.env})`, 'Bootstrap');
}

bootstrap().catch((err: unknown) => {
  console.error('Fatal error during API bootstrap', err);
  process.exit(1);
});
