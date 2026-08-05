import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Game } from "../components/Game";
import { GuessSequencePanel } from "../components/GuessSequencePanel";
import { type Puzzle } from "../data/types";

export function PuzzlePage() {
  const { date } = useParams();

  const [puzzleData, setPuzzleData] = useState<Puzzle | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isGuessPanelOpen, setIsGuessPanelOpen] = useState(false);

  useEffect(() => {
    setIsLoading(true);
    setError(null);

    const endpoint = date
      ? `${import.meta.env.VITE_API_URL}/game/puzzle/${date}`
      : `${import.meta.env.VITE_API_URL}/game/puzzle/today`;

    const controller = new AbortController();

    fetch(endpoint, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load puzzle data");
        return res.json();
      })
      .then((data: Puzzle) => {
        setPuzzleData(data);
        setIsLoading(false);
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        console.error("Error fetching backend:", err);
        setError(err.message);
        setIsLoading(false);
      });

    return () => controller.abort();
  }, [date]);

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
        <h2>Error: {error ?? "No data found"}</h2>
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
          isOpen={isGuessPanelOpen}
          onToggle={() => setIsGuessPanelOpen((open) => !open)}
        />
      </div>
    </div>
  );
}
