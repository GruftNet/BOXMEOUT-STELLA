import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-jwt-secret-for-dispute-tests';

jest.mock('../../src/services/DisputeService');

import * as DisputeService from '../../src/services/DisputeService';
import { AppError } from '../../src/utils/AppError';
import disputesRouter from '../../src/routes/disputes.routes';

const app = express();
app.use(express.json());
app.use('/api/disputes', disputesRouter);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: { message: err.message } });
  } else {
    res.status(500).json({ error: { message: err.message } });
  }
});

const adminToken = jwt.sign({ role: 'admin' }, 'test-jwt-secret-for-dispute-tests', { expiresIn: '1h' });

const mockDispute = {
  id: 1,
  market_id: 'test-market-id',
  reason: 'This is a valid dispute reason with enough length',
  status: 'open',
  admin_notes: null,
  final_outcome: null,
  raised_at: new Date(),
  reviewed_at: null,
  resolved_at: null,
};

const mockReviewedDispute = {
  ...mockDispute,
  status: 'reviewed',
  admin_notes: 'Reviewing this dispute',
  reviewed_at: new Date(),
};

const mockResolvedDispute = {
  ...mockDispute,
  status: 'resolved',
  final_outcome: 'dismissed',
  admin_notes: 'Dispute dismissed after review',
  resolved_at: new Date(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/disputes', () => {
  const validBody = {
    marketId: 'test-market-id',
    reason: 'This is a valid dispute reason with enough length',
  };

  it('creates a new dispute for a resolved market', async () => {
    (DisputeService.createDispute as jest.Mock).mockResolvedValue(mockDispute);

    const res = await request(app).post('/api/disputes').send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data.market_id).toBe('test-market-id');
    expect(res.body.data.status).toBe('open');
  });

  it('returns 404 when market does not exist', async () => {
    (DisputeService.createDispute as jest.Mock).mockRejectedValue(
      AppError.notFound('Market not found'),
    );

    const res = await request(app).post('/api/disputes').send(validBody);

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Market not found');
  });

  it('returns 400 when market is not resolved', async () => {
    (DisputeService.createDispute as jest.Mock).mockRejectedValue(
      AppError.badRequest('Can only dispute resolved markets'),
    );

    const res = await request(app).post('/api/disputes').send(validBody);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Can only dispute resolved markets');
  });

  it('returns 409 when dispute already exists for the market', async () => {
    (DisputeService.createDispute as jest.Mock).mockRejectedValue(
      AppError.conflict('Dispute already exists for this market'),
    );

    const res = await request(app).post('/api/disputes').send(validBody);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('Dispute already exists for this market');
  });

  it('returns 422 when reason is too short', async () => {
    const res = await request(app)
      .post('/api/disputes')
      .send({ marketId: 'test-market-id', reason: 'short' });

    expect(res.status).toBe(422);
  });

  it('returns 422 when marketId is missing', async () => {
    const res = await request(app)
      .post('/api/disputes')
      .send({ reason: 'This is a valid dispute reason with enough length' });

    expect(res.status).toBe(422);
  });
});

describe('GET /api/disputes', () => {
  it('returns paginated list of disputes for admin', async () => {
    (DisputeService.listDisputes as jest.Mock).mockResolvedValue({
      data: [mockDispute],
      pagination: {
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    });

    const res = await request(app)
      .get('/api/disputes')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ page: 1, limit: 20 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('disputes');
    expect(res.body.data).toHaveProperty('pagination');
    expect(res.body.data.disputes).toHaveLength(1);
  });

  it('returns 401 without admin token', async () => {
    const res = await request(app).get('/api/disputes');

    expect(res.status).toBe(401);
  });

  it('returns 403 with invalid token', async () => {
    const res = await request(app)
      .get('/api/disputes')
      .set('Authorization', 'Bearer invalid-token');

    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid status filter', async () => {
    const res = await request(app)
      .get('/api/disputes')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ status: 'invalid' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for page < 1', async () => {
    const res = await request(app)
      .get('/api/disputes')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ page: 0 });

    expect(res.status).toBe(400);
  });

  it('returns 400 for limit > 100', async () => {
    const res = await request(app)
      .get('/api/disputes')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ limit: 200 });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/disputes/:disputeId', () => {
  it('returns a single dispute by ID', async () => {
    (DisputeService.getDisputeById as jest.Mock).mockResolvedValue(mockDispute);

    const res = await request(app).get('/api/disputes/1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(1);
  });

  it('returns 404 when dispute not found', async () => {
    (DisputeService.getDisputeById as jest.Mock).mockRejectedValue(
      AppError.notFound('Dispute not found'),
    );

    const res = await request(app).get('/api/disputes/999');

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Dispute not found');
  });

  it('returns 400 for invalid dispute ID', async () => {
    const res = await request(app).get('/api/disputes/abc');

    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/disputes/:disputeId/review', () => {
  it('reviews an open dispute', async () => {
    (DisputeService.reviewDispute as jest.Mock).mockResolvedValue(mockReviewedDispute);

    const res = await request(app)
      .patch('/api/disputes/1/review')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ adminNotes: 'Reviewing this dispute' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('reviewed');
    expect(res.body.data.admin_notes).toBe('Reviewing this dispute');
  });

  it('returns 400 when dispute is not open', async () => {
    (DisputeService.reviewDispute as jest.Mock).mockRejectedValue(
      AppError.badRequest('Can only review open disputes'),
    );

    const res = await request(app)
      .patch('/api/disputes/1/review')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ adminNotes: 'Reviewing this dispute' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Can only review open disputes');
  });

  it('returns 404 when dispute not found', async () => {
    (DisputeService.reviewDispute as jest.Mock).mockRejectedValue(
      AppError.notFound('Dispute not found'),
    );

    const res = await request(app)
      .patch('/api/disputes/999/review')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ adminNotes: 'Reviewing this dispute' });

    expect(res.status).toBe(404);
  });

  it('returns 401 without admin token', async () => {
    const res = await request(app)
      .patch('/api/disputes/1/review')
      .send({ adminNotes: 'Reviewing this dispute' });

    expect(res.status).toBe(401);
  });

  it('returns 422 when adminNotes is too short', async () => {
    const res = await request(app)
      .patch('/api/disputes/1/review')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ adminNotes: 'ab' });

    expect(res.status).toBe(422);
  });
});

