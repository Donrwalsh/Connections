import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuessSequencePanel } from "../GuessSequencePanel";

const strategyRun = {
  id: 1,
  strategyName: "alphabetical",
  trialNumber: 0,
  status: "completed",
  startedAt: "2024-01-15T00:00:00Z",
  finishedAt: "2024-01-15T00:05:00Z",
  guessCount: 3,
};

const strategyRunDetail = {
  ...strategyRun,
  guesses: [
    {
      sequenceNumber: 1,
      words: ["A", "B", "C", "D"],
      result: "success",
      guessedAt: "2024-01-15T00:00:00Z",
    },
    {
      sequenceNumber: 2,
      words: ["E", "F", "G", "H"],
      result: "offBy1",
      guessedAt: "2024-01-15T00:00:00Z",
    },
    {
      sequenceNumber: 3,
      words: ["I", "J", "K", "L"],
      result: "failure",
      guessedAt: "2024-01-15T00:00:00Z",
    },
  ],
};

const shuffleSmartRuns = [
  {
    id: 11,
    strategyName: "shuffle-smart",
    trialNumber: 1,
    status: "completed",
    startedAt: "2024-01-15T00:00:00Z",
    finishedAt: "2024-01-15T00:05:00Z",
    guessCount: 2,
  },
  {
    id: 12,
    strategyName: "shuffle-smart",
    trialNumber: 2,
    status: "failed",
    startedAt: "2024-01-15T00:00:00Z",
    finishedAt: "2024-01-15T00:05:00Z",
    guessCount: 1,
  },
];

const shuffleSmartDetails: Record<number, unknown> = {
  1: {
    ...shuffleSmartRuns[0],
    guesses: [
      {
        sequenceNumber: 1,
        words: ["A", "B", "C", "D"],
        result: "success",
        guessedAt: "2024-01-15T00:00:00Z",
      },
      {
        sequenceNumber: 2,
        words: ["W", "X", "Y", "Z"],
        result: "success",
        guessedAt: "2024-01-15T00:00:00Z",
      },
    ],
  },
  2: {
    ...shuffleSmartRuns[1],
    guesses: [
      {
        sequenceNumber: 1,
        words: ["M", "N", "O", "P"],
        result: "failure",
        guessedAt: "2024-01-15T00:00:00Z",
      },
    ],
  },
};

const shuffleFoolishDetail = {
  id: 21,
  strategyName: "shuffle-foolish",
  trialNumber: 1,
  status: "completed",
  startedAt: "2024-01-15T00:00:00Z",
  finishedAt: "2024-01-15T00:05:00Z",
  guessCount: 2,
  guesses: [
    {
      sequenceNumber: 1,
      words: ["A", "B", "C", "D"],
      result: "failure",
      guessedAt: "2024-01-15T00:00:00Z",
    },
    {
      sequenceNumber: 2,
      words: ["A", "B", "C", "D"],
      result: "success",
      guessedAt: "2024-01-15T00:00:00Z",
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// The list endpoint returns slim runs (no guess arrays); the detail endpoint
// (/run/:trialNumber) returns the full guess list on demand.
function setupFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      const urlStr = String(url);
      const strategyId =
        urlStr.match(/\/strategy\/([^/]+)\//)?.[1] ?? "alphabetical";

      const detail = urlStr.match(/\/run\/(\d+)$/);
      if (detail) {
        const trialNumber = Number(detail[1]);
        const body =
          strategyId === "shuffle-smart"
            ? shuffleSmartDetails[trialNumber]
            : strategyId === "shuffle-foolish"
              ? shuffleFoolishDetail
              : strategyRunDetail;
        return Promise.resolve({ ok: true, json: async () => body });
      }

      const runs =
        strategyId === "shuffle-smart" ? shuffleSmartRuns : [strategyRun];
      return Promise.resolve({
        ok: true,
        json: async () =>
          runs.map((run) => ({ ...run, strategyName: strategyId })),
      });
    }),
  );
}

