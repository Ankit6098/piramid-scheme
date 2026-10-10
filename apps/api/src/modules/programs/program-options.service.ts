import { Injectable } from '@nestjs/common';
import {
  LIVE_PROGRAM_STATUSES,
  optionDurationIssue,
  type CreateProgramOptionInput,
  type ProgramOptionDto,
  type UpdateProgramOptionInput,
  createProgramOptionSchema,
} from '@app/shared';
import type { z } from 'zod';
import {
  assertProgramAccess,
  AuditService,
  invalidState,
  notFound,
  PrismaService,
  validationFailed,
  type AuthContext,
  type Db,
} from '../../common';
import type { Prisma } from '../../generated/prisma/client';
import { lockProgram } from './program-db';
import { toOptionDto } from './programs.mapper';

type CreateOptionData = z.output<typeof createProgramOptionSchema>;

/** Option fields that are frozen once the option has enrollments (DB `trg_program_options_guard`). */
const TERMS_FIELDS = ['priceMinor', 'billingFrequency', 'durationDays'] as const;

function textOrNull(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/**
 * Program options (plans) — business rules §4. Prices are in the program currency and pay for the
 * plan; they never trigger rewards. Price, duration and frequency of an option that already has
 * enrollments never change (create a new option instead). A live program keeps ≥ 1 active option.
 */
@Injectable()
export class ProgramOptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(auth: AuthContext, programId: string, input: CreateOptionData | CreateProgramOptionInput): Promise<ProgramOptionDto> {
    assertProgramAccess(auth, programId, 'write');
    const durationIssue = optionDurationIssue(input.billingFrequency, input.durationDays);
    if (durationIssue) throw this.fieldError('durationDays', durationIssue);
    return this.prisma.runInTransaction(async (tx) => {
      const locked = await lockProgram(tx, programId);
      if (locked.status === 'COMPLETED' || locked.status === 'ARCHIVED') {
        throw invalidState(`Options can't be added to a ${locked.status.toLowerCase()} program`, { status: locked.status });
      }
      const program = await tx.program.findUniqueOrThrow({ where: { id: programId }, select: { currencyCode: true } });
      const sortOrder =
        input.sortOrder ??
        ((await tx.programOption.aggregate({ where: { programId }, _max: { sortOrder: true } }))._max.sortOrder ?? -1) + 1;
      const option = await tx.programOption.create({
        data: {
          programId,
          name: input.name,
          description: textOrNull(input.description),
          priceMinor: BigInt(input.priceMinor),
          currencyCode: program.currencyCode,
          billingFrequency: input.billingFrequency,
          durationDays: input.durationDays,
          renewalPolicy: input.renewalPolicy ?? 'MANUAL',
          sortOrder,
          isActive: true,
        },
      });
      await this.audit.record(tx, {
        action: 'program_option.create',
        resourceType: 'program_option',
        resourceId: option.id,
        programId,
        after: {
          name: option.name,
          priceMinor: option.priceMinor,
          currencyCode: option.currencyCode,
          billingFrequency: option.billingFrequency,
          durationDays: option.durationDays,
          renewalPolicy: option.renewalPolicy,
        },
      });
      return this.load(tx, option.id);
    });
  }

  async update(auth: AuthContext, programId: string, optionId: string, input: UpdateProgramOptionInput): Promise<ProgramOptionDto> {
    assertProgramAccess(auth, programId, 'write');
    return this.prisma.runInTransaction(async (tx) => {
      const locked = await lockProgram(tx, programId);
      const option = await tx.programOption.findFirst({
        where: { id: optionId, programId },
        include: { _count: { select: { enrollments: true } } },
      });
      if (!option) throw notFound('Option');
      if (locked.status === 'ARCHIVED') throw invalidState('Archived programs are read-only', { status: locked.status });

      const next = {
        name: input.name,
        description: input.description === undefined ? undefined : textOrNull(input.description),
        priceMinor: input.priceMinor === undefined ? undefined : BigInt(input.priceMinor),
        billingFrequency: input.billingFrequency,
        durationDays: input.durationDays,
        renewalPolicy: input.renewalPolicy,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      };
      const data: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(next) as Array<[keyof typeof next, unknown]>) {
        if (value === undefined || value === option[key]) continue;
        data[key] = value;
        before[key] = option[key];
        after[key] = value;
      }
      if (Object.keys(data).length === 0) return this.load(tx, optionId);

      const termsChanged = TERMS_FIELDS.filter((f) => f in data);
      if (termsChanged.length > 0 && option._count.enrollments > 0) {
        throw invalidState(
          'This option already has enrollments, so its price, duration and billing frequency can’t change. Create a new option instead.',
          { fields: termsChanged, enrollmentCount: option._count.enrollments },
        );
      }
      const frequency = (data.billingFrequency as typeof option.billingFrequency | undefined) ?? option.billingFrequency;
      const duration = (data.durationDays as number | undefined) ?? option.durationDays;
      if ('billingFrequency' in data || 'durationDays' in data) {
        const issue = optionDurationIssue(frequency, duration);
        if (issue) throw this.fieldError('durationDays', issue);
      }
      if (data.isActive === false && LIVE_PROGRAM_STATUSES.includes(locked.status)) {
        const otherActive = await tx.programOption.count({ where: { programId, isActive: true, id: { not: optionId } } });
        if (otherActive === 0) {
          throw invalidState('A published program needs at least one active option. Add another option before deactivating this one.');
        }
      }

      await tx.programOption.update({ where: { id: optionId }, data: data as Prisma.ProgramOptionUpdateInput });
      const action =
        Object.keys(data).length === 1 && 'isActive' in data
          ? data.isActive
            ? 'program_option.activate'
            : 'program_option.deactivate'
          : 'program_option.update';
      await this.audit.record(tx, {
        action,
        resourceType: 'program_option',
        resourceId: optionId,
        programId,
        before,
        after,
      });
      return this.load(tx, optionId);
    });
  }

  private async load(db: Db, optionId: string): Promise<ProgramOptionDto> {
    const option = await db.programOption.findUniqueOrThrow({
      where: { id: optionId },
      include: { _count: { select: { enrollments: true } } },
    });
    return toOptionDto(option);
  }

  private fieldError(path: string, message: string) {
    return validationFailed(message, { issues: [{ path, message, code: 'custom' }] });
  }
}
