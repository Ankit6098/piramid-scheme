import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { CSRF_HEADER } from '../common/auth/cookies';
import { requestContextMiddleware } from '../common/context/request-context';
import { bigintJsonReplacer } from '../common/http/json-safe';
import { IDEMPOTENCY_HEADER } from '../common/idempotency/idempotency-key.decorator';
import type { AppConfigShape } from '../config/app-config';

export const BODY_LIMIT = '100kb';

export interface ConfigureAppOptions {
  /** Mount Swagger UI at /api/docs (default: non-production). */
  swagger?: boolean;
}

/**
 * Applies the HTTP pipeline shared by main.ts and the integration tests. Call BEFORE `app.init()` /
 * `app.listen()`. The app must be created with `{ bodyParser: false }` so the 100 kb limit applies.
 *
 * Order: trust proxy → request context (requestId, ALS) → helmet → CORS → cookies → body parsers →
 * (Nest: pino-http → guards → pipes → handler → interceptors → exception filter).
 */
export function configureApp(app: NestExpressApplication, config: AppConfigShape, options: ConfigureAppOptions = {}): void {
  app.set('trust proxy', config.app.trustProxy);
  app.set('json replacer', bigintJsonReplacer);
  app.set('x-powered-by', false);
  app.set('etag', false); // user-specific JSON must not be served from HTTP caches

  app.use(requestContextMiddleware);
  app.use(
    helmet({
      contentSecurityPolicy: false, // JSON API; the web app sets its own CSP
      crossOriginEmbedderPolicy: false,
      hsts: config.isProduction ? { maxAge: 15_552_000, includeSubDomains: true } : false,
    }),
  );
  app.enableCors({
    origin: (origin, cb) => {
      // Non-browser requests have no Origin; browser origins must be allow-listed.
      if (!origin || config.app.corsOrigins.includes(origin)) cb(null, true);
      else cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', CSRF_HEADER, IDEMPOTENCY_HEADER, 'x-request-id'],
    exposedHeaders: ['x-request-id', 'retry-after'],
    maxAge: 600,
  });
  app.use(cookieParser());
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: false });

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();

  if (options.swagger ?? !config.isProduction) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Referral & Rewards Platform API')
        .setVersion('1')
        .addCookieAuth('sid')
        .addApiKey({ type: 'apiKey', in: 'header', name: CSRF_HEADER }, 'csrf')
        .build(),
    );
    SwaggerModule.setup('api/docs', app, cleanupOpenApiDoc(doc));
  }
}
