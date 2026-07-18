import * as Sentry from '@sentry/nextjs';
import { logError, AppError, ErrorCategory, sanitizeString, sanitizeObject } from '../../../lib/error';

// Mock Sentry NextJS SDK
jest.mock('@sentry/nextjs', () => {
  const actual = jest.requireActual('@sentry/nextjs');
  return {
    ...actual,
    init: jest.fn(),
    captureException: jest.fn(),
    withScope: jest.fn((callback) => {
      const scope = {
        setTags: jest.fn(),
        setExtra: jest.fn(),
      };
      callback(scope);
      return scope;
    }),
  };
});

describe('Error Library Utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('sanitizeString', () => {
    it('should redact Stellar secret keys starting with S', () => {
      const secret = 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      expect(secret.length).toBe(56);
      const text = `Connect with key ${secret} to sign transactions`;
      const sanitized = sanitizeString(text);
      expect(sanitized).toBe('Connect with key [REDACTED_STELLAR_SECRET] to sign transactions');
    });

    it('should redact 64-character hex keys', () => {
      const hexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const text = `Private key: ${hexKey}`;
      const sanitized = sanitizeString(text);
      expect(sanitized).toBe('Private key: [REDACTED_HEX_KEY]');
    });

    it('should redact email addresses', () => {
      const email = 'user@example.com';
      const text = `Contact user at ${email}`;
      const sanitized = sanitizeString(text);
      expect(sanitized).toBe('Contact user at [REDACTED_EMAIL]');
    });

    it('should redact JWT tokens', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const text = `Token: ${jwt}`;
      const sanitized = sanitizeString(text);
      expect(sanitized).toBe('Token: [REDACTED_JWT]');
    });
  });

  describe('sanitizeObject', () => {
    it('should recursively sanitize nested string fields', () => {
      const input = {
        message: 'email is test@test.com',
        user: {
          secret: 'SBCDEFGHIJKLMNOPQRSTUVWXYZ234567abcdefghijklmnopqr', // 50 chars - not matched by Stellar secret key, but secret key is redacted because of field name
          realSecret: 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // 56 chars
        },
      };

      const sanitized = sanitizeObject(input);
      expect(sanitized.message).toBe('email is [REDACTED_EMAIL]');
      expect(sanitized.user.secret).toBe('[REDACTED_SENSITIVE_FIELD]');
      expect(sanitized.user.realSecret).toBe('[REDACTED_SENSITIVE_FIELD]');
    });

    it('should redact values of keys matching sensitive words', () => {
      const input = {
        password: 'myPassword123',
        auth_token: 'secretValue',
        seed: 'my seed phrase',
        authorization: 'Bearer token',
        mnemonic: 'word word word',
        privateKey: '0x123',
      };

      const sanitized = sanitizeObject(input);
      expect(sanitized.password).toBe('[REDACTED_SENSITIVE_FIELD]');
      expect(sanitized.auth_token).toBe('[REDACTED_SENSITIVE_FIELD]');
      expect(sanitized.seed).toBe('[REDACTED_SENSITIVE_FIELD]');
      expect(sanitized.authorization).toBe('[REDACTED_SENSITIVE_FIELD]');
      expect(sanitized.mnemonic).toBe('[REDACTED_SENSITIVE_FIELD]');
      expect(sanitized.privateKey).toBe('[REDACTED_SENSITIVE_FIELD]');
    });

    it('should handle Error objects serialization safely', () => {
      const error = new Error('Secret key: SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      const sanitized = sanitizeObject(error);

      expect(sanitized.name).toBe('Error');
      expect(sanitized.message).toBe('Secret key: [REDACTED_STELLAR_SECRET]');
      expect(sanitized.stack).toContain('[REDACTED_STELLAR_SECRET]');
    });
  });

  describe('AppError', () => {
    it('should initialize with correct properties', () => {
      const err = new AppError('Low balance', ErrorCategory.USER, 'Please add funds', { balance: 0 });
      expect(err.message).toBe('Low balance');
      expect(err.category).toBe(ErrorCategory.USER);
      expect(err.userFriendlyMessage).toBe('Please add funds');
      expect(err.details).toEqual({ balance: 0 });
      expect(err instanceof Error).toBe(true);
      expect(err instanceof AppError).toBe(true);
    });
  });

  describe('logError', () => {
    it('should log AppError with correct category tags and extras to Sentry', () => {
      const mockSetTags = jest.fn();
      const mockSetExtra = jest.fn();
      
      (Sentry.withScope as jest.Mock).mockImplementationOnce((callback) => {
        const scope = {
          setTags: mockSetTags,
          setExtra: mockSetExtra,
        };
        callback(scope);
        return scope;
      });

      const userError = new AppError('Connection timeout', ErrorCategory.NETWORK, 'Network too slow', { host: 'stellar.org' });
      logError(userError, { trigger: 'wallet_connect' });

      // Verify that Sentry.captureException was called with a sanitized error
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      const reportedErr = (Sentry.captureException as jest.Mock).mock.calls[0][0];
      expect(reportedErr.message).toBe('Connection timeout');

      // Verify tags set on scope
      expect(mockSetTags).toHaveBeenCalledWith({
        error_category: 'network',
        error_type: 'system_bug', // since network is not ErrorCategory.USER
      });

      // Verify context and details set as extras
      expect(mockSetExtra).toHaveBeenCalledWith('context', { trigger: 'wallet_connect' });
      expect(mockSetExtra).toHaveBeenCalledWith('details', { host: 'stellar.org' });
    });
  });
});
