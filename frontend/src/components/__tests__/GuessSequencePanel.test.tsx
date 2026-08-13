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
  meta: { total: 3, page: 1, limit: 200 },
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
    meta: { total: 2, page: 1, limit: 200 },
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
    meta: { total: 1, page: 1, limit: 200 },
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
  meta: { total: 2, page: 1, limit: 200 },
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
// (/run/:trialNumber) returns the full guess list on demand; the guess-detail
// endpoint (/run/:trialNumber/guess/:sequenceNumber) returns LLM info for a
// single guess.
function setupFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      const urlStr = String(url);
      const strategyId =
        urlStr.match(/\/strategy\/([^/]+)\//)?.[1] ?? "alphabetical";
      const trialNumber = Number(urlStr.match(/\/run\/(\d+)/)?.[1] ?? 0);

      const runDetail = () =>
        strategyId === "shuffle-smart"
          ? (shuffleSmartDetails[trialNumber] as typeof strategyRunDetail)
          : strategyId === "shuffle-foolish"
            ? shuffleFoolishDetail
            : strategyRunDetail;

      const guessDetail = urlStr.match(/\/guess\/(\d+)/);
      if (guessDetail) {
        const sequenceNumber = Number(guessDetail[1]);
        const guess = runDetail().guesses.find(
          (g) => g.sequenceNumber === sequenceNumber,
        ) ?? {
          sequenceNumber,
          words: [],
          result: "failure",
          guessedAt: "2024-01-15T00:00:00Z",
        };
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ...guess,
            promptTokens: 1500,
            completionTokens: 320,
            totalTokens: 1820,
            latencyMs: 2340,
            temperature: 0.7,
            numResponses: 5,
            promptAttempts: 2,
            duplicatesRejected: 3,
            llmDetails: {
              category: "GREETINGS",
              confidence: 0.9,
              reasoning: `Reasoning for guess ${sequenceNumber}`,
              prompt: `Prompt for guess ${sequenceNumber}`,
            },
          }),
        });
      }

      const detail = urlStr.match(/\/run\/(\d+)/);
      if (detail) {
        const body = runDetail();
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
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(
      <GuessSequencePanel
        date="2024-01-15"
        isOpen={true}
        onToggle={() => {}}
      />,
    );

    expect(
      screen.getByText("Loading Alphabetical guesses..."),
    ).toBeInTheDocument();
  });

  it("shows strategy step counts on the toggle buttons", async () => {
    setupFetch();

    render(
      <GuessSequencePanel
        date="2024-01-15"
        isOpen={false}
        onToggle={() => {}}
      />,
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
      <GuessSequencePanel
        date="2024-01-15"
        isOpen={true}
        onToggle={() => {}}
      />,
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
      <GuessSequencePanel
        date="2024-01-15"
        isOpen={false}
        onToggle={onToggle}
      />,
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
      <GuessSequencePanel
        date="2024-01-15"
        isOpen={true}
        onToggle={onToggle}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Hide Alphabetical/ }),
    );
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("switches the active strategy when a different strategy is clicked while open", async () => {
    setupFetch();

    render(
      <GuessSequencePanel
        date="2024-01-15"
        isOpen={true}
        onToggle={() => {}}
      />,
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
      <GuessSequencePanel
        date="2024-01-15"
        isOpen={true}
        onToggle={() => {}}
      />,
    );

    expect(await screen.findByText(/network down/)).toBeInTheDocument();
  });

  it("differentiates between shuffle-smart trials and switches between them", async () => {
    setupFetch();

    render(
      <GuessSequencePanel
        date="2024-01-15"
        isOpen={true}
        onToggle={() => {}}
      />,
    );

    // Button shows the average guess count across trials ((2 + 1) / 2 = 1.5).
    expect(
      await screen.findByRole("button", {
        name: /Show Shuffle-Smart \(1\.5\)/,
      }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Show Shuffle-Smart/ }));

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
      <GuessSequencePanel
        date="2024-01-15"
        isOpen={true}
        onToggle={() => {}}
      />,
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

  it("shows LLM runs and renders duplicate + terminal statuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        const urlStr = String(url);
        const strategyId =
          urlStr.match(/\/strategy\/([^/]+)\//)?.[1] ?? "alphabetical";
        if (urlStr.includes("/run/")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              id: 31,
              strategyName: "llm-openai",
              trialNumber: 1,
              status: "duplicate",
              modelName: "mistral",
              contextWindow: 2048,
              startedAt: "2024-01-15T00:00:00Z",
              finishedAt: "2024-01-15T00:05:00Z",
              guessCount: 3,
              meta: { total: 3, page: 1, limit: 200 },
              guesses: [
                {
                  sequenceNumber: 1,
                  words: ["APPLE", "BANANA", "CHERRY", "DATE"],
                  result: "success",
                  guessedAt: "2024-01-15T00:00:00Z",
                },
                {
                  sequenceNumber: 2,
                  words: ["APPLE", "BANANA", "CHERRY", "DATE"],
                  result: "duplicate",
                  guessedAt: "2024-01-15T00:00:00Z",
                },
                {
                  sequenceNumber: 3,
                  words: ["APPLE", "BANANA", "CHERRY", "DATE"],
                  result: "duplicate",
                  guessedAt: "2024-01-15T00:00:00Z",
                },
              ],
            }),
          });
        }
        if (strategyId !== "llm-openai") {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              id: 31,
              strategyName: "llm-openai",
              trialNumber: 1,
              status: "duplicate",
              modelName: "mistral",
              contextWindow: 2048,
              guessCount: 3,
            },
          ],
        });
      }),
    );

    render(
      <GuessSequencePanel
        date="2024-01-15"
        isOpen={true}
        onToggle={() => {}}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Show LLM · OpenAI/ }),
    );

    expect(
      await screen.findByText(
        "Strategy: LLM · OpenAI · Model: mistral (2,048 ctx) · Status: duplicate · 3 guesses",
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findAllByText("APPLE, BANANA, CHERRY, DATE"),
    ).toHaveLength(3);
    expect(screen.getAllByText("Duplicate")).toHaveLength(2);
    expect(screen.getByText("✓ Correct")).toBeInTheDocument();
  });

  it("differentiates between LLM trials and switches between them", async () => {
    const llmRuns = [
      {
        id: 41,
        strategyName: "llm-openai",
        trialNumber: 1,
        status: "completed",
        modelName: "mistral",
        contextWindow: 2048,
        startedAt: "2024-01-15T00:00:00Z",
        finishedAt: "2024-01-15T00:05:00Z",
        guessCount: 4,
      },
      {
        id: 42,
        strategyName: "llm-openai",
        trialNumber: 2,
        status: "duplicate",
        modelName: "mistral",
        contextWindow: 2048,
        startedAt: "2024-01-15T00:00:00Z",
        finishedAt: "2024-01-15T00:05:00Z",
        guessCount: 2,
      },
    ];
    const llmDetails: Record<number, unknown> = {
      1: {
        ...llmRuns[0],
        meta: { total: 4, page: 1, limit: 200 },
        guesses: [
          {
            sequenceNumber: 1,
            words: ["APPLE", "BANANA", "CHERRY", "DATE"],
            result: "success",
            guessedAt: "2024-01-15T00:00:00Z",
          },
          {
            sequenceNumber: 2,
            words: ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
            result: "success",
            guessedAt: "2024-01-15T00:00:00Z",
          },
        ],
      },
      2: {
        ...llmRuns[1],
        meta: { total: 2, page: 1, limit: 200 },
        guesses: [
          {
            sequenceNumber: 1,
            words: ["APPLE", "BANANA", "CHERRY", "DATE"],
            result: "duplicate",
            guessedAt: "2024-01-15T00:00:00Z",
          },
        ],
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        const urlStr = String(url);
        const strategyId =
          urlStr.match(/\/strategy\/([^/]+)\//)?.[1] ?? "alphabetical";
        if (urlStr.includes("/run/")) {
          const trialNumber = Number(urlStr.match(/\/run\/(\d+)/)?.[1] ?? 1);
          return Promise.resolve({
            ok: true,
            json: async () => llmDetails[trialNumber],
          });
        }
        if (strategyId !== "llm-openai") {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({
          ok: true,
          json: async () => llmRuns,
        });
      }),
    );

    render(
      <GuessSequencePanel
        date="2024-01-15"
        isOpen={true}
        onToggle={() => {}}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Show LLM · OpenAI/ }),
    );

    // Button shows the average guess count across trials ((4 + 2) / 2 = 3).
    expect(
      screen.getByRole("button", { name: /Hide LLM · OpenAI \(3\)/ }),
    ).toBeInTheDocument();

    // Both trial runs are selectable, first one is shown by default, and each
    // carries its model so the trials are visibly differentiable.
    expect(
      await screen.findByRole("button", {
        name: /Trial #1 · completed · 4 guesses · mistral \(2,048 ctx\)/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /Trial #2 · duplicate · 2 guesses · mistral \(2,048 ctx\)/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Strategy: LLM · OpenAI · Model: mistral (2,048 ctx) · Trial #1 · Status: completed · 4 guesses",
      ),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /Trial #2 · duplicate/ }),
    );

    expect(
      await screen.findByText(
        "Strategy: LLM · OpenAI · Model: mistral (2,048 ctx) · Trial #2 · Status: duplicate · 2 guesses",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText("Duplicate")).toBeInTheDocument();
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
      <GuessSequencePanel
        date="2024-01-15"
        isOpen={true}
        onToggle={() => {}}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Show Shuffle-Smart/ }),
    );

    expect(
      await screen.findByText("No runs yet for Shuffle Smart."),
    ).toBeInTheDocument();
  });

  it("opens a detail panel with LLM info when a guess is clicked", async () => {
    setupFetch();

    render(
      <GuessSequencePanel
        date="2024-01-15"
        isOpen={true}
        onToggle={() => {}}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: /A, B, C, D/,
      }),
    );

    expect(await screen.findByText("Prompt tokens")).toBeInTheDocument();
    expect(screen.getByText("1,500")).toBeInTheDocument();
    expect(screen.getByText("Completion tokens")).toBeInTheDocument();
    expect(screen.getByText("320")).toBeInTheDocument();
    expect(screen.getByText("Latency")).toBeInTheDocument();
    expect(screen.getByText("2,340 ms")).toBeInTheDocument();
    expect(screen.getByText("0.7")).toBeInTheDocument();
    expect(screen.getByText("Duplicates rejected")).toBeInTheDocument();
    expect(screen.getByText("GREETINGS")).toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument();
    expect(screen.getByText("Reasoning for guess 1")).toBeInTheDocument();
    expect(screen.getByText("Prompt for guess 1")).toBeInTheDocument();
  });

  it("closes the detail panel when the open guess is clicked again", async () => {
    setupFetch();

    render(
      <GuessSequencePanel
        date="2024-01-15"
        isOpen={true}
        onToggle={() => {}}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: /A, B, C, D/,
      }),
    );
    expect(await screen.findByText("Prompt tokens")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /A, B, C, D/ }));
    expect(screen.queryByText("Prompt tokens")).not.toBeInTheDocument();
  });

  it("shows only one open guess detail panel at a time (accordion)", async () => {
    setupFetch();

    render(
      <GuessSequencePanel
        date="2024-01-15"
        isOpen={true}
        onToggle={() => {}}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: /A, B, C, D/,
      }),
    );
    expect(
      await screen.findByText("Reasoning for guess 1"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /E, F, G, H/ }));

    expect(
      await screen.findByText("Reasoning for guess 2"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Reasoning for guess 1")).not.toBeInTheDocument();
    expect(screen.getAllByText("Prompt tokens")).toHaveLength(1);
  });

  it("shows an error message when the guess detail fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        const urlStr = String(url);
        const strategyId =
          urlStr.match(/\/strategy\/([^/]+)\//)?.[1] ?? "alphabetical";
        if (urlStr.includes("/guess/")) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: async () => ({ message: "guess not found" }),
          });
        }
        if (urlStr.includes("/run/")) {
          return Promise.resolve({
            ok: true,
            json: async () => strategyRunDetail,
          });
        }
        const runs = strategyId === "shuffle-smart" ? [] : [strategyRun];
        return Promise.resolve({
          ok: true,
          json: async () =>
            runs.map((run) => ({ ...run, strategyName: strategyId })),
        });
      }),
    );

    render(
      <GuessSequencePanel
        date="2024-01-15"
        isOpen={true}
        onToggle={() => {}}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: /A, B, C, D/,
      }),
    );

    expect(await screen.findByText("guess not found")).toBeInTheDocument();
  });
});
