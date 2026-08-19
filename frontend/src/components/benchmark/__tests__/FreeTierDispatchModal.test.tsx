import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FreeTierDispatchModal } from "../FreeTierDispatchModal";
import type { FreeTierDispatchStatus } from "../../../data/benchmark/types";

const flagshipStatus: FreeTierDispatchStatus = {
  tier: "flagship",
  active: true,
  thresholdPercent: 75,
  startedAt: "2024-01-01T00:00:00Z",
};

const miniStatus: FreeTierDispatchStatus = {
  tier: "mini",
  active: true,
  thresholdPercent: 75,
  startedAt: "2024-01-01T00:00:00Z",
};

function stubFetch(handler: (url: string, init: RequestInit | undefined) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown, init?: RequestInit) => {
      const body = handler(String(url), init);
      return Promise.resolve({ ok: true, json: async () => body });
    }),
  );
}

function stubFetchError(message: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: false, status: 400, json: async () => ({ message }) })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FreeTierDispatchModal", () => {
  it("defaults to 'Both' selected and a 90% threshold", () => {
    render(<FreeTierDispatchModal onClose={vi.fn()} onDispatchChanged={vi.fn()} />);

    expect(screen.getByRole("radio", { name: "Both" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Flagship" })).not.toBeChecked();
    expect(screen.getByRole("spinbutton", { name: /Threshold/ })).toHaveValue(90);
  });

  it("starts a single tier at the chosen threshold, then closes and reports the change", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onDispatchChanged = vi.fn();
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    stubFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return flagshipStatus;
    });

    render(<FreeTierDispatchModal onClose={onClose} onDispatchChanged={onDispatchChanged} />);

    await user.click(screen.getByRole("radio", { name: "Flagship" }));
    await user.clear(screen.getByRole("spinbutton", { name: /Threshold/ }));
    await user.type(screen.getByRole("spinbutton", { name: /Threshold/ }), "75");
    await user.click(screen.getByRole("button", { name: "Start" }));

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onDispatchChanged).toHaveBeenCalled();
    expect(capturedUrl).toContain("/dispatch/free-tier/flagship");
    expect(capturedUrl).toContain("threshold=75");
    expect(capturedInit?.method).toBe("POST");
  });

  it("starts both tiers and closes when both succeed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onDispatchChanged = vi.fn();
    stubFetch((url) => {
      expect(url).toContain("/dispatch/free-tier/both");
      return {
        flagship: { tier: "flagship", status: flagshipStatus, error: null },
        mini: { tier: "mini", status: miniStatus, error: null },
      };
    });

    render(<FreeTierDispatchModal onClose={onClose} onDispatchChanged={onDispatchChanged} />);
    await user.click(screen.getByRole("button", { name: "Start" }));

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onDispatchChanged).toHaveBeenCalled();
  });

  it("shows a per-tier result and stays open when starting both partially fails", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onDispatchChanged = vi.fn();
    stubFetch(() => ({
      flagship: { tier: "flagship", status: flagshipStatus, error: null },
      mini: {
        tier: "mini",
        status: null,
        error: "Free-tier dispatch for 'mini' is already running at a 80% threshold.",
      },
    }));

    render(<FreeTierDispatchModal onClose={onClose} onDispatchChanged={onDispatchChanged} />);
    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText(/Mini & nano: Free-tier dispatch for 'mini'/)).toBeInTheDocument();
    expect(screen.getByText(/Flagship: started at 75%/)).toBeInTheDocument();
    // A partial success still changed real state, so the parent is told —
    // but the modal itself stays open so the user can see which tier failed.
    expect(onDispatchChanged).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // The "Start" button is replaced with "Close" once results are shown.
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the backend's error message and stays open when a single-tier start fails", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    stubFetchError(
      "Free-tier dispatch for 'flagship' is already running at a 90% threshold. Stop it first to change the threshold.",
    );

    render(<FreeTierDispatchModal onClose={onClose} onDispatchChanged={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: "Flagship" }));
    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText(/already running at a 90% threshold/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("rejects a non-whole-number or out-of-range threshold client-side without calling the API", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<FreeTierDispatchModal onClose={vi.fn()} onDispatchChanged={vi.fn()} />);

    const thresholdInput = screen.getByRole("spinbutton", { name: /Threshold/ });
    await user.clear(thresholdInput);
    await user.type(thresholdInput, "0");
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();

    await user.clear(thresholdInput);
    await user.type(thresholdInput, "150");
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes on Cancel, overlay click, and Escape", async () => {
    const user = userEvent.setup();

    const onClose1 = vi.fn();
    const { unmount: unmount1 } = render(
      <FreeTierDispatchModal onClose={onClose1} onDispatchChanged={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose1).toHaveBeenCalled();
    unmount1();

    const onClose2 = vi.fn();
    const { unmount: unmount2 } = render(
      <FreeTierDispatchModal onClose={onClose2} onDispatchChanged={vi.fn()} />,
    );
    await user.click(screen.getByRole("dialog"));
    expect(onClose2).toHaveBeenCalled();
    unmount2();

    const onClose3 = vi.fn();
    render(<FreeTierDispatchModal onClose={onClose3} onDispatchChanged={vi.fn()} />);
    await user.keyboard("{Escape}");
    expect(onClose3).toHaveBeenCalled();
  });

  it("does not close when clicking inside the modal card", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<FreeTierDispatchModal onClose={onClose} onDispatchChanged={vi.fn()} />);
    await user.click(screen.getByText("Enable Auto-Dispatch"));

    expect(onClose).not.toHaveBeenCalled();
  });
});
