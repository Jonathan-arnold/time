/** Day of week, 0 = Sunday … 6 = Saturday (matches Date.getDay()). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/**
 * A category of time. Categories nest via `parentId`; a null parent is a
 * top-level category.
 */
export interface Category {
  id: string
  name: string
  parentId: string | null
  /** Hex color used in charts and the transaction grid. */
  color: string
  /** Sort order among siblings. */
  order: number
}

/**
 * A 30-minute slice of past time, identified by the timestamp of its start.
 * Block starts are always aligned to :00 and :30 of the hour.
 */
export interface Block {
  /** Epoch milliseconds of the block's start, aligned to a 30-minute boundary. */
  start: number
  categoryId: string
}

export type BudgetType = 'recurring' | 'oneoff'

/**
 * A budget allocates minutes-per-day across categories.
 *
 * - Recurring budgets apply on the weekdays listed in `weekdays`.
 * - One-off budgets apply on every day within [startDate, endDate] and always
 *   override recurring budgets on overlapping days.
 */
/** How a recurring budget repeats. */
export type Recurrence = 'weekly' | 'monthly'

export interface Budget {
  id: string
  name: string
  type: BudgetType
  /** Recurring only: how the schedule repeats. Null for one-off budgets. */
  recurrence: Recurrence | null
  /** Recurring + weekly: weekdays this budget applies to. */
  weekdays: Weekday[]
  /** Recurring + monthly: days-of-month (1–31) this budget applies to. */
  monthDays: number[]
  /** Minutes from midnight the coverage window starts (30-min aligned). */
  coverStart: number
  /** Minutes from midnight the coverage window ends (30-min aligned). */
  coverEnd: number
  /** Whether the schedule has been accepted, unlocking the assignment view. */
  scheduleAccepted: boolean
  /**
   * How allocations are entered and summarized in the assignment view.
   * - `daily`: numbers are minutes-per-day, applied to every day of the period.
   * - `period`: numbers are totals for the whole period.
   * Stored allocations are always canonical period totals; this only changes
   * how they are displayed and edited, so toggling never loses data.
   */
  allocationMode: 'daily' | 'period'
  /** One-off only: inclusive ISO date (yyyy-MM-dd) range. */
  startDate: string | null
  endDate: string | null
  /**
   * Tie-breaker when multiple budgets of the same type apply on a day.
   * Higher wins. One-offs always beat recurring regardless of priority.
   */
  priority: number
  createdAt: number
}

/**
 * Minutes allocated to one category within one budget, for the whole
 * budgeting period (a week, a calendar month, or the one-off's span).
 */
export interface BudgetAllocation {
  id: string
  budgetId: string
  categoryId: string
  minutes: number
}
