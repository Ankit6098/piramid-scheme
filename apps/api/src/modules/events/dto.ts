import { ingestSaleSchema, listSaleEventsQuerySchema, recordSaleSchema } from '@app/shared';
import { createZodDto } from 'nestjs-zod';

export class RecordSaleDto extends createZodDto(recordSaleSchema) {}
export class IngestSaleDto extends createZodDto(ingestSaleSchema) {}
export class ListSaleEventsQueryDto extends createZodDto(listSaleEventsQuerySchema) {}
