import { Icon } from "@/components/ui/icon";

export type Example = { name: string; label: string; shows?: string; words: string };

/**
 * Examples to start from, on one raised surface of their own: only what can be pressed stands on it, as the input
 * does, so a heading or a note above it never reads as one more row. A press puts the example's words in the input
 * (the enter mark, always shown, says so); the person sends. Each row carries its name in `data-warm-example`.
 */
export function ExampleList({ examples, onPick }: { examples: Example[]; onPick: (words: string) => void }) {
  return <ul className="m-0 list-none divide-y divide-rule overflow-hidden rounded-lg border-hairline border-lit-line bg-raised p-0">
    {examples.map(({ name, label, shows, words }) => <li key={name}>
      <button type="button" data-warm-example={name} onClick={() => onPick(words)}
        className="flex min-h-10 w-full items-center justify-between gap-3 bg-transparent px-3 py-2 text-left text-base text-ink hover:bg-hover active:bg-press focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-lit-line pointer-coarse:min-h-11">
        <span className="flex min-w-0 flex-col gap-0.5 [word-break:auto-phrase]">
          <span className="text-balance">{label}</span>{shows && <span className="text-sm text-pretty text-soft">{shows}</span>}
        </span>
        <Icon name="enter" className="size-4 flex-none text-soft" />
      </button>
    </li>)}
  </ul>;
}
