import {
  Cancel01Icon,
  ComputerTerminal01Icon,
  LinkSquare02Icon,
  RefreshIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  FORGE_TITLE,
  type Forge,
  type ForgeRepository,
  type Session,
  type SessionForgeLink,
  type SessionID,
} from "@janela/core";
import {
  Badge,
  Button,
  cn,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  NativeSelect,
  NativeSelectOption,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@janela/design";
import type { ChangeEvent, ComponentProps, ReactElement, ReactNode } from "react";
import { useCallback, useId, useMemo, useState } from "react";

import { useClientEnvironment, useStoreValue } from "../../../shared/model/index.ts";
import { ShowSidebarBar, ContentCard } from "../../../shared/ui/index.ts";
import { selectSession } from "../model/command-dispatch.ts";
import {
  ATTENTION_REASON_TITLE,
  DEFAULT_INBOX_FILTER,
  INBOX_INVOLVEMENTS,
  INBOX_INVOLVEMENT_TITLE,
  INBOX_KINDS,
  INBOX_SORTS,
  INBOX_SORT_TITLE,
  INBOX_STATUS_TITLE,
  type InboxFilter,
  type InboxFilterOptions,
  type InboxItemRow,
  type InboxSessionRow,
  type InboxStatus,
  inboxFilterOptions,
  inboxItems,
  inboxKindTitle,
  inboxStatusCounts,
  inboxStatuses,
  isFiltered,
  sessionsNeedingAttention,
  updatedAgo,
  updatedOn,
} from "../model/inbox.ts";
import {
  PULL_REQUEST_STATUS_TITLE,
  itemReference,
  openLinkLabel,
  pullRequestStatus,
} from "../model/session-forge.ts";
import { BranchMark, ChecksMark, ItemKindIcon, PullRequestMark } from "./forge-marks.tsx";
import { useForgeOverview } from "./forge-overview-context.tsx";
import { SessionStatusGlyph } from "./session-status-glyph.tsx";

type TabChangeHandler = NonNullable<ComponentProps<typeof Tabs>["onValueChange"]>;

interface SelectChoice {
  readonly value: string;
  readonly title: string;
}

const ANY = "";

const INVOLVEMENT_CHOICES: readonly SelectChoice[] = INBOX_INVOLVEMENTS.map((involvement) => ({
  value: involvement,
  title: INBOX_INVOLVEMENT_TITLE[involvement],
}));

const SORT_CHOICES: readonly SelectChoice[] = INBOX_SORTS.map((sort) => ({
  value: sort,
  title: INBOX_SORT_TITLE[sort],
}));

const NO_COUNTS = { open: 0, merged: 0, closed: 0, all: 0 } as const satisfies Record<
  InboxStatus,
  number
>;

const NO_PLATFORMS: readonly Forge[] = [];

const SKELETON_ROWS = ["first", "second", "third"] as const;

const ROW_CLASS =
  "group/row relative flex rounded-lg px-2 transition-[background-color] duration-150 ease-out hover:bg-hover has-[[data-row-target]:focus-visible]:bg-hover";

const ROW_TARGET_CLASS =
  "outline-none after:absolute after:inset-0 after:rounded-lg after:ring-ring/30 focus-visible:after:ring-2";

const REVEAL_CLASS =
  "opacity-0 transition-opacity duration-150 ease-out group-hover/row:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:opacity-100";

const SEARCH_PLACEHOLDER = "Search by title, #number, branch, author or label";

export function InboxView(): ReactElement {
  const environment = useClientEnvironment();
  const { sessions: sessionStore, projects: projectStore, view, links } = environment;
  const sessions = useStoreValue(sessionStore, () => sessionStore.sessions);
  const states = useStoreValue(sessionStore, () => sessionStore.terminalStates);
  const projects = useStoreValue(projectStore, () => projectStore.projects);
  const { store, state, link } = useForgeOverview();
  const [filter, setFilter] = useState<InboxFilter>(DEFAULT_INBOX_FILTER);
  const [isRefreshing, setRefreshing] = useState(false);

  const overview = state.kind === "loaded" ? state.overview : undefined;

  const attention = useMemo(
    () => sessionsNeedingAttention(sessions, states, link),
    [sessions, states, link],
  );

  const rows = useMemo(
    () => (overview === undefined ? [] : inboxItems(overview, filter)),
    [overview, filter],
  );

  const counts = useMemo(
    () => (overview === undefined ? NO_COUNTS : inboxStatusCounts(overview, filter)),
    [overview, filter],
  );

  const options = useMemo(
    () => (overview === undefined ? undefined : inboxFilterOptions(overview)),
    [overview],
  );

  const sessionsByBranch = useMemo(() => {
    const index = new Map<string, Session[]>();

    for (const session of sessions) {
      const branch = link(session.id)?.branch;

      if (session.projectID === undefined || branch === undefined) continue;

      const key = `${session.projectID}\n${branch}`;

      index.set(key, [...(index.get(key) ?? []), session]);
    }

    return index;
  }, [sessions, link]);

  const projectName = useCallback(
    (session: Session) => projects.find((project) => project.id === session.projectID)?.name,
    [projects],
  );

  const openSession = useCallback(
    (id: SessionID) => {
      selectSession({ sessions: sessionStore, view }, id);
    },
    [sessionStore, view],
  );

  const openLink = useCallback(
    (url: string) => {
      void links.open(url).catch(() => undefined);
    },
    [links],
  );

  const refresh = useCallback(() => {
    setRefreshing(true);
    void store.refresh().finally(() => {
      setRefreshing(false);
    });
  }, [store]);

  const selectKind = useCallback<TabChangeHandler>((value) => {
    const kind = INBOX_KINDS.find((candidate) => candidate === value);

    if (kind === undefined) return;

    setFilter((current) => ({
      ...current,
      kind,
      status: inboxStatuses(kind).includes(current.status) ? current.status : "open",
    }));
  }, []);

  const now = state.kind === "loaded" ? state.receivedAt : 0;
  const isBusy = isRefreshing || state.kind === "loading";
  const platforms = options?.platforms ?? NO_PLATFORMS;

  return (
    <>
      <ShowSidebarBar />
      <ContentCard>
        <div className="h-full overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
            <header className="flex items-start gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <h1 className="text-base font-semibold">Inbox</h1>
                <p className="text-muted-foreground text-xs">
                  Sessions that need you, and the pull requests and issues of your projects.
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh"
                title="Ask GitHub and GitLab again"
                onClick={refresh}
                disabled={isBusy}
              >
                <HugeiconsIcon
                  icon={RefreshIcon}
                  strokeWidth={2}
                  className={cn(isBusy && "motion-safe:animate-spin")}
                />
              </Button>
            </header>

            {attention.length === 0 ? undefined : (
              <NeedsYouSection>
                {attention.map((row) => (
                  <AttentionSessionItem
                    key={row.session.id}
                    row={row}
                    projectName={projectName(row.session)}
                    onOpen={openSession}
                    onOpenLink={openLink}
                  />
                ))}
              </NeedsYouSection>
            )}

            <section aria-label="Pull requests and issues" className="flex flex-col gap-4">
              <Tabs value={filter.kind} onValueChange={selectKind} className="gap-0">
                <TabsList variant="line" aria-label="Kind" className="h-8 gap-4 p-0">
                  {INBOX_KINDS.map((kind) => (
                    <TabsTrigger key={kind} value={kind} className="flex-none px-0 text-sm">
                      {inboxKindTitle(kind, platforms)}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>

              {state.kind === "loading" ? (
                <LoadingRows />
              ) : state.kind === "unreachable" || options === undefined ? (
                <p className="text-muted-foreground text-xs">
                  Could not reach the background service.
                </p>
              ) : options.repositories.length === 0 ? (
                <Empty className="p-6">
                  <EmptyHeader>
                    <EmptyTitle>No project on GitHub or GitLab</EmptyTitle>
                    <EmptyDescription>
                      Add a project whose remote is on GitHub or GitLab, and its pull requests and
                      issues appear here.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <>
                  <InboxControls
                    filter={filter}
                    options={options}
                    counts={counts}
                    onChange={setFilter}
                  />
                  {rows.length === 0 ? (
                    <EmptyList filter={filter} platforms={platforms} />
                  ) : (
                    <ul className="-mx-2 flex flex-col gap-0.5">
                      {rows.map((row) => (
                        <ForgeItemRow
                          key={row.key}
                          row={row}
                          now={now}
                          sessions={
                            row.item.branch === undefined
                              ? undefined
                              : sessionsByBranch.get(
                                  `${row.repository.projectID}\n${row.item.branch}`,
                                )
                          }
                          onOpenSession={openSession}
                          onOpenLink={openLink}
                        />
                      ))}
                    </ul>
                  )}
                  <UnavailableRepositories repositories={options.repositories} />
                </>
              )}
            </section>
          </div>
        </div>
      </ContentCard>
    </>
  );
}

function NeedsYouSection(props: { readonly children: readonly ReactElement[] }): ReactElement {
  const id = useId();

  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-muted-foreground text-xs font-medium">
        Needs you
      </h2>
      <ul className="-mx-2 flex flex-col gap-0.5">{props.children}</ul>
    </section>
  );
}

function AttentionSessionItem(props: {
  readonly row: InboxSessionRow;
  readonly projectName: string | undefined;
  readonly onOpen: (id: SessionID) => void;
  readonly onOpenLink: (url: string) => void;
}): ReactElement {
  const { row, projectName, onOpen, onOpenLink } = props;
  const { session, reasons, link } = row;
  const reasonText = reasons.map((reason) => ATTENTION_REASON_TITLE[reason]).join(", ");

  const open = useCallback(() => {
    onOpen(session.id);
  }, [onOpen, session.id]);

  return (
    <li className={cn(ROW_CLASS, "items-start gap-3 py-2")}>
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">
        <SessionStatusGlyph status={reasons.includes("unread") ? "unread" : "error"} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <button
            type="button"
            data-row-target=""
            className={cn(ROW_TARGET_CLASS, "min-w-0 truncate text-left text-sm")}
            onClick={open}
            aria-label={`Open session ${session.name}, ${reasonText}`}
          >
            {session.name}
          </button>
          <span
            className={cn(
              "shrink-0 text-xs",
              reasons.includes("unread") ? "text-attention" : "text-failure",
            )}
          >
            {reasonText}
          </span>
          {projectName === undefined ? undefined : (
            <span className="text-muted-foreground min-w-0 truncate text-xs">{projectName}</span>
          )}
        </span>
        <SessionForgeLine link={link} />
      </div>
      <PullRequestLinkButton link={link} onOpenLink={onOpenLink} />
    </li>
  );
}

function SessionForgeLine(props: {
  readonly link: SessionForgeLink | undefined;
}): ReactElement | null {
  const { link } = props;
  const forge = link?.forge;
  const pullRequest = forge?.pullRequest;

  if (link?.branch === undefined && pullRequest === undefined) return null;

  return (
    <span className="text-muted-foreground flex min-w-0 items-center gap-3 text-xs">
      {link?.branch === undefined ? undefined : (
        <BranchMark branch={link.branch} className="max-w-[40%]" />
      )}
      {forge === undefined || pullRequest === undefined ? (
        <span>No pull request</span>
      ) : (
        <>
          <PullRequestMark
            status={pullRequestStatus(pullRequest)}
            reference={itemReference(forge.host, "pullRequest", pullRequest.number)}
            title={pullRequest.title}
            className="min-w-0"
          />
          {forge.checks === undefined || forge.checks === "none" ? undefined : (
            <ChecksMark checks={forge.checks} />
          )}
        </>
      )}
    </span>
  );
}

function PullRequestLinkButton(props: {
  readonly link: SessionForgeLink | undefined;
  readonly onOpenLink: (url: string) => void;
}): ReactElement | null {
  const forge = props.link?.forge;
  const pullRequest = forge?.pullRequest;

  if (forge === undefined || pullRequest === undefined) return null;

  return (
    <ExternalLinkButton
      url={pullRequest.url}
      label={openLinkLabel(forge.host, "pullRequest", pullRequest.number)}
      onOpenLink={props.onOpenLink}
    />
  );
}

function ExternalLinkButton(props: {
  readonly url: string;
  readonly label: string;
  readonly onOpenLink: (url: string) => void;
}): ReactElement {
  const { url, label, onOpenLink } = props;

  const open = useCallback(() => {
    onOpenLink(url);
  }, [onOpenLink, url]);

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      onClick={open}
      className={cn(REVEAL_CLASS, "relative z-10 -my-0.5 shrink-0")}
    >
      <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} />
    </Button>
  );
}

function ForgeItemRow(props: {
  readonly row: InboxItemRow;
  readonly now: number;
  readonly sessions: readonly Session[] | undefined;
  readonly onOpenSession: (id: SessionID) => void;
  readonly onOpenLink: (url: string) => void;
}): ReactElement {
  const { row, now, sessions, onOpenSession, onOpenLink } = props;
  const { item, repository } = row;
  const status = pullRequestStatus(item);

  const open = useCallback(() => {
    onOpenLink(item.url);
  }, [onOpenLink, item.url]);

  const hasTags = item.labels.length > 0 || (sessions !== undefined && sessions.length > 0);

  return (
    <li className={cn(ROW_CLASS, "items-start gap-3 py-2")}>
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">
        <ItemKindIcon kind={item.kind} status={status} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <button
          type="button"
          data-row-target=""
          className={cn(ROW_TARGET_CLASS, "min-w-0 truncate text-left text-sm")}
          onClick={open}
          aria-label={`${item.title} — ${openLinkLabel(repository.host, item.kind, item.number)}`}
          title={item.title}
        >
          {item.title}
        </button>
        <MetaLine>
          <span className="tabular-nums">
            {repository.name} {itemReference(repository.host, item.kind, item.number)}
          </span>
          <span>{PULL_REQUEST_STATUS_TITLE[status]}</span>
          {item.author === undefined ? undefined : <span>by {item.author}</span>}
          <time dateTime={item.updatedAt} title={updatedOn(item.updatedAt)}>
            updated {updatedAgo(item.updatedAt, now)}
          </time>
          {item.branch === undefined ? undefined : (
            <BranchMark branch={item.branch} className="max-w-56" />
          )}
        </MetaLine>
        {hasTags ? (
          <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {sessions?.map((session) => (
              <SessionChip key={session.id} session={session} onOpen={onOpenSession} />
            ))}
            {item.labels.map((label) => (
              <Badge key={label} variant="outline">
                {label}
              </Badge>
            ))}
          </span>
        ) : undefined}
      </div>
      <span className={cn(REVEAL_CLASS, "text-muted-foreground flex h-5 shrink-0 items-center")}>
        <HugeiconsIcon icon={LinkSquare02Icon} size={14} strokeWidth={1.75} aria-hidden="true" />
      </span>
    </li>
  );
}

function MetaLine(props: { readonly children: ReactNode }): ReactElement {
  return (
    <span className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs [&>*+*]:before:me-1.5 [&>*+*]:before:opacity-60 [&>*+*]:before:content-['·']">
      {props.children}
    </span>
  );
}

function SessionChip(props: {
  readonly session: Session;
  readonly onOpen: (id: SessionID) => void;
}): ReactElement {
  const { session, onOpen } = props;

  const open = useCallback(() => {
    onOpen(session.id);
  }, [onOpen, session.id]);

  return (
    <Button
      variant="secondary"
      size="xs"
      onClick={open}
      aria-label={`Open session ${session.name}`}
      title="Open the session on this branch"
      className="relative z-10 max-w-48"
    >
      <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={2} data-icon="inline-start" />
      <span className="truncate">{session.name}</span>
    </Button>
  );
}

function EmptyList(props: {
  readonly filter: InboxFilter;
  readonly platforms: readonly Forge[];
}): ReactElement {
  const { filter } = props;
  const noun = inboxKindTitle(filter.kind, props.platforms).toLowerCase();
  const narrowed = isFiltered(filter);

  return (
    <p className="text-muted-foreground py-6 text-center text-xs">
      {narrowed
        ? `No ${noun} match this search.`
        : filter.status === "all"
          ? `No ${noun} in your projects.`
          : `No ${INBOX_STATUS_TITLE[filter.status].toLowerCase()} ${noun}.`}
    </p>
  );
}

function UnavailableRepositories(props: {
  readonly repositories: readonly ForgeRepository[];
}): ReactElement | null {
  const unavailable = props.repositories.filter((repository) => !repository.isAvailable);

  if (unavailable.length === 0) return null;

  return (
    <ul className="text-muted-foreground flex flex-col gap-1 text-xs">
      {unavailable.map((repository) => (
        <li key={repository.projectID}>
          Nothing read from {repository.name}: {repository.host === "gitHub" ? "gh" : "glab"} is not
          installed, not signed in, or cannot reach {FORGE_TITLE[repository.host]}.
        </li>
      ))}
    </ul>
  );
}

function InboxControls(props: {
  readonly filter: InboxFilter;
  readonly options: InboxFilterOptions;
  readonly counts: Readonly<Record<InboxStatus, number>>;
  readonly onChange: (filter: InboxFilter) => void;
}): ReactElement {
  const { filter, options, counts, onChange } = props;

  const change = useCallback(
    (next: Partial<InboxFilter>) => {
      onChange({ ...filter, ...next });
    },
    [filter, onChange],
  );

  const clear = useCallback(() => {
    onChange({
      ...DEFAULT_INBOX_FILTER,
      kind: filter.kind,
      status: filter.status,
      sort: filter.sort,
    });
  }, [filter.kind, filter.status, filter.sort, onChange]);

  const typeQuery = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      change({ query: event.target.value });
    },
    [change],
  );

  const clearQuery = useCallback(() => {
    change({ query: "" });
  }, [change]);

  const selectStatus = useCallback<TabChangeHandler>(
    (value) => {
      const status = inboxStatuses(filter.kind).find((candidate) => candidate === value);

      if (status !== undefined) change({ status });
    },
    [change, filter.kind],
  );

  const selectSort = useCallback(
    (value: string) => {
      const sort = INBOX_SORTS.find((candidate) => candidate === value);

      if (sort !== undefined) change({ sort });
    },
    [change],
  );

  const selectInvolvement = useCallback(
    (value: string) => {
      const involvement = INBOX_INVOLVEMENTS.find((candidate) => candidate === value);

      if (involvement !== undefined) change({ involvement });
    },
    [change],
  );

  const selectPlatform = useCallback(
    (value: string) => {
      change({ platform: options.platforms.find((platform) => platform === value) });
    },
    [change, options.platforms],
  );

  const selectRepository = useCallback(
    (value: string) => {
      const chosen = options.repositories.find((repository) => repository.projectID === value);

      change({ repository: chosen?.projectID });
    },
    [change, options.repositories],
  );

  const selectAuthor = useCallback(
    (value: string) => {
      change({ author: value === ANY ? undefined : value });
    },
    [change],
  );

  const selectAssignee = useCallback(
    (value: string) => {
      change({ assignee: value === ANY ? undefined : value });
    },
    [change],
  );

  const selectLabel = useCallback(
    (value: string) => {
      change({ label: value === ANY ? undefined : value });
    },
    [change],
  );

  const platformChoices = useMemo(
    () => options.platforms.map((platform) => ({ value: platform, title: FORGE_TITLE[platform] })),
    [options.platforms],
  );

  const repositoryChoices = useMemo(
    () =>
      options.repositories.map((repository) => ({
        value: repository.projectID,
        title: repository.name,
      })),
    [options.repositories],
  );

  const authorChoices = useMemo(() => namedChoices(options.authors), [options.authors]);

  const assigneeChoices = useMemo(() => namedChoices(options.assignees), [options.assignees]);

  const labelChoices = useMemo(() => namedChoices(options.labels), [options.labels]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <InputGroup className="h-9 flex-1">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
          </InputGroupAddon>
          <InputGroupInput
            enterKeyHint="search"
            value={filter.query}
            onChange={typeQuery}
            placeholder={SEARCH_PLACEHOLDER}
            aria-label="Search pull requests and issues"
            autoComplete="off"
            spellCheck={false}
            className="text-sm"
          />
          {filter.query === "" ? undefined : (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={clearQuery}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        <FilterSelect
          label="Sort"
          value={filter.sort}
          choices={SORT_CHOICES}
          anyTitle={undefined}
          onChange={selectSort}
          size="default"
          className="w-48 [&_select]:h-9"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Tabs value={filter.status} onValueChange={selectStatus} className="gap-0">
          <TabsList aria-label="State">
            {inboxStatuses(filter.kind).map((status) => (
              <TabsTrigger key={status} value={status} className="px-2">
                {INBOX_STATUS_TITLE[status]}
                <span className="text-muted-foreground tabular-nums">{counts[status]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-2">
          {options.knowsViewer ? (
            <FilterSelect
              label="Involvement"
              value={filter.involvement}
              choices={INVOLVEMENT_CHOICES}
              anyTitle={undefined}
              onChange={selectInvolvement}
            />
          ) : undefined}
          <FilterSelect
            label="Author"
            value={filter.author ?? ANY}
            choices={authorChoices}
            anyTitle="Any author"
            onChange={selectAuthor}
          />
          <FilterSelect
            label="Assignee"
            value={filter.assignee ?? ANY}
            choices={assigneeChoices}
            anyTitle="Any assignee"
            onChange={selectAssignee}
          />
          {labelChoices.length === 0 ? undefined : (
            <FilterSelect
              label="Label"
              value={filter.label ?? ANY}
              choices={labelChoices}
              anyTitle="Any label"
              onChange={selectLabel}
            />
          )}
          {repositoryChoices.length > 1 ? (
            <FilterSelect
              label="Repository"
              value={filter.repository ?? ANY}
              choices={repositoryChoices}
              anyTitle="Any repository"
              onChange={selectRepository}
            />
          ) : undefined}
          {platformChoices.length > 1 ? (
            <FilterSelect
              label="Platform"
              value={filter.platform ?? ANY}
              choices={platformChoices}
              anyTitle="Any platform"
              onChange={selectPlatform}
            />
          ) : undefined}
          {isFiltered(filter) ? (
            <Button variant="ghost" size="sm" onClick={clear}>
              Clear
            </Button>
          ) : undefined}
        </div>
      </div>
    </div>
  );
}

function FilterSelect(props: {
  readonly label: string;
  readonly value: string;
  readonly choices: readonly SelectChoice[];
  readonly anyTitle: string | undefined;
  readonly onChange: (value: string) => void;
  readonly size?: "sm" | "default" | undefined;
  readonly className?: string | undefined;
}): ReactElement {
  const { onChange } = props;

  const handle = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      onChange(event.target.value);
    },
    [onChange],
  );

  return (
    <NativeSelect
      size={props.size ?? "sm"}
      aria-label={props.label}
      value={props.value}
      onChange={handle}
      className={props.className}
    >
      {props.anyTitle === undefined ? undefined : (
        <NativeSelectOption value={ANY}>{props.anyTitle}</NativeSelectOption>
      )}
      {props.choices.map((choice) => (
        <NativeSelectOption key={choice.value} value={choice.value}>
          {choice.title}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

function LoadingRows(): ReactElement {
  return (
    <ul aria-busy="true" aria-label="Asking GitHub and GitLab" className="flex flex-col gap-1">
      {SKELETON_ROWS.map((row) => (
        <li key={row} className="flex items-start gap-3 py-2">
          <Skeleton className="size-4 rounded-full" />
          <div className="flex flex-1 flex-col gap-2 pt-0.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-2/5" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function namedChoices(names: readonly string[]): readonly SelectChoice[] {
  return names.map((name) => ({ value: name, title: name }));
}
