/** @type {import('next').NextConfig} */
const nextConfig = {};

const { withSentryConfig } = require('@sentry/nextjs');

module.exports = withSentryConfig(
  nextConfig,
  {
    // For all available options, see:
    // https://github.com/getsentry/sentry-webpack-plugin#options

    // Suppresses source map uploading logs during silencing builds
    silent: true,
    org: 'boxmeout',
    project: 'stella-frontend',
  },
  {
    // For all available options, see:
    // https://docs.sentry.io/prerequisites/link-event-to-feedback/

    // Hides source maps from public. This is important to protect intellectual property
    // and prevent users from seeing raw source code.
    hideSourceMaps: true,

    // Automatically tree-shake Sentry logger statements to reduce bundle size
    disableLogger: true,
  }
);
