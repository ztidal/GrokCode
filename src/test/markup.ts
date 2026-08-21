import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Rendering, in a suite that has no DOM.
 *
 * Nothing here installs jsdom and vitest runs in node, but `react-dom` is
 * already a dependency, so a component can still be turned into the markup it
 * really emits. That is the point: a stylesheet rule or a `querySelector`
 * written against a class no element carries fails silently, and matching the
 * stylesheet against the component's *source text* only says the string is in
 * the file, not that it reaches an element.
 *
 * `renderToStaticMarkup` rather than `renderToString` so the output carries no
 * hydration comments to step over.
 */
export function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

export interface Tag {
  name: string;
  attrs: Record<string, string>;
  classes: string[];
}

const OPEN_TAG = /<([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:="[^"]*")?)*)\s*\/?>/g;
const ATTRIBUTE = /([^\s=/>]+)(?:="([^"]*)")?/g;

/**
 * Every opening tag, in document order.
 *
 * A regex is enough only because React does the escaping: `"` and `>` never
 * survive into an attribute value, so a quoted span is unambiguous.
 */
export function tags(html: string): Tag[] {
  const found: Tag[] = [];
  for (const [, name, rawAttrs] of html.matchAll(OPEN_TAG)) {
    const attrs: Record<string, string> = {};
    for (const [, key, value] of (rawAttrs ?? "").matchAll(ATTRIBUTE)) {
      attrs[key] = value ?? "";
    }
    found.push({
      name: name!,
      attrs,
      classes: (attrs.class ?? "").split(/\s+/).filter(Boolean),
    });
  }
  return found;
}

/** The tags a stylesheet rule or a `querySelector` for `.className` would reach. */
export function withClass(html: string, className: string): Tag[] {
  return tags(html).filter((tag) => tag.classes.includes(className));
}
