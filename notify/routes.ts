import type { Routes } from './src/route.ts'

export default {
  default: { slack: '#hawk' },
  routes: {
    'hawk.*': { slack: '#hawk' },
    'sparrow.task.status': { slack: '#sparrow' },
    'budgie.daily': { slack: '#budgie' },
    // 'example.*': { slack: '#x', discord: '123456789' },
  },
} satisfies Routes
