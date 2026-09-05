import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteRunModal } from "../DeleteRunModal";
import type { DeleteRunResult } from "../../../data/benchmark/types";

const deletedResult: DeleteRunResult = {
  message: "Deleted strategy run 12292 and all related data",
  runId: 12292,
  deletedGuesses: 3,
  deletedSolvePrompts: 5,
  deletedLlmProposals: 2,
  deletedCategoryEvaluations: 1,
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

describe("DeleteRunModal", () => {
  it("shows the run id and a permanence warning", () => {
    vi.stubGlobal("fetch", vi.fn());

    render(<DeleteRunModal runId={12292} onClose={vi.fn()} onDeleted={vi.fn()} />);

    expect(screen.getByRole("heading", { name: /12292/ })).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it("DELETEs /dispatch/run/:runId with the admin session, then reports the deletion and closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onDeleted = vi.fn();
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    stubFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return deletedResult;
    });

    render(<DeleteRunModal runId={12292} onClose={onClose} onDeleted={onDeleted} />);

    await user.click(screen.getByRole("button", { name: "Delete" }));

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onDeleted).toHaveBeenCalledWith(deletedResult);
    expect(capturedUrl).toContain("/dispatch/run/12292");
    expect(capturedInit?.method).toBe("DELETE");
    expect(capturedInit?.credentials).toBe("include");
    expect((capturedInit?.headers as Record<string, string>)["X-Admin-Request"]).toBe("1");
  });

  it("shows the backend's error message and stays open when the delete fails", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    stubFetchError("Strategy run 12292 is still running; stop it before deleting.");

    render(<DeleteRunModal runId={12292} onClose={onClose} onDeleted={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText(/still running; stop it before deleting/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Cancel, overlay click, and Escape", async () => {
    const user = userEvent.setup();

    const onClose1 = vi.fn();
    const { unmount: unmount1 } = render(
      <DeleteRunModal runId={1} onClose={onClose1} onDeleted={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose1).toHaveBeenCalled();
    unmount1();

    const onClose2 = vi.fn();
    const { unmount: unmount2 } = render(
      <DeleteRunModal runId={1} onClose={onClose2} onDeleted={vi.fn()} />,
    );
    await user.click(screen.getByRole("dialog"));
    expect(onClose2).toHaveBeenCalled();
    unmount2();

    const onClose3 = vi.fn();
    render(<DeleteRunModal runId={1} onClose={onClose3} onDeleted={vi.fn()} />);
    await user.keyboard("{Escape}");
    expect(onClose3).toHaveBeenCalled();
  });
});
