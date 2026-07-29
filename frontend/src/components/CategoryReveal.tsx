import { AnimatePresence, motion } from "framer-motion";
import type { Category } from "../data/samplePuzzle";

interface CategoryRevealProps {
  solved: Category[];
}

export function CategoryReveal({ solved }: CategoryRevealProps) {
  return (
    <div className="solved-list">
      {/* AnimatePresence lets exiting items animate out — not used for
          exits here, but needed for enter animations to run correctly
          on items appearing mid-list rather than only on mount. */}
      <AnimatePresence initial={false}>
        {solved.map((cat) => (
          <motion.div
            key={cat.id}
            layout
            initial={{ opacity: 0, scale: 0.85, y: -12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            className={`solved-row solved-row--${cat.difficulty}`}
          >
            <strong>{cat.name}</strong>: {cat.words.join(", ")}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
