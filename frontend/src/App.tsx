import { Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { PuzzlePage } from "./pages/PuzzlePage";
import "./App.css";

function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<PuzzlePage />} />
        <Route path="puzzle/:date" element={<PuzzlePage />} />
      </Route>
    </Routes>
  );
}

export default App;
