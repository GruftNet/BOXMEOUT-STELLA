import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ErrorBoundary } from '../ErrorBoundary';
import { logError } from '@/lib/error';

// Mock logError function
jest.mock('@/lib/error', () => {
  const actual = jest.requireActual('@/lib/error');
  return {
    ...actual,
    logError: jest.fn(),
    sanitizeString: jest.fn((str) => str),
  };
});

const BuggyComponent = (): JSX.Element => {
  throw new Error('Test rendering crash');
};

describe('ErrorBoundary Component', () => {
  const originalConsoleError = console.error;
  const originalLocation = window.location;

  beforeAll(() => {
    // Suppress console.error in tests to avoid messy logs during expected rendering crashes
    console.error = jest.fn();
    
    // Mock window.location.reload
    Object.defineProperty(window, 'location', {
      value: {
        reload: jest.fn(),
        href: '',
      },
      writable: true,
    });
  });

  afterAll(() => {
    console.error = originalConsoleError;
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <div>All Good</div>
      </ErrorBoundary>
    );

    expect(screen.getByText('All Good')).toBeInTheDocument();
  });

  it('catches errors and logs them to our Sentry logError handler', () => {
    render(
      <ErrorBoundary>
        <BuggyComponent />
      </ErrorBoundary>
    );

    // Verify it caught the error and logged it
    expect(logError).toHaveBeenCalledTimes(1);
    const calledErr = (logError as jest.Mock).mock.calls[0][0];
    expect(calledErr.message).toBe('Test rendering crash');
    
    // Verify fallback UI is rendered
    expect(screen.getByText('Component Error')).toBeInTheDocument();
    expect(screen.getByText('Test rendering crash')).toBeInTheDocument();
  });

  it('uses custom fallback if provided', () => {
    render(
      <ErrorBoundary fallback={<div>Custom fallback message</div>}>
        <BuggyComponent />
      </ErrorBoundary>
    );

    expect(screen.getByText('Custom fallback message')).toBeInTheDocument();
    expect(screen.queryByText('Component Error')).not.toBeInTheDocument();
  });

  it('triggers reload when "Try again" is clicked', () => {
    render(
      <ErrorBoundary>
        <BuggyComponent />
      </ErrorBoundary>
    );

    const tryAgainBtn = screen.getByText('Try again');
    fireEvent.click(tryAgainBtn);

    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it('navigates home when "Go Home" is clicked', () => {
    render(
      <ErrorBoundary>
        <BuggyComponent />
      </ErrorBoundary>
    );

    const goHomeBtn = screen.getByText('Go Home');
    fireEvent.click(goHomeBtn);

    expect(window.location.href).toBe('/');
  });
});
