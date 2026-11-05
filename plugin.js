// Projects for Buzz 1.0: read-only browser over NIP-MP projects (kind 30621),
// NIP-34 repositories (kind 30617) and their linked channels.
const PROJECT_KIND = 30621;
const REPO_KIND = 30617;
const READ_LIMIT = 500;
const DELETE_BATCH = 100;

const first = (event, name) => {
  const found = event.tags.find((tag) => tag[0] === name);
  return found && found[1] ? found[1] : undefined;
};
const all = (event, name) =>
  event.tags.filter((tag) => tag[0] === name && tag[1]).map((tag) => tag[1]);

/** Keep the newest event for each replaceable address. */
function heads(events, kind) {
  const newest = new Map();
  for (const event of events) {
    const dtag = first(event, "d");
    if (event.kind !== kind || !dtag) continue;
    const address = `${kind}:${event.pubkey}:${dtag}`;
    const held = newest.get(address);
    if (!held || event.created_at > held.event.created_at)
      newest.set(address, { address, dtag, event });
  }
  return [...newest.values()];
}

/** Drop addresses their owner deleted at or after the head was published. */
function surviving(items, deletions) {
  return items.filter(
    (item) =>
      !deletions.some(
        (deletion) =>
          deletion.kind === 5 &&
          deletion.pubkey === item.event.pubkey &&
          deletion.created_at >= item.event.created_at &&
          deletion.tags.some(
            (tag) =>
              (tag[0] === "a" && tag[1] === item.address) ||
              (tag[0] === "e" && tag[1] === item.event.id),
          ),
      ),
  );
}

