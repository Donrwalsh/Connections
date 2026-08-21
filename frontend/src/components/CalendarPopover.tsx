import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getMonthGrid,
  isDateInRange,
  maxMonth,
  minMonth,
  monthLabel,
  monthOfDate,
  shiftMonth,
  todayUtcString,
} from "../data/calendarMock";

const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

interface CalendarPopoverProps {
  onClose: () => void;
  /** Date (ISO string) to open the calendar on and highlight, e.g. the date
   * of the puzzle page the user opened the calendar from. Falls back to the
   * latest month with no highlighted cell when omitted or out of range. */
  selectedDate?: string;
}

function sameMonth(
  a: { year: number; monthIndex: number },
  b: { year: number; monthIndex: number },
): boolean {
  return a.year === b.year && a.monthIndex === b.monthIndex;
}

/** Month grid behind the header's calendar icon. Shows the day numbers for
 * the visible month, restricted to the puzzle range (oldest puzzle → today).
 * In-range dates navigate to /puzzle/:date; out-of-range days are inert.
 * Opens on selectedDate's month (falling back to the latest month) and
 * highlights that date, if given. */
export function CalendarPopover({ onClose, selectedDate }: CalendarPopoverProps) {
  const navigate = useNavigate();
  const today = todayUtcString();
  const oldest = minMonth();
  const latest = maxMonth();
  const initialMonth =
    selectedDate && isDateInRange(selectedDate) ? monthOfDate(selectedDate) : latest;
  const [month, setMonth] = useState<{ year: number; monthIndex: number }>({ ...initialMonth });

  const atOldest = sameMonth(month, oldest);
  const atLatest = sameMonth(month, latest);
  const cells = getMonthGrid(month.year, month.monthIndex);

  function goTo(delta: number) {
    setMonth(shiftMonth(month.year, month.monthIndex, delta));
  }

  function handleSelect(date: string) {
    navigate(`/puzzle/${date}`);
    onClose();
  }

  return (
    <div className="calendar-popover" role="dialog" aria-label="Calendar">
      <div className="calendar-popover__header">
        <button
          type="button"
          className="calendar-popover__arrow"
          aria-label="Go to oldest month"
          disabled={atOldest}
          onClick={() => setMonth({ ...oldest })}
        >
          «
        </button>
        <button
          type="button"
          className="calendar-popover__arrow"
          aria-label="Previous month"
          disabled={atOldest}
          onClick={() => goTo(-1)}
        >
          ‹
        </button>
        <span className="calendar-popover__label">
          {monthLabel(month.year, month.monthIndex)}
        </span>
        <button
          type="button"
          className="calendar-popover__arrow"
          aria-label="Next month"
          disabled={atLatest}
          onClick={() => goTo(1)}
        >
          ›
        </button>
        <button
          type="button"
          className="calendar-popover__arrow"
          aria-label="Go to latest month"
          disabled={atLatest}
          onClick={() => setMonth({ ...latest })}
        >
          »
        </button>
      </div>

      <div className="calendar-popover__weekdays">
        {WEEKDAY_LETTERS.map((letter, index) => (
          <span key={`${letter}-${index}`} className="calendar-popover__weekday">
            {letter}
          </span>
        ))}
      </div>

      <div className="calendar-popover__grid">
        {cells.map((date, index) => {
          if (!date) {
            return (
              <span
                key={`blank-${index}`}
                className="calendar-popover__cell calendar-popover__cell--blank"
              />
            );
          }
          const day = Number(date.slice(8, 10));
          if (!isDateInRange(date)) {
            return (
              <span
                key={date}
                className="calendar-popover__cell calendar-popover__cell--outside"
              >
                {day}
              </span>
            );
          }
          const isToday = date === today;
          const isSelected = date === selectedDate;
          return (
            <button
              key={date}
              type="button"
              className={`calendar-popover__cell calendar-popover__cell--date${
                isToday ? " calendar-popover__cell--today" : ""
              }${isSelected ? " calendar-popover__cell--selected" : ""}`}
              aria-label={date}
              onClick={() => handleSelect(date)}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}
