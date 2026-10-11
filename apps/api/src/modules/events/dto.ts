import { ingestSaleSchema, listSaleEventsQuerySchema, recordSaleSchema, rejectPendingSaleSchema } from '@app/shared';
import { createZodDto } from 'nestjs-zod';

export class RecordSaleDto extends createZodDto(recordSaleSchema) {}
export class IngestSaleDto extends createZodDto(ingestSaleSchema) {}
export class ListSaleEventsQueryDto extends createZodDto(listSaleEventsQuerySchema) {}
export class RejectPendingSaleDto extends createZodDto(rejectPendingSaleSchema) {}
