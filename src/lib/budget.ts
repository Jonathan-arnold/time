import {
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  startOfMonth,
  startOfWeek,
} from 'date-fns'
import type { Budget } from '../db'
import { isoDate, parseIsoDate } from './time'

/**
 * Whether a budget's schedule covers the given local day.
 * Unaccepted budgets never apply.
 */
export function budgetCoversDate(budget: Budget, iso: string): boolean {
  if (!budget.scheduleAccepted) return false
  const date = parseIsoDate(iso)
  if (budget.type === 'oneoff') {
    return (
      budget.startDate != null &&
      budget.endDate != null &&
      iso >= budget.startDate &&
      iso <= budget.endDate
    )
  }
  // Recurring.
  if (budget.recurrence === 'monthly') {
    return budget.monthDays.includes(date.getDate())
  }
  return budget.weekdays.includes(date.getDay() as Budget['weekdays'][number])
}

/**
 * The budget that applies on a given day, or null if none does.
 * One-off budgets always beat recurring ones; within a type, higher
 * `priority` wins, then the more recently created budget.
 */
export function resolveBudget(
  budgets: Budget[],
  iso: string,
): Budget | null {
  const matches = budgets.filter((b) => budgetCoversDate(b, iso))
  if (matches.length === 0) return null
  return matches.reduce((best, b) => {
    const rank = (x: Budget) => (x.type === 'oneoff' ? 1 : 0)
    if (rank(b) !== rank(best)) return rank(b) > rank(best) ? b : best
    if (b.priority !== best.priority)
      return b.priority > best.priority ? b : best
    return b.createdAt > best.createdAt ? b : best
  })
}

/**
 * The inclusive ISO date range of the budgeting period that `iso` falls in.
 * Allocations are minutes-per-period, so this defines the window over which
 * spent time is tallied — a week, a calendar month, or the one-off's span.
 */
export function budgetPeriod(
  budget: Budget,
  iso: string,
): { startIso: string; endIso: string } {
  if (budget.type === 'oneoff') {
    return {
      startIso: budget.startDate ?? iso,
      endIso: budget.endDate ?? iso,
    }
  }
  const date = parseIsoDate(iso)
  if (budget.recurrence === 'monthly') {
    return {
      startIso: isoDate(startOfMonth(date)),
      endIso: isoDate(endOfMonth(date)),
    }
  }
  return {
    startIso: isoDate(startOfWeek(date)),
    endIso: isoDate(endOfWeek(date)),
  }
}

/**
 * Days within the budget's current period that this budget actually governs
 * — i.e. days where it is the resolved budget, so time on them counts
 * against its allocations (a weekday budget ignores the weekend, etc.).
 */
export function periodCoveredDays(
  budgets: Budget[],
  budget: Budget,
  iso: string,
): Set<string> {
  const { startIso, endIso } = budgetPeriod(budget, iso)
  const days = new Set<string>()
  for (const date of eachDayOfInterval({
    start: parseIsoDate(startIso),
    end: parseIsoDate(endIso),
  })) {
    const day = isoDate(date)
    if (resolveBudget(budgets, day)?.id === budget.id) days.add(day)
  }
  return days
}

/**
 * Days within the budget's current period that match this budget's own
 * schedule, ignoring any higher-priority budgets that might override it.
 * This is the denominator for "minutes per scheduled day" — overrides shrink
 * `periodCoveredDays`, but the per-day allocation rate stays the same.
 */
export function periodScheduledDays(
  budget: Budget,
  iso: string,
): Set<string> {
  const { startIso, endIso } = budgetPeriod(budget, iso)
  const days = new Set<string>()
  for (const date of eachDayOfInterval({
    start: parseIsoDate(startIso),
    end: parseIsoDate(endIso),
  })) {
    const day = isoDate(date)
    if (budgetCoversDate(budget, day)) days.add(day)
  }
  return days
}
