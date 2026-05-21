import { db } from './db'
import type { Category } from './types'

/**
 * Default categories created the first time the app runs. Sleep is a real
 * category and gets budgeted like anything else.
 */
const DEFAULT_CATEGORIES: Category[] = [
  { id: 'sleep', name: 'Sleep', parentId: null, color: '#6366f1', order: 0 },
  { id: 'work', name: 'Work', parentId: null, color: '#0ea5e9', order: 1 },
  { id: 'meals', name: 'Meals', parentId: null, color: '#f59e0b', order: 2 },
  { id: 'exercise', name: 'Exercise', parentId: null, color: '#10b981', order: 3 },
  { id: 'reading', name: 'Reading', parentId: null, color: '#8b5cf6', order: 4 },
  { id: 'leisure', name: 'Leisure', parentId: null, color: '#ec4899', order: 5 },
  { id: 'chores', name: 'Chores', parentId: null, color: '#78716c', order: 6 },
  { id: 'misc', name: 'Miscellaneous', parentId: null, color: '#94a3b8', order: 7 },
]

/**
 * Populate first-run defaults. Idempotent — safe to call on every startup.
 */
export async function ensureSeeded(): Promise<void> {
  const count = await db.categories.count()
  if (count === 0) {
    await db.categories.bulkAdd(DEFAULT_CATEGORIES)
  }
}
