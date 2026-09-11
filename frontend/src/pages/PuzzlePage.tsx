import { useState } from "react";
import { useParams } from "react-router-dom";
import { Game } from "../components/Game";
import { GuessSequencePanel } from "../components/GuessSequencePanel";
import { type Puzzle } from "../data/types";
import { useResource } from "../hooks/useResource";

export function PuzzlePage() {
  const { date } = useParams();
  const [isGuessPanelOpen, setIsGuessPanelOpen] = useState(false);

  const {
    data: puzzleData,
    loading: isLoading,
    error,
  } = useResource(["puzzle", date ?? "today"], async (signal) => {
    const endpoint = date
      ? `${import.meta.env.VITE_API_URL}/game/puzzle/${date}`
      : `${import.meta.env.VITE_API_URL}/game/puzzle/today`;
    try {
      const res = await fetch(endpoint, { signal });
      if (!res.ok) throw new Error("Failed to load puzzle data");
      return (await res.json()) as Puzzle;
    } catch (err) {
      if (!signal.aborted) console.error("Error fetching backend:", err);
      throw err;
    }
  });

  if (isLoading) {
    return (
      <div className="app">
        <h2>Loading...</h2>
      </div>
    );
  }

  if (error || !puzzleData) {
    return (
      <div className="app">
        <h2>Error: {error?.message ?? "No data found"}</h2>
      </div>
    );
  }

  return (
    <div
      className={`puzzle-page ${
        isGuessPanelOpen ? "puzzle-page--panel-open" : ""
      }`}
    >
      <div className="puzzle-page__board">
        <Game puzzle={puzzleData} />
      </div>
      <div className="puzzle-page__panel">
        <GuessSequencePanel
          date={puzzleData.date}
          puzzleId={puzzleData.id}
          isOpen={isGuessPanelOpen}
          onToggle={() => setIsGuessPanelOpen((open) => !open)}
        />
      </div>
    </div>
  );
}
