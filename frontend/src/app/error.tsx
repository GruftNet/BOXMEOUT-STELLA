'use client';

import { useEffect } from 'react';
import { logError } from '@/lib/error';

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps): JSX.Element {
  useEffect(() => {
    // Automatically report to Sentry and log to console
    logError(error, {
      digest: error.digest,
      boundary: 'AppErrorPage',
    });
  }, [error]);

  return (
    <main className="min-h-[70vh] flex flex-col items-center justify-center px-6 text-center w-full">
      {/* Ambient background glows for gorgeous premium looks */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[350px] h-[350px] bg-amber-500/5 rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute top-1/2 left-1/3 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[300px] bg-red-500/5 rounded-full blur-[100px] pointer-events-none" />

      <div className="relative max-w-lg w-full bg-zinc-950/80 border border-zinc-900 rounded-3xl p-10 backdrop-blur-2xl shadow-2xl shadow-zinc-950/50">
        <p className="text-6xl mb-6 select-none animate-bounce duration-1000">⚠️</p>
        
        <h1 className="text-3xl font-extrabold text-white tracking-tight mb-3">
          Something went wrong
        </h1>
        
        <p className="text-zinc-400 mb-8 max-w-md mx-auto text-sm leading-relaxed">
          An unexpected application error occurred. We have recorded this issue and our team has been notified.
        </p>

        {error.digest && (
          <div className="mb-8 font-mono text-[11px] px-4 py-2 border border-zinc-800/80 rounded-xl bg-zinc-900/30 text-zinc-500 inline-block">
            Error ID: {error.digest}
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <button
            onClick={reset}
            className="w-full sm:w-auto min-w-[140px] bg-amber-500 hover:bg-amber-400 text-black font-bold px-6 py-3 rounded-xl transition-all duration-200 shadow-lg shadow-amber-500/10 active:scale-[0.98] text-sm"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.href = '/'}
            className="w-full sm:w-auto min-w-[140px] border border-zinc-800 hover:border-zinc-700 bg-zinc-900/40 hover:bg-zinc-900/80 text-zinc-300 hover:text-white font-bold px-6 py-3 rounded-xl transition-all duration-200 active:scale-[0.98] text-sm"
          >
            Go Home
          </button>
        </div>
      </div>
    </main>
  );
}
