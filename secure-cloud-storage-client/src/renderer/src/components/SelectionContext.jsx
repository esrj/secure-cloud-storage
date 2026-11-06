/**
 * Multi-selection context for batch operations on the file list.
 *
 * Provides a Set-based selection model and lookup map so that
 * - the table cells can render their own checkbox based on `isSelected(id)`,
 * - the sticky BatchActionBar can read selected items WITHOUT re-traversing
 *   the (potentially filtered) table, by going through `selectedItems`.
 *
 * `items` is the *currently visible* row set the table is about to render
 * (already filtered by SearchContext), and is registered every render via
 * `setItems`. We use it for "select all visible" and to back `selectedItems`.
 */
import { createContext, useCallback, useMemo, useRef, useState } from 'react'
import PropTypes from 'prop-types'

export const SelectionContext = createContext({
  selectedIds: new Set(),
  isSelected: () => false,
  toggle: () => {},
  selectAllVisible: () => {},
  clear: () => {},
  registerItems: () => {},
  selectedItems: [],
  visibleCount: 0,
  selectedSize: 0
})

export function SelectionProvider({ children }) {
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  // We don't put the visible items in state — they change on every render of
  // the underlying table and would cause feedback loops. Just stash them on a
  // ref; the few consumers that need them (BatchActionBar) read on demand.
  const itemsRef = useRef([])
  const [visibleCount, setVisibleCount] = useState(0)

  const isSelected = useCallback((id) => selectedIds.has(id), [selectedIds])

  const toggle = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectAllVisible = useCallback(() => {
    setSelectedIds((prev) => {
      const ids = itemsRef.current.map((it) => it.fileId)
      const allChecked = ids.length > 0 && ids.every((id) => prev.has(id))
      if (allChecked) {
        const next = new Set(prev)
        ids.forEach((id) => next.delete(id))
        return next
      }
      const next = new Set(prev)
      ids.forEach((id) => next.add(id))
      return next
    })
  }, [])

  const clear = useCallback(() => setSelectedIds(new Set()), [])

  const registerItems = useCallback((items) => {
    itemsRef.current = items
    setVisibleCount(items.length)
  }, [])

  const selectedItems = useMemo(() => {
    return itemsRef.current.filter((it) => selectedIds.has(it.fileId))
    // itemsRef intentionally excluded — Set identity changes on every toggle,
    // which is sufficient to recompute. visibleCount also retriggers when the
    // underlying table swaps its visible rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, visibleCount])

  const selectedSize = useMemo(
    () => selectedItems.reduce((acc, it) => acc + (parseInt(it.size, 10) || 0), 0),
    [selectedItems]
  )

  const value = useMemo(
    () => ({
      selectedIds,
      isSelected,
      toggle,
      selectAllVisible,
      clear,
      registerItems,
      selectedItems,
      visibleCount,
      selectedSize
    }),
    [
      selectedIds,
      isSelected,
      toggle,
      selectAllVisible,
      clear,
      registerItems,
      selectedItems,
      visibleCount,
      selectedSize
    ]
  )

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>
}

SelectionProvider.propTypes = {
  children: PropTypes.node
}
