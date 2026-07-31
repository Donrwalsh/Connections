import { Outlet } from "react-router-dom";
import { DatePicker } from "./DatePicker";

export function Layout() {
  return (
    <>
      <header className="app-header">
        <DatePicker />
      </header>
      <Outlet />
    </>
  );
}
