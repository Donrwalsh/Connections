import { AnimatePresence } from "framer-motion";
import { Tile } from "./Tile";

interface BoardProps {
  words: string[];
  selected: string[];
  shakeWords: string[];
  confirmedWords: string[];
  onToggle: (word: string) => void;
}

export function Board({
  words,
  selected,
  shakeWords,
  confirmedWords,
  onToggle,
}: BoardProps) {
  return (
    <div className="board">
      <AnimatePresence>
        {words.map((word) => (
          <Tile
            key={word}
            word={word}
            isSelected={selected.includes(word)}
            isConfirmed={confirmedWords.includes(word)}
            shouldShake={shakeWords.includes(word)}
            onToggle={onToggle}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
