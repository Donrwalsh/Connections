import { Routes, Route } from "react-router-dom";
import { SiteLayout } from "./components/SiteLayout";
import { PuzzlePage } from "./pages/PuzzlePage";
import { LeaderboardPage } from "./pages/benchmark/LeaderboardPage";
import { StrategyPuzzlePage } from "./pages/benchmark/StrategyPuzzlePage";
import { PuzzleRunsPage } from "./pages/benchmark/PuzzleRunsPage";
import "./App.css";

function App() {
  return (
    <Routes>
      <Route element={<SiteLayout />}>
        <Route index element={<PuzzlePage />} />
        <Route path="puzzle/:date" element={<PuzzlePage />} />
        <Route path="leaderboard" element={<LeaderboardPage />} />
        <Route path="leaderboard/:strategyId" element={<StrategyPuzzlePage />} />
        <Route path="leaderboard/:strategyId/:puzzleId" element={<PuzzleRunsPage />} />
      </Route>
    </Routes>
  );
}

export default App;
