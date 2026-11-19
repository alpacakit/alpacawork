import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { AttachmentCards } from "../src/features/reader/Attachments";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("ja"); });
afterEach(cleanup);

const picture = { id: "p", name: "shot.png", src: "data:image/png;base64,AA==" };
const arcs = () => screen.getByRole("progressbar").querySelectorAll("circle[stroke-dasharray]");

test("a picture on its way shows the upload's own progress as a ring over it, and its × still takes it out", () => {
  const remove = vi.fn();
  const { rerender } = render(<AttachmentCards cards={[{ ...picture, progress: 0.42 }]} remove={remove} />);
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
  expect(arcs()[0]!.getAttribute("stroke-dasharray")).toBe("42 100");
  fireEvent.click(screen.getByRole("button", { name: "shot.png を外す" }));
  expect(remove).toHaveBeenCalledWith("p");
  // Nothing gone yet is said as nothing: the track alone, not a sliver.
  rerender(<AttachmentCards cards={[{ ...picture, progress: 0 }]} remove={remove} />);
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
  expect(arcs()).toHaveLength(0);
  // Saved, the ring and the white go and the picture opens.
  const open = vi.fn();
  rerender(<AttachmentCards cards={[{ ...picture, open }]} remove={remove} />);
  expect(screen.queryByRole("progressbar")).toBeNull();
  fireEvent.click(screen.getByTitle("shot.png"));
  expect(open).toHaveBeenCalled();
});