describe("GuessSequencePanel Component", () => {
  it("shows a loading message while strategies are fetching", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    render(
      <GuessSequencePanel date="2024-01-15" isOpen={true} onToggle={() => {}} />,
    );

    expect(
      screen.getByText("Loading Alphabetical guesses..."),
    ).toBeInTheDocument();
  });

  it("shows strategy step counts on the toggle buttons", async () => {
    setupFetch();

    render(
      <GuessSequencePanel date="2024-01-15" isOpen={false} onToggle={() => {}} />,
    );

    expect(
      await screen.findByRole("button", { name: /Show Alphabetical \(3\)/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Show Rev-Alphabetical \(3\)/ }),
    ).toBeInTheDocument();
  });

  it("shows the guesses for the active strategy when open", async () => {
    setupFetch();

    render(
      <GuessSequencePanel date="2024-01-15" isOpen={true} onToggle={() => {}} />,
    );

    expect(
      await screen.findByText(
        "Strategy: Alphabetical · Status: completed · 3 guesses",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText("A, B, C, D")).toBeInTheDocument();
    expect(screen.getByText("✓ Correct")).toBeInTheDocument();
    expect(screen.getByText("One away")).toBeInTheDocument();
    expect(screen.getByText("✗ Incorrect")).toBeInTheDocument();
  });

  it("calls onToggle to open the panel when a strategy button is clicked while closed", async () => {
    setupFetch();

    const onToggle = vi.fn();
    render(
      <GuessSequencePanel date="2024-01-15" isOpen={false} onToggle={onToggle} />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Show Alphabetical/ }),
    );
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("calls onToggle to close the panel when the active strategy is clicked while open", async () => {
    setupFetch();

    const onToggle = vi.fn();
    render(
      <GuessSequencePanel date="2024-01-15" isOpen={true} onToggle={onToggle} />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Hide Alphabetical/ }),
    );
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("switches the active strategy when a different strategy is clicked while open", async () => {
    setupFetch();

    render(
      <GuessSequencePanel date="2024-01-15" isOpen={true} onToggle={() => {}} />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Show Rev-Alphabetical/ }),
    );

    expect(
      await screen.findByText(
        "Strategy: Reverse Alphabetical · Status: completed · 3 guesses",
      ),
    ).toBeInTheDocument();
  });

  it("shows an error message when a strategy fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    render(
      <GuessSequencePanel date="2024-01-15" isOpen={true} onToggle={() => {}} />,
    );

    expect(await screen.findByText(/network down/)).toBeInTheDocument();
  });

  it("differentiates between shuffle-smart trials and switches between them", async () => {
    setupFetch();

    render(
      <GuessSequencePanel date="2024-01-15" isOpen={true} onToggle={() => {}} />,
    );

    // Button shows the average guess count across trials ((2 + 1) / 2 = 1.5).
    expect(
      await screen.findByRole("button", {
        name: /Show Shuffle-Smart \(1\.5\)/,
      }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /Show Shuffle-Smart/ }),
    );

    // Both trial runs are selectable, first one is shown by default.
    expect(
      await screen.findByRole("button", { name: /Trial #1 · completed/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Trial #2 · failed/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Strategy: Shuffle Smart · Trial #1 · Status: completed · 2 guesses",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText("W, X, Y, Z")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Trial #2 · failed/ }));

    expect(
      await screen.findByText(
        "Strategy: Shuffle Smart · Trial #2 · Status: failed · 1 guess",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText("M, N, O, P")).toBeInTheDocument();
    expect(screen.queryByText("W, X, Y, Z")).not.toBeInTheDocument();
  });

  it("shows shuffle-foolish runs and renders duplicate guesses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        const urlStr = String(url);
        const strategyId =
          urlStr.match(/\/strategy\/([^/]+)\//)?.[1] ?? "alphabetical";
        if (urlStr.includes("/run/")) {
          return Promise.resolve({
            ok: true,
            json: async () => shuffleFoolishDetail,
          });
        }
        if (strategyId !== "shuffle-foolish") {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              id: 21,
              strategyName: "shuffle-foolish",
              trialNumber: 1,
              status: "completed",
              guessCount: 2,
            },
          ],
        });
      }),
    );

    render(
      <GuessSequencePanel date="2024-01-15" isOpen={true} onToggle={() => {}} />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Show Shuffle-Foolish/ }),
    );

    expect(
      await screen.findByText(
        "Strategy: Shuffle Foolish · Status: completed · 2 guesses",
      ),
    ).toBeInTheDocument();
    expect(await screen.findAllByText("A, B, C, D")).toHaveLength(2);
    expect(screen.getAllByText("✗ Incorrect")).toHaveLength(1);
  });

  it("shows a message when a strategy has no runs yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        const strategyId =
          String(url).match(/\/strategy\/([^/]+)\//)?.[1] ?? "alphabetical";
        const runs = strategyId === "shuffle-smart" ? [] : [strategyRun];
        return Promise.resolve({
          ok: true,
          json: async () =>
            runs.map((run) => ({ ...run, strategyName: strategyId })),
        });
      }),
    );

    render(
      <GuessSequencePanel date="2024-01-15" isOpen={true} onToggle={() => {}} />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Show Shuffle-Smart/ }),
    );

    expect(
      await screen.findByText("No runs yet for Shuffle Smart."),
    ).toBeInTheDocument();
  });
});
