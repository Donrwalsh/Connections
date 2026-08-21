import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { randomPuzzleDate } from "../data/calendarMock";
import { CalendarPopover } from "./CalendarPopover";

function GridIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="1" y="1" width="6" height="6" rx="1" />
      <rect x="9" y="1" width="6" height="6" rx="1" />
      <rect x="1" y="9" width="6" height="6" rx="1" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="12" rx="2" />
      <path d="M1.5 6h13" />
      <path d="M5 1v3M11 1v3" />
    </svg>
  );
}

function ShuffleIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M11.5 2.5H14V5" />
      <path d="M14 2.5 3 14" />
      <path d="M14 11v2.5h-2.5" />
      <path d="M10 10.5l4 3.5" />
      <path d="M3 2.5l4 3.5" />
    </svg>
  );
}

function LeaderboardIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M2 8h3v5H2z" />
      <path d="M6.5 4h3v9h-3z" />
      <path d="M11 1h3v12h-3z" />
    </svg>
  );
}

function ActivityIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M9 1 3 9h4l-1 6 6-8H8l1-6z" />
    </svg>
  );
}

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return `site-header__link${isActive ? " site-header__link--active" : ""}`;
}

/** Shared navigation header, persistent across every route. Active items get
 * the 2px accent bottom border — the first place the accent-border convention
 * is established (see DESIGN.md "Navigation"). */
export function Header() {
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const calendarRef = useRef<HTMLDivElement>(null);
  const pathnameAtOpen = useRef(location.pathname);

  useEffect(() => {
    if (location.pathname !== pathnameAtOpen.current) {
      pathnameAtOpen.current = location.pathname;
      setIsCalendarOpen(false);
    }
  }, [location.pathname]);

  useEffect(() => {
    if (!isCalendarOpen) return;
    function handlePointerDown(event: PointerEvent) {
      if (calendarRef.current && !calendarRef.current.contains(event.target as Node)) {
        setIsCalendarOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsCalendarOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isCalendarOpen]);

  return (
    <header className="site-header">
      <Link to="/leaderboard" className="site-header__wordmark">
        Connections Lab
      </Link>

      <nav className="site-header__nav" aria-label="Site navigation">
        <NavLink to="/" end className={navLinkClass} aria-label="Today's puzzle">
          <GridIcon />
          <span className="site-header__link-label">Today's puzzle</span>
        </NavLink>

        <div className="site-header__calendar" ref={calendarRef}>
          <button
            type="button"
            className="site-header__icon-btn"
            aria-label="Calendar"
            aria-expanded={isCalendarOpen}
            onClick={() => setIsCalendarOpen((open) => !open)}
          >
            <CalendarIcon />
          </button>
          {isCalendarOpen && <CalendarPopover onClose={() => setIsCalendarOpen(false)} />}
        </div>

        <button
          type="button"
          className="site-header__icon-btn"
          aria-label="Random puzzle"
          onClick={() => navigate(`/puzzle/${randomPuzzleDate()}`)}
        >
          <ShuffleIcon />
        </button>

        <NavLink to="/leaderboard" className={navLinkClass} aria-label="Leaderboard">
          <LeaderboardIcon />
          <span className="site-header__link-label">Leaderboard</span>
        </NavLink>

        <NavLink to="/activity" className={navLinkClass} aria-label="Activity">
          <ActivityIcon />
          <span className="site-header__link-label">Activity</span>
        </NavLink>
      </nav>
    </header>
  );
}
