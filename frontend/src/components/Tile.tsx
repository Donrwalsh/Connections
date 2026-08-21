import { memo, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

interface TileProps {
  word: string;
  imageUrl?: string;
  isSelected: boolean;
  isConfirmed: boolean;
  shouldShake: boolean;
  onToggle: (word: string) => void;
}

// Fallbacks in case computed styles aren't available (jsdom).
const BASE_FONT_FALLBACK = 15;
const MIN_FONT_SIZE = 8;
// Minimum gap left between the fitted text and the tile's left/right edges,
// so words never sit flush against the sides of the cell.
const H_PAD = 12;

function TileBase({
  word,
  imageUrl,
  isSelected,
  isConfirmed,
  shouldShake,
  onToggle,
}: TileProps) {
  const tileRef = useRef<HTMLButtonElement>(null);
  // Some image dates' asset URLs go stale — fall back to the word's plain
  // text rather than leaving a blank tile when the image fails to load.
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(imageUrl) && !imageFailed;

  // Fit the text to the cell. Phrases may wrap onto multiple lines at spaces
  // ("Baseball Glove" → two lines); the font only shrinks when a single
  // unbreakable word or the wrapped block would overflow the tile. Keeping the
  // text within the fixed-size cell means a long word can't widen its grid
  // column and knock the board off-center. Skipped entirely for image tiles,
  // which have no text to fit.
  useLayoutEffect(() => {
    if (showImage) return;

    const tile = tileRef.current;
    if (!tile) return;

    const fit = () => {
      tile.style.fontSize = "";
      const base = parseFloat(getComputedStyle(tile).fontSize) || BASE_FONT_FALLBACK;
      const available = tile.clientWidth - 2 * H_PAD;
      if (available <= 0) return;
      const availableHeight = tile.clientHeight;

      const textWidth = tile.scrollWidth;
      const textHeight = tile.scrollHeight;
      if (textWidth <= available && textHeight <= availableHeight) return;

      const scale = Math.min(
        textWidth > available ? available / textWidth : 1,
        textHeight > availableHeight ? availableHeight / textHeight : 1,
      );
      const fitted = Math.max(MIN_FONT_SIZE, base * scale);
      tile.style.fontSize = `${fitted}px`;
    };

    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(tile);
    return () => observer.disconnect();
  }, [word, showImage]);

  const className = [
    "tile",
    isSelected && "tile--selected",
    isConfirmed && "tile--confirmed",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <motion.button
      ref={tileRef}
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
      {showImage ? (
        <img
          src={imageUrl}
          alt={word}
          className="tile__image"
          onError={() => setImageFailed(true)}
        />
      ) : (
        word
      )}
    </motion.button>
  );
}

// With a stable onToggle (from useConnectionsGame) and memoized Tile, toggling
// a word only re-renders the affected tile instead of all 16 on every
// selection change.
export const Tile = memo(TileBase);
