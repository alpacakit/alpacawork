import { beforeAll, afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { startI18n } from "@alpacawork/i18n";
import { taskCreateShape } from "@alpacawork/contract/inputs";
import { ApiError } from "../src/data/client";
import { FormError, FormField, SubmitButton, useServerForm } from "../src/features/forms/server-form";
import { Input } from "../src/components/ui/input";

beforeAll(() => startI18n());
afterEach(cleanup);

const shape = taskCreateShape.pick({ title: true });
function Example({ submit }: { submit: (value: { title: string }) => Promise<void> }) {
  const form = useServerForm({ schema: shape, defaultValues: { title: "" }, submit });
  return <form onSubmit={event => { event.preventDefault(); void form.save(); }}>
    <FormField form={form} name="title" id="title" label="Title">
      {field => <Input {...field} />}
    </FormField>
    <FormError form={form} />
    <SubmitButton form={form} label="Save" />
  </form>;
}

test("a server issue appears beside its field", async () => {
  const submit = vi.fn().mockRejectedValue(new ApiError("Rejected", "invalid_input", "fix", undefined,
    [{ path: "title", code: "blank", message: "Must not be blank" }]));
  render(<Example submit={submit} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "A title" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Title" }).closest('[data-slot="field"]')?.textContent)
    .toContain("Enter a value in this field."));
  expect(screen.getByRole("textbox", { name: "Title" }).getAttribute("aria-invalid")).toBe("true");
  expect(submit).toHaveBeenCalledTimes(1);
});

test("an issue without a matching field appears at the form root", async () => {
  const submit = vi.fn().mockRejectedValue(new ApiError("Rejected", "invalid_input", "fix", undefined,
    [{ path: "other", code: "custom", message: "Other value is wrong" }]));
  render(<Example submit={submit} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "A title" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Check the format."));
  expect(screen.queryByText(/Other value is wrong/)).toBeNull();
});

test("reread blocks a second send", async () => {
  const submit = vi.fn().mockRejectedValue(new ApiError("Changed", "conflict", "reread"));
  render(<Example submit={submit} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "A title" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true));
  fireEvent.submit(screen.getByRole("textbox", { name: "Title" }).closest("form")!);
  expect(submit).toHaveBeenCalledTimes(1);
});

test("the submit button shows its pending state until the write finishes", async () => {
  let finish!: () => void;
  const submit = vi.fn().mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<Example submit={submit} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "A title" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true));
  finish();
  await waitFor(() => expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false));
});

test("the contract's title limit prevents a write", async () => {
  const submit = vi.fn().mockResolvedValue(undefined);
  render(<Example submit={submit} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "x".repeat(201) } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Title" }).closest('[data-slot="field"]')?.textContent)
    .toContain("200"));
  expect(submit).not.toHaveBeenCalled();
});
