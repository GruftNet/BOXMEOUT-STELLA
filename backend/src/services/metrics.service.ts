import { Counter, Gauge, register } from 'prom-client';

register.setDefaultLabels({ app: 'boxmeout' });

export const cronSessionsDeleted = new Counter({
  name: 'cron_sessions_deleted_total',
  help: 'Total expired user_sessions rows deleted by cleanup cron',
});

export const cronResetTokensDeleted = new Counter({
  name: 'cron_reset_tokens_deleted_total',
  help: 'Total expired password_reset_tokens rows deleted by cleanup cron',
});

export const cronNotificationsSoftDeleted = new Counter({
  name: 'cron_notifications_soft_deleted_total',
  help: 'Total notification_jobs rows soft-deleted by cleanup cron',
});

export const cronDistributionsArchived = new Counter({
  name: 'cron_distributions_archived_total',
  help: 'Total failed distributions rows archived by cleanup cron',
});

export const wsConnectedClients = new Gauge({
  name: 'ws_connected_clients',
  help: 'Number of currently connected WebSocket clients',
});

export const wsMessagesPublishedTotal = new Counter({
  name: 'ws_messages_published_total',
  help: 'Total WebSocket activity events published to Redis',
});

export const wsMessagesDroppedTotal = new Counter({
  name: 'ws_messages_dropped_total',
  help: 'Total WebSocket messages dropped due to client backpressure',
});

export { register };
