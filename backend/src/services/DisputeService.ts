import { eq, desc, and, sql } from 'drizzle-orm';
import { db } from '../config/db';
import { disputes, markets, type Dispute, type NewDispute } from '../db/schema';
import { AppError } from '../utils/AppError';
import * as emailService from './email.service';
import { logger } from '../utils/logger';

export interface DisputeFilters {
  status?: string;
  marketId?: string;
}

export interface Pagination {
  page: number;
  limit: number;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export async function createDispute(marketId: string, reason: string): Promise<Dispute> {
  const market = await db
    .select()
    .from(markets)
    .where(eq(markets.market_id, marketId))
    .limit(1);

  if (!market.length) {
    throw AppError.notFound('Market not found');
  }

  if (market[0].status !== 'resolved') {
    throw AppError.badRequest('Can only dispute resolved markets');
  }

  const existingDispute = await db
    .select()
    .from(disputes)
    .where(eq(disputes.market_id, marketId))
    .limit(1);

  if (existingDispute.length) {
    throw AppError.conflict('Dispute already exists for this market');
  }

  const newDispute: NewDispute = {
    market_id: marketId,
    reason,
    status: 'open',
  };

  const [dispute] = await db.insert(disputes).values(newDispute).returning();

  return dispute;
}

export async function listDisputes(
  filters: DisputeFilters = {},
  pagination: Pagination = { page: 1, limit: 20 }
): Promise<PaginatedResult<Dispute>> {
  let query = db.select().from(disputes);

  const conditions = [];
  if (filters.status) {
    conditions.push(eq(disputes.status, filters.status));
  }
  if (filters.marketId) {
    conditions.push(eq(disputes.market_id, filters.marketId));
  }

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  const offset = (pagination.page - 1) * pagination.limit;
  const disputeResults = await query
    .orderBy(desc(disputes.raised_at))
    .limit(pagination.limit)
    .offset(offset);

  let countQuery = db.select({ count: sql<number>`count(*)`.as('count') }).from(disputes);
  if (conditions.length > 0) {
    countQuery = countQuery.where(and(...conditions)) as typeof countQuery;
  }
  const [{ count }] = await countQuery;
  const total = Number(count);
  const totalPages = Math.ceil(total / pagination.limit);

  return {
    data: disputeResults,
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      total,
      totalPages,
      hasNext: pagination.page < totalPages,
      hasPrev: pagination.page > 1,
    },
  };
}

export async function getDisputeById(disputeId: number): Promise<Dispute> {
  const [dispute] = await db
    .select()
    .from(disputes)
    .where(eq(disputes.id, disputeId))
    .limit(1);

  if (!dispute) {
    throw AppError.notFound('Dispute not found');
  }

  return dispute;
}

export async function reviewDispute(disputeId: number, adminNotes: string): Promise<Dispute> {
  const dispute = await getDisputeById(disputeId);

  if (dispute.status !== 'open') {
    throw AppError.badRequest('Can only review open disputes');
  }

  const [updatedDispute] = await db
    .update(disputes)
    .set({
      status: 'reviewed',
      admin_notes: adminNotes,
      reviewed_at: new Date(),
    })
    .where(eq(disputes.id, disputeId))
    .returning();

  return updatedDispute;
}

export async function resolveDispute(
  disputeId: number,
  finalOutcome: string,
  resolution?: string,
  notifyEmail?: string
): Promise<Dispute> {
  const dispute = await getDisputeById(disputeId);

  if (dispute.status !== 'reviewed') {
    throw AppError.badRequest('Can only resolve disputes that have been reviewed');
  }

  const [updatedDispute] = await db
    .update(disputes)
    .set({
      status: 'resolved',
      final_outcome: finalOutcome,
      admin_notes: resolution || dispute.admin_notes,
      resolved_at: new Date(),
    })
    .where(eq(disputes.id, disputeId))
    .returning();

  if (notifyEmail) {
    sendDisputeResolvedEmail(disputeId, dispute.market_id, finalOutcome, notifyEmail);
  }

  return updatedDispute;
}

async function sendDisputeResolvedEmail(
  disputeId: number,
  marketId: string,
  resolution: string,
  userEmail: string
): Promise<void> {
  try {
    await emailService.sendDisputeResolved(
      userEmail,
      disputeId.toString(),
      marketId,
      resolution
    );
  } catch (error) {
    logger.error({ msg: 'Failed to send dispute resolved email', disputeId, error });
  }
}
