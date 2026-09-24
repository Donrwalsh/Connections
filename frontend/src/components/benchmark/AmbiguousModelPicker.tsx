import { Link } from "react-router-dom";
import { ProviderPill } from "./ProviderPill";
import type { SupportedModelRecord } from "../../data/benchmark/types";

export interface AmbiguousModelPickerProps {
  modelName: string;
  candidates: SupportedModelRecord[];
}

/** Shown when a /leaderboard/:strategyId link names a model more than one
 * provider currently supports (see useStrategyMeta's isAmbiguous) and no
 * ?strategy= qualifier picked one — e.g. an old bookmark from before a
 * second provider started serving this model name. Each option carries the
 * same modelName forward with the qualifier added, reusing the leaderboard
 * table's own ProviderPill labels (see StrategyTable) so the choice reads
 * the same way the ambiguity was created. */
export function AmbiguousModelPicker({ modelName, candidates }: AmbiguousModelPickerProps) {
  return (
    <div className="bench-page">
      <p className="bench-muted">"{modelName}" is served by more than one provider. Pick one:</p>
      <div className="bench-badges">
        {candidates.map((candidate) => (
          <Link
            key={candidate.strategyName}
            to={`/leaderboard/${encodeURIComponent(modelName)}?strategy=${encodeURIComponent(candidate.strategyName)}`}
          >
            <ProviderPill strategyName={candidate.strategyName} />
          </Link>
        ))}
      </div>
      <Link to="/leaderboard" className="bench-page-header__back">
        ← Back to leaderboard
      </Link>
    </div>
  );
}
