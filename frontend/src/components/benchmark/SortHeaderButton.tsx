export interface SortHeaderButtonProps {
  label: string;
  isActive: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}

/** The clickable label a sortable column header renders — shared by
 * RunHistoryTable's native <th> and StrategyTable's ARIA-grid
 * role="columnheader" div, so both tables' header-click sorting looks and
 * behaves identically: an inline arrow on the active column, plus a
 * directional aria-label for screen readers. */
export function SortHeaderButton({ label, isActive, dir, onClick }: SortHeaderButtonProps) {
  return (
    <button
      type="button"
      className="bench-sort-btn"
      onClick={onClick}
      aria-label={`Sort by ${label}${isActive ? `, ${dir === "asc" ? "ascending" : "descending"}` : ""}`}
    >
      {label}
      {isActive ? (dir === "asc" ? " ↑" : " ↓") : ""}
    </button>
  );
}
