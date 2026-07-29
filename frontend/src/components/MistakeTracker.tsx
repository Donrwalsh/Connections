interface MistakeTrackerProps {
  mistakes: number;
  maxMistakes: number;
}

export function MistakeTracker({ mistakes, maxMistakes }: MistakeTrackerProps) {
  return (
    <div
      className="mistake-tracker"
      role="status"
      aria-label={`${mistakes} of ${maxMistakes} mistakes made`}
    >
      {Array.from({ length: maxMistakes }, (_, i) => (
        <span
          key={i}
          className={`mistake-dot${i < mistakes ? " mistake-dot--used" : ""}`}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
