import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { SiteLayout } from "./components/SiteLayout";
import { PuzzlePage } from "./pages/PuzzlePage";
import "./App.css";

// Lazy-loaded: the benchmark dashboard (and everything it pulls in —
// tables, the guess-chain visualizer, budget widgets) is dead weight for a
// player who just wants today's puzzle at "/", which needs PuzzlePage alone.
const LeaderboardPage = lazy(() =>
  import("./pages/benchmark/LeaderboardPage").then((m) => ({ default: m.LeaderboardPage })),
);
const StrategyPuzzlePage = lazy(() =>
  import("./pages/benchmark/StrategyPuzzlePage").then((m) => ({ default: m.StrategyPuzzlePage })),
);
const PuzzleRunsPage = lazy(() =>
  import("./pages/benchmark/PuzzleRunsPage").then((m) => ({ default: m.PuzzleRunsPage })),
);
const ActivityPage = lazy(() =>
  import("./pages/benchmark/ActivityPage").then((m) => ({ default: m.ActivityPage })),
);
const MaintenancePage = lazy(() =>
  import("./pages/benchmark/MaintenancePage").then((m) => ({ default: m.MaintenancePage })),
);
const AdminLoginPage = lazy(() =>
  import("./pages/AdminLoginPage").then((m) => ({ default: m.AdminLoginPage })),
);

function RouteFallback() {
  return <p className="bench-muted">Loading…</p>;
}

function App() {
  return (
    <Routes>
      <Route element={<SiteLayout />}>
        <Route index element={<PuzzlePage />} />
        <Route path="puzzle/:date" element={<PuzzlePage />} />
        <Route
          path="leaderboard"
          element={
            <Suspense fallback={<RouteFallback />}>
              <LeaderboardPage />
            </Suspense>
          }
        />
        <Route
          path="leaderboard/:strategyId"
          element={
            <Suspense fallback={<RouteFallback />}>
              <StrategyPuzzlePage />
            </Suspense>
          }
        />
        <Route
          path="leaderboard/:strategyId/:puzzleId"
          element={
            <Suspense fallback={<RouteFallback />}>
              <PuzzleRunsPage />
            </Suspense>
          }
        />
        <Route
          path="activity"
          element={
            <Suspense fallback={<RouteFallback />}>
              <ActivityPage />
            </Suspense>
          }
        />
        <Route
          path="maintenance"
          element={
            <Suspense fallback={<RouteFallback />}>
              <MaintenancePage />
            </Suspense>
          }
        />
        <Route
          path="admin-login"
          element={
            <Suspense fallback={<RouteFallback />}>
              <AdminLoginPage />
            </Suspense>
          }
        />
      </Route>
    </Routes>
  );
}

export default App;
