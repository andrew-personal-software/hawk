import type { Routes } from './src/route.ts'

// Paste channel IDs: Discord → Developer Mode → right-click a channel → Copy Channel ID.
// Slack targets still work (`slack: '#name'`) if SLACK_BOT_TOKEN is set.
export default {
  default: { discord: '1572365798125740062' },
  routes: {
    'hawk.*': { discord: '1572365798125740062' },
    'sparrow.task.status': { discord: '1572365838026150099' },
    'budgie.daily': { discord: '1572365715011538994' },
  },
} satisfies Routes
