import type { Response } from 'express';
import { Logger } from '@nestjs/common';
import type { CsvSink } from './ledger-query.service';

const logger = new Logger('CsvExport');

/**
 * Streams a CSV export to an Express response. Authorization and validation must already have
 * happened (errors before the first write still go through the exception filter); a failure
 * mid-stream can only abort the connection, so it is logged and the socket destroyed.
 */
export async function streamCsv(res: Response, filename: string, produce: (sink: CsvSink) => Promise<unknown>): Promise<void> {
  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const sink: CsvSink = {
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        if (res.destroyed || res.writableEnded) return reject(new Error('Client disconnected'));
        if (res.write(chunk, 'utf8')) return resolve();
        // Back-pressure: wait for the buffer to drain (or give up if the client goes away).
        const onDrain = () => {
          res.off('close', onClose);
          resolve();
        };
        const onClose = () => {
          res.off('drain', onDrain);
          reject(new Error('Client disconnected'));
        };
        res.once('drain', onDrain);
        res.once('close', onClose);
      }),
  };
  try {
    await produce(sink);
    res.end();
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), filename }, 'CSV export failed mid-stream');
    res.destroy(err instanceof Error ? err : undefined);
  }
}
