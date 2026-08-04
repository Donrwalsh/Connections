import type { ChangeEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";

const MIN_DATE = "2023-06-12";

function todayString(): string {
  // Matches the backend's getTodaysPuzzle, which also uses UTC —
  // keeps the picker's "today" in sync with what /puzzle/today returns.
  return new Date().toISOString().split("T")[0];
}

function addDays(dateString: string, days: number): string {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().split("T")[0];
}

function randomDateWithinRange(): string {
  const [minYear, minMonth, minDay] = MIN_DATE.split("-").map(Number);
  const [maxYear, maxMonth, maxDay] = todayString().split("-").map(Number);
  const start = Date.UTC(minYear, minMonth - 1, minDay);
  const end = Date.UTC(maxYear, maxMonth - 1, maxDay);
  const totalDays = Math.floor((end - start) / 86_400_000);
  const randomOffset = Math.floor(Math.random() * (totalDays + 1));
  return addDays(MIN_DATE, randomOffset);
}

export function DatePicker() {
  const { date } = useParams();
  const navigate = useNavigate();

  const maxDate = todayString();
  const selectedDate = date ?? maxDate;

  const canGoPrevious = selectedDate > MIN_DATE;
  const canGoNext = selectedDate < maxDate;

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const newDate = event.target.value;

    // Browsers enforce min/max in the picker UI, but a typed-in value can
    // still slip through on change — guard against forwarding it.
    if (!newDate || newDate < MIN_DATE || newDate > maxDate) return;

    navigate(`/puzzle/${newDate}`);
  }

  function goToPrevious() {
    if (canGoPrevious) navigate(`/puzzle/${addDays(selectedDate, -1)}`);
  }

  function goToNext() {
    if (canGoNext) navigate(`/puzzle/${addDays(selectedDate, 1)}`);
  }

  function goToRandom() {
    navigate(`/puzzle/${randomDateWithinRange()}`);
  }

  return (
    <div className="date-navigator">
      {canGoPrevious && (
        <button
          type="button"
          className="date-navigator__arrow"
          aria-label="Previous puzzle"
          onClick={goToPrevious}
        >
          ‹
        </button>
      )}
      <input
        type="date"
        className="date-picker"
        value={selectedDate}
        min={MIN_DATE}
        max={maxDate}
        onChange={handleChange}
      />
      {canGoNext && (
        <button
          type="button"
          className="date-navigator__arrow"
          aria-label="Next puzzle"
          onClick={goToNext}
        >
          ›
        </button>
      )}
      <button
        type="button"
        className="date-navigator__random"
        aria-label="Random puzzle"
        onClick={goToRandom}
      >
        Random
      </button>
    </div>
  );
}
