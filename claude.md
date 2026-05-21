# Time Budget App

A personal web app for tracking and budgeting time, modeled on YNAB's feel but adapted for the fact that time can't be saved, earned, or rebalanced.

## Core Concept

Three tabs: Transactions, Budgets, Metrics. The day is divided into 30-minute blocks. Past blocks are categorized; future time is allocated via budgets. Intention and reality are tracked as separate data — the gap between them is the point, not something to reconcile.

## Transactions Tab

A grid of 30-minute blocks for past time, each with a selection bubble. Categorize a single block by selecting it and choosing from a dropdown. Categorize a range by selecting the first block and shift-selecting the last. A "split block" option exists for mixed periods, but the philosophy is to not sweat the small stuff — if a block was fragmented across many things, pick the dominant one or mark it miscellaneous.

No typing, no descriptions. Categorization is a 3-second action regardless of how much time it covers.

## Budgets Tab

Create multiple budgets, each allocating minutes-per-period across categories:

- **Recurring budgets** with day-of-week schedules (e.g., a 5-day weekday budget, a 2-day weekend budget).
- **One-off budgets** with date ranges (e.g., a 7-day vacation). One-offs always override recurring budgets on overlapping days.

Sleep is a real category and gets budgeted like anything else.

Categories are hierarchical/can be nested.

**Auto-balance** is the key feature: when creating a budget, the app initializes allocations from the median time spent per category over a recent lookback window. The starting budget is, by definition, achievable because it reflects what you already do. Adjustments are made as small nudges over time (e.g., reading from 10 → 15 → 60 minutes per day), with the budget acting as a reference point rather than a constraint.

## Metrics Tab

Two views:

- **Trend vs. target** (primary): small multiples of line charts, one per category, showing actual time as a trailing 7-day average against the budget line. This is the view that reveals whether nudges are working.
- **Pie chart** (secondary): time allocation across categories, with filters by date range and budget.

## Technical Approach

Lightweight web app: Vite + React + TypeScript, Dexie for IndexedDB storage, Tailwind for styling, Recharts for charts, date-fns for date math. No backend, no auth, no server — all data lives in the browser. JSON export for backup; static hosting if accessed from multiple machines.

**Data model:** `blocks` (timestamp + categoryId), `categories` (with nesting), `budgets` (type, schedule, priority), `budgetAllocations` (per-budget, per-category minutes). The budget-resolution function — "which budget applies on a given date, and what are its allocations?" — is the only real logic; the rest is CRUD plus charts.