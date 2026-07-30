import { useEffect, useState } from "react";
import { Game } from "./Game.tsx";
import "./App.css";
import { type Puzzle } from "./data/samplePuzzle";

function App() {
  const [puzzleData, setPuzzleData] = useState<Puzzle | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_URL}/game/puzzle/today`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load puzzle data");
        return res.json();
      })
      .then((data: Puzzle) => {
        setPuzzleData(data);
        setIsLoading(false);
      })
      .catch((err: Error) => {
        console.error("Error fetching backend:", err);
        setError(err.message);
        setIsLoading(false);
      });
  }, []);

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

  return <Game puzzle={puzzleData} />;
}

export default App;
