import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { ApiKeyGuard } from './api-key.guard';
import { AdminIntegrationsController, IntegrationsIngestController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';

/** API clients (keys scoped to one program) and the machine sales-ingestion endpoint. */
@Module({
  imports: [EventsModule],
  controllers: [AdminIntegrationsController, IntegrationsIngestController],
  providers: [IntegrationsService, ApiKeyGuard],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
