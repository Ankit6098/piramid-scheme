import {
  approveOfferingSchema,
  createOfferingSchema,
  deactivateOfferingSchema,
  listOfferingsQuerySchema,
  updateOfferingSchema,
} from '@app/shared';
import { createZodDto } from 'nestjs-zod';

export class CreateOfferingDto extends createZodDto(createOfferingSchema) {}
export class UpdateOfferingDto extends createZodDto(updateOfferingSchema) {}
export class ListOfferingsQueryDto extends createZodDto(listOfferingsQuerySchema) {}
export class ApproveOfferingDto extends createZodDto(approveOfferingSchema) {}
export class DeactivateOfferingDto extends createZodDto(deactivateOfferingSchema) {}
