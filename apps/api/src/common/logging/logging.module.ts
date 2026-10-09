import { Module, RequestMethod } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LoggerModule, type Params } from 'nestjs-pino';
import { AppConfig, type AppConfigShape } from '../../config/app-config';

/**
 * Redaction paths: secrets never reach the logs. `*` matches one level, so common nestings are listed.
 * (Also: never log OTPs, passwords, tokens, cookies or full emails yourself.)
 */
const SECRET_KEYS = [
  'password',
  'passwordHash',
  'newPassword',
  'currentPassword',
  'code',
  'codeHash',
  'otp',
  'token',
  'tokenHash',
  'csrfToken',
  'otpPepper',
];

export const LOG_REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'headers.cookie',
  'headers.authorization',
  ...SECRET_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`, `*.*.*.${k}`]),
];

export function buildLoggerParams(config: AppConfigShape): Params {
  const pretty = !config.isProduction && !config.isTest && process.stdout.isTTY;
  return {
    // Express 5 / path-to-regexp v8 wildcard syntax (avoids the legacy "*" route warning).
    forRoutes: [{ path: '{*splat}', method: RequestMethod.ALL }],
    pinoHttp: {
      level: config.log.level,
      redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
      // requestContextMiddleware already assigned req.id (from x-request-id or a new uuid).
      genReqId: (req: IncomingMessage) => (req as IncomingMessage & { id?: string }).id ?? 'unknown',
      customProps: (req: IncomingMessage) => ({ requestId: (req as IncomingMessage & { id?: string }).id }),
      quietReqLogger: true,
      autoLogging: {
        ignore: (req: IncomingMessage) => (req.url ?? '').startsWith('/api/v1/health'),
      },
      customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      serializers: {
        req: (req: { id?: string; method?: string; url?: string; remoteAddress?: string }) => ({
          id: req.id,
          method: req.method,
          // Drop query strings: they may carry tokens/emails.
          url: req.url?.split('?')[0],
          remoteAddress: req.remoteAddress,
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      },
      ...(pretty
        ? { transport: { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' } } }
        : {}),
    },
  };
}

/** nestjs-pino (JSON logs, redaction, requestId on every request-scoped line). */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => buildLoggerParams(config),
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
