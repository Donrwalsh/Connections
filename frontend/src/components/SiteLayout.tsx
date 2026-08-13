import { Outlet } from "react-router-dom";
import { Header } from "./Header";

/** Root layout: one shared header persistent across every route, with page
 * content below. Replaces the per-area game/benchmark headers. */
export function SiteLayout() {
  return (
    <div className="site-layout">
      <Header />
      <main className="site-layout__main">
        <Outlet />
      </main>
    </div>
  );
}
