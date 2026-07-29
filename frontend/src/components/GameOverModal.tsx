import { motion } from "framer-motion";
import type { Category, Difficulty } from "../data/samplePuzzle";
import { ShareResult } from "./ShareResult";

interface GameOverModalProps {
  status: "won" | "lost";
  categories: Category[];
  guessHistory: Difficulty[][];
  puzzleDate: string;
  onClose: () => void;
}

export function GameOverModal({
  status,
  categories,
  guessHistory,
  puzzleDate,
  onClose,
}: GameOverModalProps) {
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <motion.div
        className="modal"
        initial={{ opacity: 0, scale: 0.9, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.25, ease: "easeOut" }}
      >
        <h2 id="modal-title">
          {status === "won" ? "Solved it!" : "Next time!"}
        </h2>

        {status === "lost" && (
          <div className="modal-answers">
            {categories.map((cat) => (
              <div
                key={cat.id}
                className={`solved-row solved-row--${cat.difficulty}`}
              >
                <strong>{cat.name}</strong>: {cat.words.join(", ")}
              </div>
            ))}
          </div>
        )}

        <ShareResult guessHistory={guessHistory} puzzleDate={puzzleDate} />

        <button type="button" className="modal-close" onClick={onClose}>
          Close
        </button>
      </motion.div>
    </div>
  );
}
