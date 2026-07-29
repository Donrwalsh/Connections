import { motion } from "framer-motion";

interface TileProps {
  word: string;
  isSelected: boolean;
  isConfirmed: boolean;
  shouldShake: boolean;
  onToggle: (word: string) => void;
}

export function Tile({
  word,
  isSelected,
  isConfirmed,
  shouldShake,
  onToggle,
}: TileProps) {
  const className = [
    "tile",
    isSelected && "tile--selected",
    isConfirmed && "tile--confirmed",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <motion.button
      layout
      layoutId={word}
      className={className}
      type="button"
      onClick={() => onToggle(word)}
      aria-pressed={isSelected}
      // Disabled during the confirm window so a player can't toggle a
      // tile that's about to leave the board.
      disabled={isConfirmed}
      transition={{ layout: { duration: 0.3, ease: "easeInOut" } }}
      exit={{ opacity: 0, scale: 0.7 }}
      animate={
        shouldShake
          ? { x: [0, -8, 8, -8, 8, 0] }
          : isConfirmed
            ? { scale: [1, 1.05, 1] }
            : { x: 0 }
      }
    >
      {word}
    </motion.button>
  );
}
