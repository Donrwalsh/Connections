import { useState } from "react";
import type { Difficulty } from "../data/types";
import { buildShareText } from "../lib/shareResult";

interface ShareResultProps {
  guessHistory: Difficulty[][];
  puzzleDate: string;
}

export function ShareResult({ guessHistory, puzzleDate }: ShareResultProps) {
  const [copied, setCopied] = useState(false);
  const shareText = buildShareText(guessHistory, puzzleDate);

  async function handleCopy() {
    await navigator.clipboard.writeText(shareText);
    setCopied(true);
    // Local, transient UI feedback — a plain setTimeout without a
    // cleanup-guarded useEffect is fine here since it only touches this
    // component's own state and the component isn't expected to unmount
    // mid-copy in practice.
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="share-result">
      <pre className="share-grid">{shareText}</pre>
      <button type="button" onClick={handleCopy}>
        {copied ? "Copied!" : "Copy results"}
      </button>
    </div>
  );
}
