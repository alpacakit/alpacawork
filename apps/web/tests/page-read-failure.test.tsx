import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { startI18n } from "@alpacawork/i18n";
import { ApiError } from "../src/data/client";
import { PageReadFailure, type PageRead, type ReadView } from "../src/features/tree/PageReadFailure";

beforeAll(() => startI18n());
afterEach(cleanup);

const failedNextPage = (error: Error): PageRead => ({ data: { pages: [] }, hasNextPage: true, isFetchingNextPage: false, isPending: false, isFetching: false,
  isError: true, isFetchNextPageError: true, error, fetchNextPage: vi.fn(async () => {}), refetch: vi.fn(async () => {}) });
const read = { assessment: { kind: "current" } } as unknown as ReadView;
const retry = () => fireEvent.click(screen.getByRole("button"));

test("a next page refused because the list changed is read again from its first page", () => {
  const page = failedNextPage(new ApiError("Page changed", "conflict", "reread"));
  render(<PageReadFailure page={page} read={read} />);
  retry();
  expect(page.refetch).toHaveBeenCalledTimes(1);
  expect(page.fetchNextPage).not.toHaveBeenCalled();
});

test("a next page that failed for another reason asks for that page again", () => {
  const page = failedNextPage(new ApiError("Try later", "unavailable", "later"));
  render(<PageReadFailure page={page} read={read} />);
  retry();
  expect(page.fetchNextPage).toHaveBeenCalledTimes(1);
  expect(page.refetch).not.toHaveBeenCalled();
});
