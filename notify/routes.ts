import type { Routes } from './src/route.ts'

// Paste channel IDs: Discord → Developer Mode → right-click a channel → Copy Channel ID.
// Slack targets still work (`slack: '#name'`) if SLACK_BOT_TOKEN is set.
export default {
  default: { discord: 'HAWK_CHANNEL_ID' },
  routes: {
    'hawk.*': { discord: 'HAWK_CHANNEL_ID' },
    'sparrow.task.status': { discord: 'SPARROW_CHANNEL_ID' },
    'budgie.daily': { discord: 'BUDGIE_CHANNEL_ID' },
  },
} satisfies Routes
