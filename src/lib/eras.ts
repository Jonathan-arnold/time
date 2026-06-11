import type { Category, Era } from '../db'

/** Eras ordered by start date, earliest first. */
export function sortEras(eras: Era[]): Era[] {
  return [...eras].sort((a, b) => a.startDate.localeCompare(b.startDate))
}

/**
 * The era we're living in now: the one with no end date, falling back to
 * the latest by start date if every era has somehow been closed.
 */
export function currentEra(eras: Era[]): Era | null {
  const open = eras.find((e) => e.endDate === null)
  if (open) return open
  const sorted = sortEras(eras)
  return sorted[sorted.length - 1] ?? null
}

/**
 * The era covering a given local day. Days before the first era began fall
 * back to the earliest era, so history that predates era-keeping is still
 * viewable somewhere.
 */
export function eraForDate(eras: Era[], iso: string): Era | null {
  const sorted = sortEras(eras)
  for (const era of sorted) {
    if (iso >= era.startDate && (era.endDate === null || iso <= era.endDate))
      return era
  }
  return sorted[0] ?? null
}

/**
 * Copies of a category tree for a new era. Every category gets a fresh id
 * (with `parentId` remapped to keep the nesting), so edits in the new era
 * never touch the old era's records — past metrics stay as they were.
 */
export function copyCategoriesForEra(
  categories: Category[],
  eraId: string,
): Category[] {
  const idMap = new Map(categories.map((c) => [c.id, crypto.randomUUID()]))
  return categories.map((c) => ({
    id: idMap.get(c.id)!,
    name: c.name,
    parentId: c.parentId ? (idMap.get(c.parentId) ?? null) : null,
    color: c.color,
    order: c.order,
    eraId,
  }))
}
