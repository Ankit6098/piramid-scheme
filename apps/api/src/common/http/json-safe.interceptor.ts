import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { toJsonSafe } from './json-safe';

/**
 * Global interceptor: serializes bigint values in controller results as decimal strings and, outside
 * production, warns when a JSON response is not wrapped in the `{ data }` envelope.
 */
@Injectable()
export class JsonSafeInterceptor implements NestInterceptor {
  private readonly logger = new Logger('ResponseEnvelope');
  private readonly checkEnvelope = process.env.NODE_ENV !== 'production';

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((body: unknown) => {
        if (body === undefined || body === null) return body;
        if (body instanceof StreamableFile || Buffer.isBuffer(body) || typeof body === 'string') return body;
        if (
          this.checkEnvelope &&
          context.getType() === 'http' &&
          (typeof body !== 'object' || Array.isArray(body) || !('data' in body))
        ) {
          const req = context.switchToHttp().getRequest<{ method?: string; originalUrl?: string }>();
          this.logger.warn(`Response of ${req.method} ${req.originalUrl} is not a { data } envelope`);
        }
        return toJsonSafe(body);
      }),
    );
  }
}
