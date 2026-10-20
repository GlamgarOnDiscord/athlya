/**
 * Model of the console command palette: pages from the navigation, plus
 * the classes and members the palette loads when it opens, filtered on the
 * client. Every entry is an existing route.
 */
import { matchesQuery } from '../../lib/search-text';

export type CommandKind = 'page' | 'class' | 'member';

export interface CommandItem {
  readonly id: string;
  readonly kind: CommandKind;
  readonly label: string;
  /** Secondary text, also searched: a date, an email. */
  readonly hint: string;
  readonly href: string;
}

const LIMIT_PER_KIND = 6;
const KIND_ORDER: ReadonlyArray<CommandKind> = ['page', 'class', 'member'];

/** Matching items grouped page, class, member, at most six of each. */
export function searchCommands(items: ReadonlyArray<CommandItem>, query: string): CommandItem[] {
  return KIND_ORDER.flatMap((kind) =>
    items
      .filter((item) => item.kind === kind && matchesQuery(query, item.label, item.hint))
      .slice(0, LIMIT_PER_KIND),
  );
}
