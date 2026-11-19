import type { ComponentProps } from "react";

/** A Task's ID as a person sees it: the ID itself (`T14`), as the CLI takes it. */
export function TaskId({ id, ...rest }: { id: string } & Omit<ComponentProps<"span">, "children">) {
  return <span {...rest}>{id}</span>;
}
