import type { Category } from '../db'

/** A category paired with its depth in the nesting tree (0 = top level). */
export interface IndentedCategory {
  category: Category
  depth: number
}

/**
 * Flatten the category tree into a depth-first ordered list, so it can be
 * rendered in a dropdown with indentation. Siblings are sorted by `order`.
 */
export function indentCategories(categories: Category[]): IndentedCategory[] {
  const byParent = new Map<string | null, Category[]>()
  for (const cat of categories) {
    const siblings = byParent.get(cat.parentId) ?? []
    siblings.push(cat)
    byParent.set(cat.parentId, siblings)
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.order - b.order)
  }

  const result: IndentedCategory[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const category of byParent.get(parentId) ?? []) {
      result.push({ category, depth })
      walk(category.id, depth + 1)
    }
  }
  walk(null, 0)
  return result
}

/**
 * All category ids in the subtree rooted at `rootId`, including the root.
 * Used to delete a category with its descendants and to prevent nesting
 * cycles when re-parenting.
 */
export function subtreeIds(
  categories: Category[],
  rootId: string,
): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const c of categories) {
    const kids = childrenOf.get(c.parentId ?? '') ?? []
    kids.push(c.id)
    childrenOf.set(c.parentId ?? '', kids)
  }
  const ids = new Set<string>()
  const walk = (id: string) => {
    ids.add(id)
    for (const child of childrenOf.get(id) ?? []) walk(child)
  }
  walk(rootId)
  return ids
}

/** Where a dragged category lands relative to the drop target. */
export type DropIntent = 'before' | 'after' | 'child'

/**
 * Produce a new category list with `dragId` moved relative to `targetId`.
 * `before`/`after` make it a sibling; `child` nests it under the target.
 * Returns null for no-op or invalid moves (e.g. into the node's own subtree).
 */
export function moveCategory(
  categories: Category[],
  dragId: string,
  targetId: string,
  intent: DropIntent,
): Category[] | null {
  if (dragId === targetId) return null
  const drag = categories.find((c) => c.id === dragId)
  const target = categories.find((c) => c.id === targetId)
  if (!drag || !target) return null
  if (subtreeIds(categories, dragId).has(targetId)) return null

  // Group children by parent, each ordered.
  const groups = new Map<string | null, Category[]>()
  for (const c of [...categories].sort((a, b) => a.order - b.order)) {
    const arr = groups.get(c.parentId) ?? []
    arr.push(c)
    groups.set(c.parentId, arr)
  }

  // Detach the dragged node from its current group.
  groups.set(
    drag.parentId,
    (groups.get(drag.parentId) ?? []).filter((c) => c.id !== dragId),
  )

  // Splice it into the destination group.
  const newParent = intent === 'child' ? target.id : target.parentId
  const dest = groups.get(newParent) ?? []
  const ti = dest.findIndex((c) => c.id === targetId)
  const index =
    intent === 'child' ? dest.length : intent === 'before' ? ti : ti + 1
  dest.splice(index, 0, drag)
  groups.set(newParent, dest)

  // Re-derive parentId + order for every category from the groups.
  const updated = new Map<string, Category>()
  for (const [parentId, arr] of groups) {
    arr.forEach((c, i) => updated.set(c.id, { ...c, parentId, order: i }))
  }
  return categories.map((c) => updated.get(c.id) ?? c)
}

/** Build an id → category lookup map. */
export function categoryMap(categories: Category[]): Map<string, Category> {
  return new Map(categories.map((c) => [c.id, c]))
}
