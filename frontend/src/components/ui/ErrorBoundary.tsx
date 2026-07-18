'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logError, sanitizeString } from '@/lib/error';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
    };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log exception to console and report to Sentry (via logError helper)
    logError(error, {
      componentStack: info.componentStack,
      boundary: 'ErrorBoundaryComponent',
    });
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  public render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const errorMessage = this.state.error
        ? sanitizeString(this.state.error.message)
        : 'An unexpected component rendering error occurred.';

      return (
        <div className="flex items-center justify-center min-h-[400px] p-6 w-full">
          {/* Glassmorphism premium UI card */}
          <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-red-500/20 bg-zinc-950/80 p-8 text-center backdrop-blur-xl shadow-2xl shadow-red-950/20">
            {/* Ambient Background Glow */}
            <div className="absolute -left-16 -top-16 h-32 w-32 rounded-full bg-red-500/10 blur-3xl pointer-events-none" />
            <div className="absolute -right-16 -bottom-16 h-32 w-32 rounded-full bg-amber-500/10 blur-3xl pointer-events-none" />

            {/* Error Icon */}
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-red-950/50 border border-red-500/30 text-2xl animate-pulse">
              ⚠️
            </div>

            {/* Title */}
            <h2 className="mb-2 text-xl font-bold text-white tracking-tight">
              Component Error
            </h2>

            {/* Description */}
            <p className="mb-4 text-sm text-zinc-400 leading-relaxed">
              Something went wrong loading this part of the application. The error has been logged automatically.
            </p>

            {/* Code block with sanitized error message */}
            <div className="mb-6 rounded-lg bg-zinc-900/60 border border-zinc-800/80 p-3.5 text-left font-mono text-xs text-red-400 overflow-x-auto max-h-24 break-words">
              {errorMessage}
            </div>

            {/* Actions */}
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <button
                onClick={this.handleReset}
                className="flex-1 px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 font-semibold text-black text-sm transition-all duration-200 shadow-lg shadow-amber-500/10 active:scale-[0.98]"
              >
                Try again
              </button>
              <button
                onClick={() => {
                  this.setState({ hasError: false, error: null });
                  window.location.href = '/';
                }}
                className="flex-1 px-4 py-2.5 rounded-xl border border-zinc-800 hover:border-zinc-700 bg-zinc-900/40 hover:bg-zinc-900/80 font-semibold text-zinc-300 hover:text-white text-sm transition-all duration-200 active:scale-[0.98]"
              >
                Go Home
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
