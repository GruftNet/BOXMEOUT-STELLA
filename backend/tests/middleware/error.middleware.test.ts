import type { Request, Response, NextFunction } from "express";
import { beforeEach, describe, it, expect, jest } from "@jest/globals";
import { errorMiddleware } from "../../src/middleware/error.middleware";
import { AppError } from "../../src/utils/AppError";
import { logger } from "../../src/utils/logger";

jest.mock("../../src/utils/logger");

describe("errorMiddleware", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {};
    mockRes = {
      status: jest.fn<Response["status"]>().mockReturnThis(),
      json: jest.fn<Response["json"]>().mockReturnThis(),
    };
    mockNext = jest.fn();
    process.env.NODE_ENV = "development";
  });

  describe("AppError handling", () => {
    it('should catch AppError(404, "Not found") and return correct response', () => {
      const error = new AppError(404, "Not found");

      errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 404,
          message: "Not found",
        },
      });
    });

    it("should map AppError to correct HTTP status code", () => {
      const error = new AppError(403, "Forbidden");

      errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 403,
          message: "Forbidden",
        },
      });
    });

    it("should include details when provided in AppError", () => {
      const details = { field: "email", reason: "already exists" };
      const error = new AppError(400, "Validation error", undefined, details);

      errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 400,
          message: "Validation error",
          details,
        },
      });
    });

    it("should not include details when not provided", () => {
      const error = new AppError(401, "Unauthorized");

      errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

      const response = (mockRes.json as jest.Mock).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(response.error).not.toHaveProperty("details");
    });

    it("should log 5xx AppErrors", () => {
      const error = new AppError(500, "Internal error");

      errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

      expect(logger.error).toHaveBeenCalledWith({
        message: "Internal error",
        statusCode: 500,
        details: undefined,
      });
    });

    it("should not log 4xx AppErrors", () => {
      const error = new AppError(404, "Not found");

      errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

      expect(logger.error).not.toHaveBeenCalled();
    });

    it("should log 5xx AppErrors with details", () => {
      const details = { reason: "database connection failed" };
      const error = new AppError(503, "Service unavailable", undefined, details);

      errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

      expect(logger.error).toHaveBeenCalledWith({
        message: "Service unavailable",
        statusCode: 503,
        details,
      });
    });
  });

  describe("Unhandled Error handling", () => {
    it("should catch unhandled Error and return 500", () => {
      const error = new Error("Something went wrong");

      errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 500,
          message: "Something went wrong",
        },
      });
    });

    it("should not leak stack trace in production for unhandled errors", () => {
      process.env.NODE_ENV = "production";
      const error = new Error("Something went wrong");

      errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 500,
          message: "Internal server error",
        },
      });
    });

    it("should show error message in development for unhandled errors", () => {
      process.env.NODE_ENV = "development";
      const error = new Error("Database connection failed");

      errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 500,
          message: "Database connection failed",
        },
      });
    });

    it("should log unhandled errors with stack trace", () => {
      const error = new Error("Something went wrong");

      errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

      expect(logger.error).toHaveBeenCalled();
      const logCall = (logger.error as jest.Mock).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(logCall.message).toBe("Something went wrong");
      expect(logCall.stack).toBeDefined();
    });

    it("should handle non-Error thrown values", () => {
      const error = "string error";

      errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 500,
          message: "Internal server error",
        },
      });
    });

    it("should handle null or undefined thrown values", () => {
      errorMiddleware(null, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 500,
          message: "Internal server error",
        },
      });
    });
  });

  describe("Production safety", () => {
    it("should not leak sensitive information in production", () => {
      process.env.NODE_ENV = "production";
      const error = new Error("Database credentials are user:pass@db:5432");

      errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

      const response = (mockRes.json as jest.Mock).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      const errorObj = response.error as Record<string, unknown>;
      expect(errorObj.message).not.toContain("user:pass");
      expect(errorObj.message).toBe("Internal server error");
    });
  });
});
