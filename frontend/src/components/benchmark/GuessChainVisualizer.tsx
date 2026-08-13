export interface GuessChainVisualizerProps {
  runId: number;
}

/** Stub for the run's guess-chain visualization. The real rendering (guess
 * sequence, per-guess detail, LLM panels) lands in a later pass; for now it
 * just surfaces which run is being viewed so the routing hierarchy around it
 * is wired and navigable. */
export function GuessChainVisualizer({ runId }: GuessChainVisualizerProps) {
  return (
    <section className="bench-visualizer" aria-label={`Guess chain for run ${runId}`}>
      <h2 className="bench-visualizer__title">Guess chain</h2>
      <p className="bench-visualizer__body">
        Placeholder — run <span className="bench-mono">#{runId}</span> will be
        visualized here once the guess-chain renderer lands.
      </p>
    </section>
  );
}
