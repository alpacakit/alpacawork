import { expect, test } from "vitest";
import { bareUrls, webTarget } from "../src/domain/web-link";

const urls = (text: string) => bareUrls(text).map(found => found.captured);

test("a bare address ends before a sentence's own closing marks and any other script's letters", () => {
  expect(urls("Prototype screen: https://pc.example-tail.ts.net:10000/?agent=1 （Open on a phone…）"))
    .toEqual(["https://pc.example-tail.ts.net:10000/?agent=1"]);
  expect(urls("Screen:https://a.test/b、next （https://c.test/d） and 「https://e.test/f」。")).toEqual(["https://a.test/b", "https://c.test/d", "https://e.test/f"]);
  expect(urls("See https://a.test/b. Then https://a.test/c, and https://a.test/d; https://a.test/e! https://a.test/f?")).toEqual(
    ["https://a.test/b", "https://a.test/c", "https://a.test/d", "https://a.test/e", "https://a.test/f"]);
  expect(urls("(https://a.test/b) [https://a.test/c] see https://a.test/d).")).toEqual(["https://a.test/b", "https://a.test/c", "https://a.test/d"]);
  expect(urls("https://en.wikipedia.org/wiki/Foo_(bar) and (https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual(
    ["https://en.wikipedia.org/wiki/Foo_(bar)", "https://en.wikipedia.org/wiki/Foo_(bar)"]);
  expect(urls("<https://a.test/b> \"https://a.test/c\" 'https://a.test/d'")).toEqual(["https://a.test/b", "https://a.test/c", "https://a.test/d"]);
  expect(urls("HTTP://A.TEST/x?q=1&r=2#top")).toEqual(["HTTP://A.TEST/x?q=1&r=2#top"]);
  expect(urls("https://a.test/b: https://a.test/foo_bar_ ~https://a.test/c~ {https://a.test/d} **https://a.test/e**")).toEqual(
    ["https://a.test/b", "https://a.test/foo_bar", "https://a.test/c", "https://a.test/d", "https://a.test/e"]);
});

test("an address inside a word or an HTML attribute, without a host, or of another scheme is not a link", () => {
  expect(urls("xhttps://a.test git+https://a.test/r <img src=\"https://evil.test/p\"> href='https://evil.test/q' https:// http://")).toEqual([]);
  expect(urls("javascript:alert(1) data:text/html,x file:///etc/passwd ftp://a.test/b")).toEqual([]);
  // One address holding another stays one.
  expect(urls("https://a.test/?next=https://b.test/c")).toEqual(["https://a.test/?next=https://b.test/c"]);
});

test("an address of another origin leads away; one of this origin stays here, as its task, the screen or a plain link", () => {
  const origin = "http://work.test:5499";
  const here = (task: { address: string; path: string | null } | null, screen = true) => ({ kind: "here", task, screen });
  expect(webTarget("http://work.test:5499/?task=T42", origin)).toEqual(here({ address: "T42", path: null }));
  expect(webTarget("http://work.test:5499/?task=T42&event=L1&agent=1", origin)).toEqual(here({ address: "T42", path: null }));
  expect(webTarget("http://work.test:5499/?task=T42&tab=files&path=files%2F", origin)).toEqual(here({ address: "T42", path: "files/" }));
  expect(webTarget("http://work.test:5499/?task=T42&tab=files&path=files%2F&image=files%2Fa.png", origin)).toEqual(here({ address: "T42", path: "files/a.png" }));
  expect(webTarget("http://work.test:5499/?task=T42&tab=files&path=files%2F&view=T7%2Ffiles%2Fa.md", origin)).toEqual(here({ address: "T7", path: "files/a.md" }));
  expect(webTarget("http://work.test:5499/api/tasks/T42/file?path=files%2Fa.png&v=1", origin)).toEqual(here({ address: "T42", path: "files/a.png" }, false));
  expect(webTarget("http://work.test:5499/?task=T42&tab=about", origin)).toEqual(here({ address: "T42", path: null }));
  expect(webTarget("http://work.test:5499/?agent=1", origin)).toEqual(here(null));
  expect(webTarget("http://work.test:5499/", origin)).toEqual(here(null));
  expect(webTarget("http://work.test:5499/api/tasks/T42/file", origin)).toEqual(here(null, false));
  expect(webTarget("http://work.test:5499/x?task=T42", origin)).toEqual(here(null, false));
  for (const away of ["http://work.test:10000/?task=T42", "https://work.test:5499/?task=T42", "http://other.test:5499/?task=T42"])
    expect(webTarget(away, origin)).toEqual({ kind: "away" });
});
