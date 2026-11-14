# VN EDGE dashboard design system

How the dashboard is built and how to add to it. The aim is one visual language, one way to lay out a page and one
way to move around, so a new page looks like it belongs without bespoke CSS.

## Layers

`dashboard/src/main.tsx` imports the stylesheets in this order; later layers win on equal specificity.

| file | holds |
|---|---|
| `styles/tokens.css` | every design token: surfaces, text, accent, gain / loss / warn / info, radius, elevation, type scale, spacing, layout sizes, motion, z-layers. Dark default, light under `[data-theme='light']`. |
| `styles/base.css` | reset, focus ring, skip link, ambient background, scrollbars, reduced-motion rule, utility classes. |
| `styles/shell.css` | sidebar, top bar, account menu, command palette, banners, phone layout. |
| `styles/components.css` | the long-standing components: panels, KPI tiles, pills, buttons, inputs, tables, charts, dialogs, toasts. |
| `styles/kit.css` | the page-level kit (below) and layout helpers. |
| `styles/polish.css` | the refreshed look of the components in `components.css`, kept in one file so the change is reviewable. |
| `styles/pages.css` | page- and feature-specific rules accumulated before the kit existed. |
| `styles/pages/<page>.css` | new page-specific CSS, imported by the page that owns it. |

## Tokens

Use `var(--token)`; never a literal colour. The ones you will reach for:

- Surfaces: `--bg`, `--surface`, `--surface-2` (panels), `--surface-3` (raised / hover), `--border`, `--border-strong`.
- Text: `--text`, `--muted`, `--muted-2` (all AA on every surface, in both themes).
- Meaning: `--gain`, `--loss`, `--warn`, `--info` and their `-soft` backgrounds; `--accent`, `--accent-2`, `--accent-3`.
- Type: `--fs-2xs` … `--fs-3xl`, `--font-ui`, `--font-mono`. Numbers always use `.mono` (tabular figures).
- Space and shape: `--s-1` … `--s-6`, `--gap-page`, `--radius-sm`, `--radius`, `--radius-lg`.
- Motion: `--dur-1/2/3` and `--ease`. Animation is removed under `prefers-reduced-motion`.

Density (`comfortable` / `compact`) changes `--pad-*` and `--gap-page`, not the components.

## The kit (`components/kit`)

| component | use it for |
|---|---|
| `PageHeader` | the page's title, one plain sentence of context, optional chips and actions, optional tabs. `PageTitle` in `ui.tsx` renders one with the title taken from the route, so the sidebar, breadcrumb, browser tab and heading always agree. |
| `Stat`, `StatGrid` | the headline numbers of a page, with a label, one line of context and an optional sparkline. |
| `Callout` | a message that earns its space: tone `info`, `ok`, `warn` or `danger`, a title, a sentence, optional actions. |
| `Tabs`, `TabPanel` | keeping a long page to one primary view. WAI-ARIA tablist with arrow-key navigation. The default tab shows the primary content. |
| `Section` | a titled block with a one-line explanation and actions on the right. |
| `Toolbar` | the row of filters and controls above a table or grid. |
| `EmptyState` | "nothing here", why, and what to do next. |

## Page recipe

1. `PageHeader` (or `PageTitle sub=…`): a plain title and at most two short sentences. No taglines.
2. What needs the operator now: `Callout` or a Needs-you block, only when there is something.
3. The headline numbers as a `StatGrid`.
4. The primary content: the table, the queue or the chart.
5. Everything else behind `Tabs`, never more than about three stacked secondary panels.

A page must work at 1440, 1024 and 390 px with no horizontal page scroll (tables scroll inside their own wrapper), and
every control needs a visible label or an `aria-label`.

## The four books and the ladder

The dashboard reads the product as four **books** on one **ladder**: **Backtest** (history), **Shadow** (research trades
on live prices, never money), **Paper** (the simulated account) and **Live** (real money, off until every go-live
check passes). A strategy climbs one step at a time. **ML is a lens**, an optional model score on any number that has
one, never a page of its own.

- `lib/books.ts` holds the model as pure, tested functions: `ladderOf` places a strategy from its incubator stages
  and trades, `nextStep` says the next step in a sentence, `inScope` filters by book.
- `lib/bookScope.tsx` keeps the **book scope** (All, Live, Paper, Shadow, Backtest) and the **ML lens** for the whole
  dashboard. The scope is remembered and can be set from a link with `?book=paper`. The book switch and the lens sit in
  the top bar; Live shows `off` until real money is armed.
- `components/kit/books.tsx` has `BookChip`, `BookDot`, `BookCard`, `LadderPips`, `BookSwitch` and `MlLensToggle`.
  Each book has a colour (`--book-live`, `--book-paper`, `--book-shadow`, `--book-backtest`, `--book-ml`) and a second
  cue that is not colour: shadow is dashed, backtest is hatched, live carries a state word.
- Rule for every new number: it says which book it comes from, and it comes from an existing hook. Where the data does
  not exist yet the page says so instead of showing a placeholder.

The sidebar groups the pages as **Work** (Home, Workspace, Strategies, Decisions, Trades), **Markets** (Signals, Radar,
Trade health, Chart), **Lab** (Lab, Scanners, Library, Incubator, Trackers, Performance, Daily, Learn) and **Control**
(Live control, Gates, Exchange, Settings, Logs). Strategies is the front door to the Scanners, Library and Incubator
views of the same script.

## Moving around

- **⌘K / Ctrl+K** or `/` opens the command palette: pages, actions and every scanner. Actions that change anything
  (pause entries, reset the paper account) only open the same confirmation dialog as their buttons.
- `g` then a letter goes to a page; the list is in the `?` dialog and in `components/shell/navModel.ts`.
- The navigation is data (`navModel.ts`), tested in `dashboard/test/nav.test.ts`: every page has one route and one key,
  and no page that existed before the redesign has been dropped.

## Performance

Pages other than Overview load on first visit (`React.lazy` in `App.tsx`), so the first paint ships the shell and the
landing page, not the chart engine or the Pine runtime. `Layout` wraps the outlet in `Suspense`.
