import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ProviderFilter } from "../ProviderFilter";

function SearchProbe() {
  const { search } = useLocation();
  return <div data-testid="search">{search}</div>;
}

function renderFilter(initialEntry = "/leaderboard") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ProviderFilter />
      <SearchProbe />
    </MemoryRouter>,
  );
}

describe("ProviderFilter", () => {
  it("renders a toggle for every provider pool", () => {
    renderFilter();

    for (const label of ["OpenAI", "Google", "Groq", "OpenRouter", "Mistral", "SambaNova", "Ollama"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("reflects the ?provider= param as pressed toggles", () => {
    renderFilter("/leaderboard?provider=groq,mistral");

    expect(screen.getByRole("button", { name: "Groq" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Mistral" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "OpenAI" })).toHaveAttribute("aria-pressed", "false");
  });

  it("adds a pool to the URL in canonical order when its toggle is clicked", async () => {
    const user = userEvent.setup();
    renderFilter("/leaderboard?provider=mistral");

    await user.click(screen.getByRole("button", { name: "OpenAI" }));

    expect(screen.getByTestId("search")).toHaveTextContent("provider=openai%2Cmistral");
  });

  it("removes a pool when re-clicked, and drops the param once empty", async () => {
    const user = userEvent.setup();
    renderFilter("/leaderboard?provider=groq");

    await user.click(screen.getByRole("button", { name: "Groq" }));

    expect(screen.getByTestId("search")).toHaveTextContent("");
    expect(screen.getByTestId("search").textContent).not.toContain("provider");
  });

  it("keeps unrelated query params intact", async () => {
    const user = userEvent.setup();
    renderFilter("/leaderboard?metric=successRate");

    await user.click(screen.getByRole("button", { name: "Groq" }));

    const search = screen.getByTestId("search").textContent ?? "";
    expect(search).toContain("metric=successRate");
    expect(search).toContain("provider=groq");
  });
});
