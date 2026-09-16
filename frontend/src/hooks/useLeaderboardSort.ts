import { useState } from "react";
import {
  defaultSortDir,
  type LeaderboardSortDir,
  type LeaderboardSortKey,
} from "../data/benchmark/metrics";

export interface LeaderboardSortState {
  sortBy: LeaderboardSortKey;
  sortDir: LeaderboardSortDir;
  onSortChange: (key: LeaderboardSortKey) => void;
}

/** Column-header sort state for one StrategyTable instance: clicking a new
 * column jumps straight to that column's "best first" direction, clicking
 * the already-active column again flips ascending/descending. Owned per
 * table instance (LeaderboardPage calls this once for the LLM table and
 * once for the Deterministic & Shuffle table) rather than shared, since the
 * two tables sort different columns. */
export function useLeaderboardSort(initialKey: LeaderboardSortKey): LeaderboardSortState {
  const [sortBy, setSortBy] = useState(initialKey);
  const [sortDir, setSortDir] = useState(defaultSortDir(initialKey));

  const onSortChange = (key: LeaderboardSortKey) => {
    if (key === sortBy) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(key);
      setSortDir(defaultSortDir(key));
    }
  };

  return { sortBy, sortDir, onSortChange };
}