export function buildModel(projectEvents, repoEvents, deletions) {
  const repos = surviving(heads(repoEvents, REPO_KIND), deletions).map(
    (item) => ({
      address: item.address,
      owner: item.event.pubkey,
      dtag: item.dtag,
      name: first(item.event, "name") || item.dtag,
      description: first(item.event, "description") || item.event.content || "",
      channelId: first(item.event, "buzz-channel"),
    }),
  );
  const byAddress = new Map(repos.map((repo) => [repo.address, repo]));
  const claimed = new Set();
  const projects = surviving(heads(projectEvents, PROJECT_KIND), deletions)
    .map((item) => {
      const members = all(item.event, "a").filter((address) =>
        address.startsWith(`${REPO_KIND}:`),
      );
      for (const address of members) claimed.add(address);
      return {
        address: item.address,
        name: first(item.event, "name") || item.dtag,
        description: first(item.event, "description") || "",
        channelId: first(item.event, "buzz-channel"),
        repos: members
          .map((address) => byAddress.get(address))
          .filter(Boolean)
          .sort((a, b) => a.name.localeCompare(b.name)),
        missing: members.filter((address) => !byAddress.has(address)).length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const unassigned = repos
    .filter((repo) => !claimed.has(repo.address))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { projects, unassigned };
}

export async function loadModel(session) {
  const [projectEvents, repoEvents] = await Promise.all([
    session.read([{ kinds: [PROJECT_KIND], limit: READ_LIMIT }]),
    session.read([{ kinds: [REPO_KIND], limit: READ_LIMIT }]),
  ]);
  const items = [
    ...heads(projectEvents, PROJECT_KIND),
    ...heads(repoEvents, REPO_KIND),
  ];
  const deletions = [];
  for (let start = 0; start < items.length; start += DELETE_BATCH) {
    const batch = items.slice(start, start + DELETE_BATCH);
    const authors = [...new Set(batch.map((item) => item.event.pubkey))];
    deletions.push(
      ...(await session.read([
        {
          kinds: [5],
          authors,
          "#a": batch.map((item) => item.address),
          limit: READ_LIMIT,
        },
      ])),
    );
  }
  return {
    ...buildModel(projectEvents, repoEvents, deletions),
    capped:
      projectEvents.length >= READ_LIMIT || repoEvents.length >= READ_LIMIT,
  };
}

const matches = (query, ...values) =>
  !query ||
  values.some((value) => (value || "").toLowerCase().includes(query));

export function filterModel(model, text) {
  const query = text.trim().toLowerCase();
  if (!query) return model;
  const repoMatches = (repo) => matches(query, repo.name, repo.description);
  return {
    ...model,
    projects: model.projects
      .map((project) =>
        matches(query, project.name, project.description)
          ? project
          : { ...project, repos: project.repos.filter(repoMatches) },
      )
      .filter(
        (project) =>
          project.repos.length > 0 ||
          matches(query, project.name, project.description),
      ),
    unassigned: model.unassigned.filter(repoMatches),
  };
}

/** Immediate children of `dir`: folders first, then files, both by name. */
export function listFolder(files, dir) {
  const prefix = dir ? `${dir}/` : "";
  const folders = new Map();
  const entries = [];
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      entries.push({ name: rest, path: file.path, size: file.size });
      continue;
    }
    const name = rest.slice(0, slash);
    const folder = folders.get(name) || {
      name,
      path: prefix + name,
      count: 0,
      size: 0,
    };
    folder.count += 1;
    folder.size += file.size;
    folders.set(name, folder);
  }
  const byName = (a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  return {
    folders: [...folders.values()].sort(byName),
    files: entries.sort(byName),
  };
}

export function crumbs(path) {
  const parts = path ? path.split("/") : [];
  return parts.map((name, index) => ({
    name,
    path: parts.slice(0, index + 1).join("/"),
  }));
}

export const parentOf = (path) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

export function searchFiles(files, text, limit = 200) {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return files
    .filter((file) => {
      const path = file.path.toLowerCase();
      return words.every((word) => path.includes(word));
    })
    .slice(0, limit);
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function diffKind(line) {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("diff --git") || line.startsWith("@@")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "plain";
}

export function friendlyError(error) {
  const status = error && error.status;
  if (error && error.kind === "denied")
    return "You don't have access to this repository's files.";
  if (status === 404) return "That file isn't in the latest commit.";
  if (status === 503 || status === 504)
    return "The server took too long to send this repository. It often works on a second try.";
  return "This repository's files couldn't be loaded right now.";
}

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" stroke-linejoin="round"><path d="M3 6h6l2 2h10v11H3z"/></svg>';
const DIFF_LINE_LIMIT = 4000;
const MONO =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const HAIRLINE = "1px solid color-mix(in srgb, currentColor 16%, transparent)";

const styles = {
  scroll: { height: "100%", width: "100%", overflowY: "auto" },
  page: {
    padding: "24px 32px 48px",
    maxWidth: 960,
    margin: "0 auto",
    boxSizing: "border-box",
    width: "100%",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
    flexWrap: "wrap",
  },
  title: { margin: 0, flex: 1, minWidth: 0 },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    marginBottom: 16,
    borderRadius: 8,
    border: HAIRLINE,
    background: "transparent",
    color: "inherit",
    font: "inherit",
  },
  card: { padding: "14px 16px", marginBottom: 12 },
  name: { fontSize: 15, fontWeight: 600, margin: 0 },
  muted: { opacity: 0.68, fontSize: 13, margin: "3px 0 0" },
  section: { fontSize: 13, fontWeight: 600, margin: "22px 0 8px", opacity: 0.75 },
  list: { listStyle: "none", margin: "8px 0 0", padding: 0 },
  repoRow: {
    display: "flex",
    gap: 10,
    alignItems: "baseline",
    padding: "4px 0",
    minWidth: 0,
  },
  link: {
    background: "none",
    border: "none",
    padding: 0,
    color: "inherit",
    font: "inherit",
    fontWeight: 500,
    textDecoration: "underline",
    textUnderlineOffset: 2,
    cursor: "pointer",
    textAlign: "left",
    flexShrink: 0,
  },
  button: {
    padding: "5px 10px",
    borderRadius: 7,
    border: HAIRLINE,
    background: "transparent",
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
    opacity: 0.68,
    fontSize: 13,
  },
  tabs: {
    display: "flex",
    gap: 4,
    borderBottom: HAIRLINE,
    marginBottom: 14,
  },
  tab: (active) => ({
    padding: "6px 12px",
    background: "none",
    border: "none",
    borderBottom: `2px solid ${active ? "currentColor" : "transparent"}`,
    marginBottom: -1,
    color: "inherit",
    font: "inherit",
    fontWeight: active ? 600 : 400,
    opacity: active ? 1 : 0.7,
    cursor: "pointer",
  }),
  crumbs: {
    display: "flex",
    flexWrap: "wrap",
    gap: 4,
    alignItems: "baseline",
    margin: "0 0 10px",
    fontSize: 14,
    minWidth: 0,
  },
  table: { border: HAIRLINE, borderRadius: 8, overflow: "hidden" },
  entry: (first) => ({
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    boxSizing: "border-box",
    padding: "7px 12px",
    background: "none",
    border: "none",
    borderTop: first ? "none" : HAIRLINE,
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
    minWidth: 0,
  }),
  entryName: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  entryIcon: { width: 16, height: 16, flexShrink: 0, opacity: 0.7 },
  entrySize: { fontSize: 12, opacity: 0.6, flexShrink: 0 },
  code: {
    display: "flex",
    border: HAIRLINE,
    borderRadius: 8,
    overflow: "auto",
    maxHeight: "70vh",
    fontFamily: MONO,
    fontSize: 12.5,
    lineHeight: 1.55,
  },
  gutter: {
    margin: 0,
    padding: "10px 10px",
    textAlign: "right",
    opacity: 0.45,
    userSelect: "none",
    borderRight: HAIRLINE,
    position: "sticky",
    left: 0,
    fontFamily: "inherit",
    flexShrink: 0,
  },
  source: {
    margin: 0,
    padding: "10px 12px",
    fontFamily: "inherit",
    flex: 1,
    whiteSpace: "pre",
    tabSize: 4,
  },
  readme: {
    margin: 0,
    padding: "14px 16px",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    fontSize: 13.5,
    lineHeight: 1.55,
  },
  diff: {
    border: HAIRLINE,
    borderRadius: 8,
    overflow: "auto",
    maxHeight: "70vh",
    padding: "8px 0",
    fontFamily: MONO,
    fontSize: 12.5,
    lineHeight: 1.5,
  },
  diffLine: (kind) => ({
    whiteSpace: "pre",
    padding: "0 12px",
    minHeight: "1.5em",
    width: "max-content",
    minWidth: "100%",
    boxSizing: "border-box",
    fontWeight: kind === "meta" ? 600 : 400,
    opacity: kind === "meta" ? 0.75 : 1,
    background:
      kind === "add"
        ? "color-mix(in srgb, #2ea043 18%, transparent)"
        : kind === "remove"
          ? "color-mix(in srgb, #f85149 18%, transparent)"
          : "transparent",
  }),
};

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;

  function useConnection() {
    return React.useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
  }

  function useChannels(session) {
    const queries = session.channels;
    React.useEffect(() => queries.ensureList(), [queries]);
    return React.useSyncExternalStore(queries.subscribeList, queries.list);
  }

  const Icon = ({ folder }) =>
    h(
      "svg",
      {
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinejoin: "round",
        style: styles.entryIcon,
        "aria-hidden": true,
      },
      h("path", {
        d: folder
          ? "M3 6h6l2 2h10v11H3z"
          : "M6 3h8l4 4v14H6zM14 3v4h4",
      }),
    );

  /** One cached git read; failures stay retryable and are not cached. */
  function useGitRead(session, cache, repo, input, attempt) {
    const key = JSON.stringify([repo.owner, repo.dtag, input]);
    const [state, setState] = React.useState(() =>
      cache.has(key)
        ? { key, status: "ready", data: cache.get(key) }
        : { key, status: "loading" },
    );
    React.useEffect(() => {
      if (cache.has(key)) {
        setState({ key, status: "ready", data: cache.get(key) });
        return undefined;
      }
      if (!session.projectGit) {
        setState({
          key,
          status: "error",
          error: "This version of Buzz can't read repository files.",
        });
        return undefined;
      }
      const controller = new AbortController();
      setState({ key, status: "loading" });
      session.projectGit
        .read({ owner: repo.owner, dtag: repo.dtag, ...input }, controller.signal)
        .then(
          (data) => {
            if (controller.signal.aborted) return;
            cache.set(key, data);
            setState({ key, status: "ready", data });
          },
          (error) => {
            if (controller.signal.aborted) return;
            setState({ key, status: "error", error: friendlyError(error) });
          },
        );
      return () => controller.abort();
    }, [session, key, attempt]);
    return state.key === key ? state : { key, status: "loading" };
  }

  function Pending({ read, retry, label }) {
    if (read.status === "error")
      return h(
        "div",
        { role: "alert" },
        h("p", null, read.error),
        h(
          "button",
          { type: "button", style: styles.button, onClick: retry },
          "Try again",
        ),
      );
    return h("p", { role: "status", style: styles.muted }, label);
  }

  function Breadcrumbs({ repo, path, openFolder }) {
    const parts = crumbs(path);
    return h(
      "nav",
      { "aria-label": "Folder path", style: styles.crumbs },
      h(
        "button",
        { type: "button", style: styles.link, onClick: () => openFolder("") },
        repo.name,
      ),
      parts.map((part, index) =>
        h(
          React.Fragment,
          { key: part.path },
          h("span", { style: { opacity: 0.5 } }, "/"),
          index === parts.length - 1
            ? h("span", { style: { overflowWrap: "anywhere" } }, part.name)
            : h(
                "button",
                {
                  type: "button",
                  style: styles.link,
                  onClick: () => openFolder(part.path),
                },
                part.name,
              ),
        ),
      ),
    );
  }

  function FileRow({ first, label, size, onClick }) {
    return h(
      "button",
      { type: "button", style: styles.entry(first), onClick },
      h(Icon, { folder: false }),
      h("span", { style: styles.entryName }, label),
      h("span", { style: styles.entrySize }, formatSize(size)),
    );
  }

  function FolderView({ repo, snapshot, dir, openFolder, openFile }) {
    const [query, setQuery] = React.useState("");
    const results = React.useMemo(
      () => searchFiles(snapshot.files, query),
      [snapshot, query],
    );
    const listing = React.useMemo(
      () => listFolder(snapshot.files, dir),
      [snapshot, dir],
    );
    const search = h("input", {
      style: styles.input,
      type: "search",
      placeholder: "Go to file",
      "aria-label": "Go to file",
      value: query,
      onChange: (event) => setQuery(event.target.value),
    });
    if (!snapshot.files.length)
      return h("p", null, "This repository has no files yet.");
    if (query.trim())
      return h(
        React.Fragment,
        null,
        search,
        results.length
          ? h(
              "div",
              { style: styles.table },
              results.map((file, index) =>
                h(FileRow, {
                  key: file.path,
                  first: index === 0,
                  label: file.path,
                  size: file.size,
                  onClick: () => openFile(file.path),
                }),
              ),
            )
          : h("p", null, "No files match that search."),
      );
    return h(
      React.Fragment,
      null,
      search,
      h(Breadcrumbs, { repo, path: dir, openFolder }),
      h(
        "div",
        { style: styles.table },
        dir
          ? h(
              "button",
              {
                type: "button",
                style: styles.entry(true),
                onClick: () => openFolder(parentOf(dir)),
              },
              h("span", { style: styles.entryIcon }),
              h("span", { style: styles.entryName }, ".."),
            )
          : null,
        listing.folders.map((folder, index) =>
          h(
            "button",
            {
              key: folder.path,
              type: "button",
              style: styles.entry(!dir && index === 0),
              onClick: () => openFolder(folder.path),
            },
            h(Icon, { folder: true }),
            h("span", { style: styles.entryName }, folder.name),
            h(
              "span",
              { style: styles.entrySize },
              `${folder.count} file${folder.count === 1 ? "" : "s"}`,
            ),
          ),
        ),
        listing.files.map((file, index) =>
          h(FileRow, {
            key: file.path,
            first: !dir && !listing.folders.length && index === 0,
            label: file.name,
            size: file.size,
            onClick: () => openFile(file.path),
          }),
        ),
      ),
      !dir && snapshot.readme
        ? h(
            "section",
            {
              "aria-label": "README",
              style: { ...styles.table, marginTop: 16 },
            },
            h("pre", { style: styles.readme }, snapshot.readme),
          )
        : null,
    );
  }

  function FileView({ session, cache, repo, path, openFolder }) {
    const [attempt, setAttempt] = React.useState(0);
    const read = useGitRead(session, cache, repo, { path }, attempt);
    const file = read.status === "ready" ? read.data.file : null;
    const lines = React.useMemo(() => {
      if (!file || file.content === null) return "";
      const count = file.content.replace(/\n$/, "").split("\n").length;
      return Array.from({ length: count }, (_, index) => index + 1).join("\n");
    }, [file]);
    return h(
      React.Fragment,
      null,
      h(Breadcrumbs, { repo, path, openFolder }),
      read.status !== "ready"
        ? h(Pending, {
            read,
            label: "Loading file…",
            retry: () => setAttempt((value) => value + 1),
          })
        : !file
          ? h("p", null, "That file isn't available.")
          : file.content === null
            ? h(
                "p",
                null,
                `This is a binary file or too large to show (${formatSize(file.size)}).`,
              )
            : h(
                "div",
                { style: styles.code },
                h("pre", { style: styles.gutter, "aria-hidden": true }, lines),
                h("pre", { style: styles.source }, file.content),
              ),
    );
  }

  function CommitList({ snapshot, openCommit }) {
    if (!snapshot.commits.length) return h("p", null, "No commits yet.");
    return h(
      "div",
      { style: styles.table },
      snapshot.commits.map((commit, index) =>
        h(
          "button",
          {
            key: commit.hash,
            type: "button",
            style: styles.entry(index === 0),
            onClick: () => openCommit(commit),
          },
          h("span", { style: styles.entryName }, commit.subject),
          h(
            "span",
            { style: styles.entrySize },
            `${commit.author} · ${new Date(commit.date * 1000).toLocaleDateString()} · ${commit.hash.slice(0, 7)}`,
          ),
        ),
      ),
    );
  }

  function CommitView({ session, cache, repo, commit, back }) {
    const [attempt, setAttempt] = React.useState(0);
    const read = useGitRead(
      session,
      cache,
      repo,
      { commit: commit.hash },
      attempt,
    );
    const lines = React.useMemo(
      () => (read.status === "ready" ? (read.data.diff || "").split("\n") : []),
      [read],
    );
    const shown = lines.slice(0, DIFF_LINE_LIMIT);
    return h(
      React.Fragment,
      null,
      h(
        "p",
        { style: styles.crumbs },
        h("button", { type: "button", style: styles.link, onClick: back }, "Commits"),
        h("span", { style: { opacity: 0.5 } }, "/"),
        h("span", { style: { overflowWrap: "anywhere" } }, commit.subject),
      ),
      read.status !== "ready"
        ? h(Pending, {
            read,
            label: "Loading changes…",
            retry: () => setAttempt((value) => value + 1),
          })
        : h(
            React.Fragment,
            null,
            h(
              "div",
              { style: styles.diff },
              shown.map((line, index) =>
                h(
                  "div",
                  { key: index, style: styles.diffLine(diffKind(line)) },
                  line,
                ),
              ),
            ),
            lines.length > shown.length
              ? h(
                  "p",
                  { style: styles.muted },
                  `Showing the first ${DIFF_LINE_LIMIT} of ${lines.length} lines.`,
                )
              : null,
          ),
    );
  }

  function RepoBrowser({ session, cache, repo, scope, back }) {
    const [view, setView] = React.useState({ tab: "files", dir: "" });
    const [attempt, setAttempt] = React.useState(0);
    const read = useGitRead(session, cache, repo, {}, attempt);
    const go = (next) => setView(next);
    const openFolder = (dir) => go({ tab: "files", dir });
    const openFile = (path) =>
      go({ tab: "files", dir: parentOf(path), file: path });
    const refresh = () => {
      for (const key of [...cache.keys()])
        if (key.startsWith(JSON.stringify([repo.owner, repo.dtag]).slice(0, -1)))
          cache.delete(key);
      setAttempt((value) => value + 1);
    };
    const openInBuzz = (tab) =>
      void ctx.navigation.open({
        version: 1,
        kind: "page",
        pluginId: "buzz.repos",
        pageId: "repos",
        scope,
        route: {
          version: 1,
          params: { type: "repo", owner: repo.owner, dtag: repo.dtag, tab },
        },
      });
    const tabButton = (tab, label) =>
      h(
        "button",
        {
          type: "button",
          style: styles.tab(view.tab === tab),
          "aria-current": view.tab === tab ? "page" : undefined,
          onClick: () => go(tab === "files" ? { tab, dir: "" } : { tab }),
        },
        label,
      );
    let body;
    if (read.status !== "ready")
      body = h(Pending, {
        read,
        label: "Loading repository… this can take a few seconds.",
        retry: () => setAttempt((value) => value + 1),
      });
    else if (view.tab === "commits" && view.commit)
      body = h(CommitView, {
        session,
        cache,
        repo,
        commit: view.commit,
        back: () => go({ tab: "commits" }),
      });
    else if (view.tab === "commits")
      body = h(CommitList, {
        snapshot: read.data,
        openCommit: (commit) => go({ tab: "commits", commit }),
      });
    else if (view.file)
      body = h(FileView, {
        session,
        cache,
        repo,
        path: view.file,
        openFolder,
      });
    else
      body = h(FolderView, {
        key: view.dir,
        repo,
        snapshot: read.data,
        dir: view.dir,
        openFolder,
        openFile,
      });
    return h(
      "div",
      { style: styles.scroll },
      h(
        "div",
        { style: styles.page },
        h(
          "p",
          { style: { margin: "0 0 10px" } },
          h("button", { type: "button", style: styles.link, onClick: back }, "← Projects"),
        ),
        h(
          "div",
          { style: styles.header },
          h("h1", { style: styles.title }, repo.name),
          h(
            "button",
            { type: "button", style: styles.button, onClick: refresh },
            "Refresh",
          ),
        ),
        repo.description
          ? h("p", { style: { ...styles.muted, marginBottom: 12 } }, repo.description)
          : null,
        h(
          "div",
          { style: styles.tabs },
          tabButton("files", "Files"),
          tabButton("commits", "Commits"),
          h(
            "button",
            {
              type: "button",
              style: styles.tab(false),
              onClick: () => openInBuzz("prs"),
            },
            "Pull requests ↗",
          ),
          h(
            "button",
            {
              type: "button",
              style: styles.tab(false),
              onClick: () => openInBuzz("issues"),
            },
            "Issues ↗",
          ),
        ),
        body,
      ),
    );
  }

  function RepoRows({ repos, openRepo }) {
    return h(
      "ul",
      { style: styles.list },
      repos.map((repo) =>
        h(
          "li",
          { key: repo.address, style: styles.repoRow },
          h(
            "button",
            { type: "button", style: styles.link, onClick: () => openRepo(repo) },
            repo.name,
          ),
          repo.description
            ? h("span", { style: styles.truncate }, repo.description)
            : null,
        ),
      ),
    );
  }

  function ChannelRows({ ids, names, openChannel }) {
    if (!ids.length) return null;
    return h(
      "p",
      { style: styles.muted },
      "Channels: ",
      ids.map((id, index) =>
        h(
          React.Fragment,
          { key: id },
          index ? ", " : "",
          h(
            "button",
            {
              type: "button",
              style: { ...styles.link, fontWeight: 400 },
              onClick: () => openChannel(id),
            },
            names.get(id) || "Linked channel",
          ),
        ),
      ),
    );
  }

  function ProjectsFeature({ session, scope }) {
    const [state, setState] = React.useState({ status: "loading" });
    const [query, setQuery] = React.useState("");
    const [attempt, setAttempt] = React.useState(0);
    const [repo, setRepo] = React.useState(null);
    const cache = React.useRef(new Map()).current;
    const channels = useChannels(session);

    React.useEffect(() => {
      let live = true;
      setState((held) => (held.model ? held : { status: "loading" }));
      loadModel(session).then(
        (model) => live && setState({ status: "ready", model }),
        (error) =>
          live &&
          setState({
            status: "error",
            error: error && error.message ? error.message : String(error),
          }),
      );
      return () => {
        live = false;
      };
    }, [session, attempt]);

    const names = React.useMemo(
      () => new Map(channels.channels.map((c) => [c.id, c.name])),
      [channels],
    );
    const openChannel = (channelId) =>
      void ctx.navigation.open({
        version: 1,
        kind: "conversation",
        scope,
        channelId,
      });

    if (repo)
      return h(RepoBrowser, {
        key: repo.address,
        session,
        cache,
        repo,
        scope,
        back: () => setRepo(null),
      });

    const frame = (...children) =>
      h("div", { style: styles.scroll }, h("div", { style: styles.page }, ...children));
    const header = h(
      "div",
      { style: styles.header },
      h("h1", { style: styles.title }, "Projects"),
      h(
        "button",
        {
          type: "button",
          style: styles.button,
          onClick: () => setAttempt((value) => value + 1),
        },
        "Refresh",
      ),
    );
    if (state.status === "loading")
      return frame(header, h("p", { role: "status" }, "Loading…"));
    if (state.status === "error")
      return frame(
        header,
        h("p", { role: "alert" }, "Couldn't load projects: ", state.error),
      );

    const model = filterModel(state.model, query);
    const empty = !model.projects.length && !model.unassigned.length;
    return frame(
      header,
      h("input", {
        style: styles.input,
        type: "search",
        placeholder: "Search projects and repositories",
        "aria-label": "Search projects and repositories",
        value: query,
        onChange: (event) => setQuery(event.target.value),
      }),
      state.model.capped
        ? h(
            "p",
            { style: styles.muted },
            `Showing the first ${READ_LIMIT} records; some may be missing.`,
          )
        : null,
      empty
        ? h(
            "p",
            null,
            query ? "Nothing matches that search." : "No projects found.",
          )
        : null,
      model.projects.map((project) => {
        const ids = [
          ...new Set(
            [project.channelId, ...project.repos.map((r) => r.channelId)].filter(
              Boolean,
            ),
          ),
        ];
        return h(
          "section",
          { key: project.address, className: "ui-card", style: styles.card },
          h("h2", { style: styles.name }, project.name),
          project.description
            ? h("p", { style: styles.muted }, project.description)
            : null,
          h(ChannelRows, { ids, names, openChannel }),
          h(RepoRows, { repos: project.repos, openRepo: setRepo }),
          project.missing
            ? h(
                "p",
                { style: styles.muted },
                `${project.missing} repository link${project.missing === 1 ? "" : "s"} unavailable`,
              )
            : null,
        );
      }),
      model.unassigned.length
        ? h(
            React.Fragment,
            null,
            h("h2", { style: styles.section }, "Other repositories"),
            h(
              "section",
              { className: "ui-card", style: styles.card },
              h(RepoRows, { repos: model.unassigned, openRepo: setRepo }),
            ),
          )
        : null,
    );
  }

  function ProjectsPage() {
    const connection = useConnection();
    if (connection.status !== "ready" || !connection.origin || !connection.viewer)
      return h(
        "div",
        { style: styles.page },
        h("p", null, connection.error || "Connecting to your community…"),
      );
    return h(ProjectsFeature, {
      key: `${connection.scope}:${connection.generation}`,
      session: connection.session,
      scope: {
        viewer: connection.viewer,
        communityOrigin: connection.origin,
      },
    });
  }

  ctx.pages.register({
    id: "projects",
    title: "Projects",
    layout: "document",
    primary: true,
    icon: `data:image/svg+xml;base64,${btoa(ICON)}`,
    component: ProjectsPage,
  });
}

export const inject = ["react", "pages", "relay", "navigation"];
