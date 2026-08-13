export interface StatusStripProps {
  running: number;
  queued: number;
}

/** Minimal status strip stub: a one-line summary of in-flight work. */
export function StatusStrip({ running, queued }: StatusStripProps) {
  return (
    <div className="bench-status-strip" role="status">
      <span className="bench-pill bench-pill--active">{running} running</span>
      <span className="bench-pill bench-pill--queued">{queued} queued</span>
    </div>
  );
}
