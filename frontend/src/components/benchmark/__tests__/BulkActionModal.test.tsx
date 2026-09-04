import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkActionModal } from "../BulkActionModal";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BulkActionModal", () => {
  it("shows the title and the permanence warning", () => {
    render(
      <BulkActionModal
        title="Delete errored runs"
        warning="This permanently deletes every errored run. This cannot be undone."
        action={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Delete errored runs" })).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it("runs the action with the typed password, then shows its result message and reports done", async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockResolvedValue({ message: "Deleted 3 errored strategy run(s)" });
    const onDone = vi.fn();

    render(
      <BulkActionModal
        title="Delete errored runs"
        warning="warning"
        action={action}
        onClose={vi.fn()}
        onDone={onDone}
      />,
    );

    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Deleted 3 errored strategy run(s)")).toBeInTheDocument();
    expect(action).toHaveBeenCalledWith("hunter2");
    expect(onDone).toHaveBeenCalledWith("Deleted 3 errored strategy run(s)");
  });

  it("uses a custom confirm label when given one", () => {
    render(
      <BulkActionModal
        title="t"
        warning="w"
        confirmLabel="Delete failed judge calls"
        action={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Delete failed judge calls" }),
    ).toBeInTheDocument();
  });

  it("shows the thrown error message and stays open when the action fails", async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockRejectedValue(new Error("Bad password"));
    const onClose = vi.fn();

    render(
      <BulkActionModal title="t" warning="w" action={action} onClose={onClose} />,
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Bad password")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("closes on Cancel, overlay click, and Escape", async () => {
    const user = userEvent.setup();

    const onClose1 = vi.fn();
    const { unmount: unmount1 } = render(
      <BulkActionModal title="t" warning="w" action={vi.fn()} onClose={onClose1} />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose1).toHaveBeenCalled();
    unmount1();

    const onClose2 = vi.fn();
    const { unmount: unmount2 } = render(
      <BulkActionModal title="t" warning="w" action={vi.fn()} onClose={onClose2} />,
    );
    await user.click(screen.getByRole("dialog"));
    expect(onClose2).toHaveBeenCalled();
    unmount2();

    const onClose3 = vi.fn();
    render(<BulkActionModal title="t" warning="w" action={vi.fn()} onClose={onClose3} />);
    await user.keyboard("{Escape}");
    expect(onClose3).toHaveBeenCalled();
  });
});
