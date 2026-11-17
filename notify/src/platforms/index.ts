import type { Platform } from '../core.ts'
import { slack } from './slack.ts'
import { discord } from './discord.ts'

export const platforms: Platform[] = [slack, discord]
