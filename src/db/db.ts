import Dexie, { type EntityTable } from 'dexie'
import type { Block, Budget, BudgetAllocation, Category } from './types'

/**
 * The single IndexedDB database backing the app. All data lives in the
 * browser; there is no server.
 */
export class TimeBudgetDB extends Dexie {
  blocks!: EntityTable<Block, 'start'>
  categories!: EntityTable<Category, 'id'>
  budgets!: EntityTable<Budget, 'id'>
  budgetAllocations!: EntityTable<BudgetAllocation, 'id'>

  constructor() {
    super('time-budget')
    const stores = {
      // `start` is the primary key — one block per 30-minute boundary.
      blocks: 'start, categoryId',
      categories: 'id, parentId, order',
      budgets: 'id, type, priority',
      // Compound index supports "allocations for a budget" lookups.
      budgetAllocations: 'id, budgetId, categoryId, [budgetId+categoryId]',
    }
    this.version(1).stores(stores)
    // v2 adds recurrence/coverage fields to budgets — backfill existing rows.
    this.version(2)
      .stores(stores)
      .upgrade((tx) =>
        tx
          .table('budgets')
          .toCollection()
          .modify((b: Budget) => {
            b.recurrence ??= b.type === 'recurring' ? 'weekly' : null
            b.monthDays ??= []
            b.coverStart ??= 0
            b.coverEnd ??= 24 * 60
          }),
      )
    // v3 adds scheduleAccepted — existing budgets are treated as accepted.
    this.version(3)
      .stores(stores)
      .upgrade((tx) =>
        tx
          .table('budgets')
          .toCollection()
          .modify((b: Budget) => {
            b.scheduleAccepted ??= true
          }),
      )
    // v4 adds allocationMode — existing budgets default to period totals.
    this.version(4)
      .stores(stores)
      .upgrade((tx) =>
        tx
          .table('budgets')
          .toCollection()
          .modify((b: Budget) => {
            b.allocationMode ??= 'period'
          }),
      )
  }
}

export const db = new TimeBudgetDB()