describe('PATCH /api/disputes/:disputeId/resolve', () => {
  it('resolves a reviewed dispute with DISMISS action', async () => {
    (DisputeService.resolveDispute as jest.Mock).mockResolvedValue(mockResolvedDispute);

    const res = await request(app)
      .patch('/api/disputes/1/resolve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        action: 'DISMISS',
        resolution: 'Dispute dismissed after review - no evidence found',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('resolved');
    expect(res.body.data.final_outcome).toBe('dismissed');
  });

  it('resolves a reviewed dispute with RESOLVE_NEW_OUTCOME action', async () => {
    const resolvedWithOutcome = {
      ...mockDispute,
      status: 'resolved',
      final_outcome: 'resolved_outcome_1',
      resolved_at: new Date(),
    };
    (DisputeService.resolveDispute as jest.Mock).mockResolvedValue(resolvedWithOutcome);

    const res = await request(app)
      .patch('/api/disputes/1/resolve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        action: 'RESOLVE_NEW_OUTCOME',
        resolution: 'New outcome determined based on evidence',
        newWinningOutcome: 1,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('resolved');
    expect(res.body.data.final_outcome).toBe('resolved_outcome_1');
  });

  it('returns 400 when resolving without prior review', async () => {
    (DisputeService.resolveDispute as jest.Mock).mockRejectedValue(
      AppError.badRequest('Can only resolve disputes that have been reviewed'),
    );

    const res = await request(app)
      .patch('/api/disputes/1/resolve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        action: 'DISMISS',
        resolution: 'Dispute dismissed after review - no evidence found',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Can only resolve disputes that have been reviewed');
  });

  it('returns 422 when RESOLVE_NEW_OUTCOME without newWinningOutcome', async () => {
    const res = await request(app)
      .patch('/api/disputes/1/resolve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        action: 'RESOLVE_NEW_OUTCOME',
        resolution: 'New outcome determined based on evidence',
      });

    expect(res.status).toBe(422);
  });

  it('returns 422 when resolution is too short', async () => {
    const res = await request(app)
      .patch('/api/disputes/1/resolve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'DISMISS', resolution: 'short' });

    expect(res.status).toBe(422);
  });

  it('returns 401 without admin token', async () => {
    const res = await request(app)
      .patch('/api/disputes/1/resolve')
      .send({
        action: 'DISMISS',
        resolution: 'Dispute dismissed after review - no evidence found',
      });

    expect(res.status).toBe(401);
  });

  it('returns 404 when dispute not found', async () => {
    (DisputeService.resolveDispute as jest.Mock).mockRejectedValue(
      AppError.notFound('Dispute not found'),
    );

    const res = await request(app)
      .patch('/api/disputes/999/resolve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        action: 'DISMISS',
        resolution: 'Dispute dismissed after review - no evidence found',
      });

    expect(res.status).toBe(404);
  });

  it('sends dispute resolved email when notifyEmail is provided', async () => {
    (DisputeService.resolveDispute as jest.Mock).mockResolvedValue(mockResolvedDispute);

    const res = await request(app)
      .patch('/api/disputes/1/resolve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        action: 'DISMISS',
        resolution: 'Dispute dismissed after review - no evidence found',
        notifyEmail: 'user@example.com',
      });

    expect(res.status).toBe(200);
    expect(DisputeService.resolveDispute).toHaveBeenCalledWith(
      1,
      'dismissed',
      'Dispute dismissed after review - no evidence found',
      'user@example.com',
    );
  });
});
