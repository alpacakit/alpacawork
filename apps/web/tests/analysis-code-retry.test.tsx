import { expect, test } from "vitest";
import { failedAddress } from "../src/features/shell/Workbench";

test("a part of the code that could not be fetched is asked for again at its own address, as the browser named it", () => {
  // Chromium and Firefox name the address; the retry asks for it anew (the browser remembers the failure of the old ask).
  expect(failedAddress(new TypeError("Failed to fetch dynamically imported module: http://127.0.0.1:5499/assets/AnalysisView-Db7KAP7v.js")))
    .toBe("http://127.0.0.1:5499/assets/AnalysisView-Db7KAP7v.js");
  expect(failedAddress(new TypeError("error loading dynamically imported module: https://host.example/assets/AnalysisView-x1.js")))
    .toBe("https://host.example/assets/AnalysisView-x1.js");
  // Where the failure names none, the page is read again instead.
  expect(failedAddress(new TypeError("Importing a module script failed."))).toBeUndefined();
});
