import type { ChangeEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";

const MIN_DATE = "2023-06-12";

function todayString(): string {
  // Matches the backend's getTodaysPuzzle, which also uses UTC —
  // keeps the picker's "today" in sync with what /puzzle/today returns.
  return new Date().toISOString().split("T")[0];
}

export function DatePicker() {
  const { date } = useParams();
  const navigate = useNavigate();

  const maxDate = todayString();
  const selectedDate = date ?? maxDate;

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const newDate = event.target.value;

    // Browsers enforce min/max in the picker UI, but a typed-in value can
    // still slip through on change — guard against forwarding it.
    if (!newDate || newDate < MIN_DATE || newDate > maxDate) return;

    navigate(`/puzzle/${newDate}`);
  }

  return (
    <input
      type="date"
      className="date-picker"
      value={selectedDate}
      min={MIN_DATE}
      max={maxDate}
      onChange={handleChange}
    />
  );
}
