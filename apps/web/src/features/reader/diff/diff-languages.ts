import { bundledLanguagesInfo } from "shiki/langs";

/**
 * The one rule for which of Shiki's grammars paints a file, by its name: a few well-known names (Dockerfile, Makefile),
 * else its last extension as Shiki names a language (its id or an alias: ts, md, yml, py, rs) or as written below. Any
 * other name is null and its letters stay plain. Only the colours' Worker reads this; each grammar is its own chunk,
 * fetched (`import`) the first time a file of its language is painted.
 */
const NAMES = new Map<string, string>([
  ["dockerfile", "docker"], ["containerfile", "docker"], ["makefile", "make"], ["gnumakefile", "make"], ["justfile", "just"],
  ["codeowners", "codeowners"], ["cmakelists.txt", "cmake"], [".env", "dotenv"], ["gemfile", "ruby"], ["rakefile", "ruby"],
  [".bashrc", "shellscript"], [".zshrc", "shellscript"], [".profile", "shellscript"],
]);
const EXTENSIONS = new Map<string, string>([
  ["h", "c"], ["hpp", "cpp"], ["hh", "cpp"], ["hxx", "cpp"], ["cc", "cpp"], ["cxx", "cpp"], ["htm", "html"], ["xhtml", "html"],
  ["svg", "xml"], ["plist", "xml"], ["mk", "make"], ["pyi", "python"], ["gemspec", "ruby"], ["rake", "ruby"], ["mkd", "markdown"],
  ["ex", "elixir"], ["exs", "elixir"], ["hrl", "erlang"], ["ml", "ocaml"], ["mli", "ocaml"], ["pl", "perl"], ["pm", "perl"],
]);
/** Each name Shiki gives a language, to that language's grammar: its id and its loader. */
const LANGUAGES = new Map(bundledLanguagesInfo.flatMap(info => [info.id, ...info.aliases ?? []].map(name => [name, info])));

export type CodeLanguage = { id: string; import: (typeof bundledLanguagesInfo)[number]["import"] };
export function codeLanguage(path: string): CodeLanguage | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  const language = NAMES.get(name) ?? (extension ? EXTENSIONS.get(extension) ?? extension : undefined);
  return (language && LANGUAGES.get(language)) || null;
}
