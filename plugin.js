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
      clone: all(item.event, "clone"),
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
    .sort(
      (a, b) =>
        Number(!a.repos.length) - Number(!b.repos.length) ||
        a.name.localeCompare(b.name),
    );
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

export function ancestors(path) {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

/** Visible tree rows, walking only into expanded folders. */
export function treeRows(files, expanded) {
  const rows = [];
  const walk = (dir, depth) => {
    const listing = listFolder(files, dir);
    for (const folder of listing.folders) {
      const open = expanded.has(folder.path);
      rows.push({ type: "folder", name: folder.name, path: folder.path, depth, open });
      if (open) walk(folder.path, depth + 1);
    }
    for (const file of listing.files)
      rows.push({ type: "file", name: file.name, path: file.path, depth });
  };
  walk("", 0);
  return rows;
}

export const isMarkdown = (path) => /\.(md|markdown|mdx)$/i.test(path);

export function relativeTime(seconds, now = Date.now() / 1000) {
  const age = Math.max(0, now - seconds);
  const units = [
    [31536000, "year"],
    [2592000, "month"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    const count = Math.floor(age / size);
    if (count >= 1) return `${count} ${name}${count === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

export function dayLabel(seconds, now = Date.now() / 1000) {
  const date = new Date(seconds * 1000);
  const today = new Date(now * 1000);
  const day = (value) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(today) - day(date)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

export function groupCommits(commits, now) {
  const groups = [];
  for (const commit of commits) {
    const label = dayLabel(commit.date, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.commits.push(commit);
    else groups.push({ label, commits: [commit] });
  }
  return groups;
}

/** Split `git show` output into its message and one section per changed file. */
export function parseDiff(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("diff --git "));
  const intro = start < 0 ? lines : lines.slice(0, start);
  const body = intro.findIndex((line) => line.startsWith("    "));
  const message =
    body < 0
      ? ""
      : intro
          .slice(body)
          .map((line) => line.replace(/^ {4}/, ""))
          .join("\n")
          .trim();
  const files = [];
  let file = null;
  for (const line of start < 0 ? [] : lines.slice(start)) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      file = {
        path: match ? match[2] : line.slice(11),
        additions: 0,
        deletions: 0,
        binary: false,
        lines: [],
      };
      files.push(file);
    } else if (file) {
      if (/^(index |new file|deleted file|old mode|new mode|similarity|rename )/.test(line))
        continue;
      if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
      if (line.startsWith("Binary files ")) {
        file.binary = true;
        continue;
      }
      const kind = diffKind(line);
      if (kind === "add") file.additions += 1;
      if (kind === "remove") file.deletions += 1;
      file.lines.push({ kind, text: line });
    }
  }
  for (const entry of files)
    while (entry.lines.length && !entry.lines[entry.lines.length - 1].text)
      entry.lines.pop();
  return { message, files };
}

const safeUrl = (url) => (/^https?:\/\//i.test(url) ? url : null);

export function inlineTokens(text) {
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|\b_[^_\s][^_]*_\b)|(!?\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\))/g;
  const tokens = [];
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > index)
      tokens.push({ type: "text", text: text.slice(index, match.index) });
    const value = match[0];
    if (match[1]) tokens.push({ type: "code", text: value.slice(1, -1) });
    else if (match[2]) tokens.push({ type: "bold", text: value.slice(2, -2) });
    else if (match[3]) tokens.push({ type: "italic", text: value.slice(1, -1) });
    else {
      const link = /^(!?)\[([^\]]*)\]\(([^)\s]+)/.exec(value);
      if (link[1]) tokens.push({ type: "text", text: link[2] ? `[${link[2]}]` : "" });
      else if (safeUrl(link[3]))
        tokens.push({ type: "link", text: link[2], href: link[3] });
      else tokens.push({ type: "text", text: link[2] });
    }
    index = match.index + value.length;
  }
  if (index < text.length) tokens.push({ type: "text", text: text.slice(index) });
  return tokens;
}

/** A small, safe Markdown subset. Raw HTML is dropped, never rendered. */
export function parseMarkdown(text) {
  const lines = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const blocks = [];
  const clean = (line) => line.replace(/<\/?[a-zA-Z][^>]*>/g, "").trim();
  const row = (line) =>
    line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1]))
        body.push(lines[index++]);
      index += 1;
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    if (!clean(line)) {
      index += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: clean(heading[2]) });
      index += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }
    if (
      line.includes("|") &&
      index + 1 < lines.length &&
      /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[index + 1]) &&
      lines[index + 1].includes("-") &&
      lines[index + 1].includes("|")
    ) {
      const head = row(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && clean(lines[index]))
        rows.push(row(lines[index++]));
      blocks.push({ type: "table", head, rows });
      continue;
    }
    const listItem = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;
    const item = listItem.exec(line);
    if (item) {
      const ordered = Boolean(item[2]);
      const items = [];
      while (index < lines.length) {
        const match = listItem.exec(lines[index]);
        if (match && Boolean(match[2]) === ordered) {
          items.push(clean(match[3]));
          index += 1;
        } else if (items.length && /^\s{2,}\S/.test(lines[index])) {
          items[items.length - 1] += ` ${clean(lines[index])}`;
          index += 1;
        } else break;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (index < lines.length && /^\s*>/.test(lines[index]))
        body.push(clean(lines[index++].replace(/^\s*>\s?/, "")));
      blocks.push({ type: "quote", text: body.join(" ") });
      continue;
    }
    const body = [];
    while (
      index < lines.length &&
      clean(lines[index]) &&
      !/^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[index])
    )
      body.push(clean(lines[index++]));
    if (body.length) blocks.push({ type: "paragraph", text: body.join(" ") });
    else index += 1;
  }
  return blocks;
}

export function cloneUrl(repo, origin) {
  const own = `${origin.replace(/\/$/, "")}/git/${repo.owner}/${repo.dtag}.git`;
  const clones = repo.clone || [];
  return clones.find((url) => url === own) || clones[0] || own;
}

export function friendlyError(error) {
  const status = error && error.status;
  if (error && error.kind === "denied")
    return {
      title: "You don't have access to these files",
      detail: "Ask to join the channel linked to this repository.",
    };
  if (status === 404)
    return {
      title: "That file isn't available",
      detail: "It may have moved or been deleted in the latest commit.",
    };
  if (status === 503 || status === 504)
    return {
      title: "This took too long to load",
      detail:
        "Buzz stops waiting after about 12 seconds. It often works on a second try.",
    };
  return {
    title: "This couldn't be loaded",
    detail: "Check your connection and try again.",
  };
}

function readRecent(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeRecent(key, values) {
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // Recents are a convenience; private storage modes may refuse them.
  }
}

export const nextRecent = (recent, address, limit = 4) =>
  [address, ...recent.filter((item) => item !== address)].slice(0, limit);

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" stroke-linejoin="round"><path d="M3 6h6l2 2h10v11H3z"/></svg>';
const DIFF_LINE_LIMIT = 4000;
const PANEL_TARGET = "sprig-projects:browse";
const WIDE_LAYOUT = 760;
const SLOW_AFTER_MS = 4000;

// Scoped to this plugin's root. Hover, focus and motion can't be inline styles.
const CSS = `
[data-sprig-projects] {
  --sp-line: color-mix(in srgb, currentColor 14%, transparent);
  --sp-hover: color-mix(in srgb, currentColor 7%, transparent);
  --sp-selected: color-mix(in srgb, currentColor 12%, transparent);
  --sp-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  height: 100%; width: 100%;
}
[data-sprig-projects] *, [data-sprig-projects] *::before { box-sizing: border-box; }
.sp-scroll { height: 100%; width: 100%; overflow-y: auto; scrollbar-gutter: stable; }
.sp-page { padding: 20px clamp(14px, 4vw, 32px) 48px; margin: 0 auto; width: 100%; max-width: 920px; }
.sp-page.sp-wide { max-width: 1320px; }
.sp-compact .sp-page { padding: 10px 12px 24px; }
.sp-compact .sp-header { gap: 6px; margin-bottom: 8px; }
.sp-compact .sp-header h1 { font-size: 15px; }
.sp-compact .sp-card-body, .sp-compact .sp-card-head { padding: 0 6px; }
.sp-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.sp-header h1 { margin: 0; font-size: 20px; line-height: 1.3; min-width: 0; overflow-wrap: anywhere; }
.sp-header h1.sp-grow { flex: 1 1 140px; }
.sp-grow { flex: 1; min-width: 0; }
.sp-muted { opacity: .68; font-size: 13px; margin: 2px 0 0; }
.sp-oneline { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.sp-btn { padding: 5px 10px; border-radius: 7px; border: 1px solid var(--sp-line); background: transparent; color: inherit; font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
.sp-btn:hover { background: var(--sp-hover); }
.sp-btn[aria-pressed="true"] { background: var(--sp-selected); }
.sp-back { background: none; border: none; padding: 4px 6px 4px 0; color: inherit; font: inherit; font-size: 13px; opacity: .72; cursor: pointer; white-space: nowrap; }
.sp-back:hover { opacity: 1; }
.sp-input { width: 100%; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--sp-line); background: transparent; color: inherit; font: inherit; }
.sp-section { font-size: 12px; font-weight: 600; letter-spacing: .02em; opacity: .66; margin: 20px 0 6px; }
.sp-card { padding: 12px 8px 8px; margin-bottom: 12px; }
.sp-card-head { display: flex; gap: 10px; align-items: baseline; padding: 0 8px; }
.sp-card-head h2 { font-size: 15px; font-weight: 600; margin: 0; min-width: 0; }
.sp-card-body { padding: 0 8px; }
.sp-row { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; padding: 6px 8px; border: none; border-radius: 7px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.sp-row:hover { background: var(--sp-hover); }
.sp-row[aria-current="true"], .sp-row[aria-selected="true"] { background: var(--sp-selected); }
.sp-row-name { font-weight: 500; flex-shrink: 0; max-width: 60%; }
.sp-chevron { opacity: .4; flex-shrink: 0; }
.sp-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 8px 2px; }
.sp-chip { padding: 2px 8px; border-radius: 999px; border: 1px solid var(--sp-line); background: none; color: inherit; font: inherit; font-size: 12px; cursor: pointer; max-width: 100%; }
.sp-chip:hover { background: var(--sp-hover); }
.sp-tabs { display: flex; gap: 2px; align-items: center; box-shadow: inset 0 -1px 0 var(--sp-line); margin-bottom: 12px; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
.sp-tab { padding: 6px 10px; background: none; border: none; border-bottom: 2px solid transparent; color: inherit; font: inherit; font-size: 13px; opacity: .7; cursor: pointer; white-space: nowrap; }
.sp-tab:hover { opacity: 1; }
.sp-tab[aria-current="page"] { opacity: 1; font-weight: 600; border-bottom-color: currentColor; }
.sp-split { display: flex; gap: 16px; align-items: flex-start; }
.sp-aside { width: 270px; flex-shrink: 0; position: sticky; top: 8px; max-height: calc(100vh - 24px); display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.sp-main { flex: 1; min-width: 0; }
.sp-tree { overflow: auto; min-height: 0; flex: 1; border: 1px solid var(--sp-line); border-radius: 8px; padding: 4px; }
.sp-tree-row { display: flex; align-items: center; gap: 4px; min-width: 0; width: 100%; border-radius: 6px; }
.sp-tree-row:hover { background: var(--sp-hover); }
.sp-tree-row[data-selected="true"] { background: var(--sp-selected); }
.sp-tree-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 3px 4px; background: none; border: none; color: inherit; font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.sp-twist { width: 18px; height: 22px; flex-shrink: 0; padding: 0; background: none; border: none; color: inherit; cursor: pointer; opacity: .55; font-size: 10px; }
.sp-crumbs { display: flex; flex-wrap: wrap; gap: 2px 4px; align-items: baseline; margin: 0 0 8px; font-size: 13.5px; min-width: 0; }
.sp-crumb { background: none; border: none; padding: 0; color: inherit; font: inherit; opacity: .75; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.sp-crumb:hover { opacity: 1; }
.sp-list { border: 1px solid var(--sp-line); border-radius: 8px; overflow: hidden; padding: 3px; }
.sp-size { font-size: 12px; opacity: .6; flex-shrink: 0; white-space: nowrap; }
.sp-icon { width: 15px; height: 15px; flex-shrink: 0; opacity: .7; }
.sp-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.sp-code { display: flex; border: 1px solid var(--sp-line); border-radius: 8px; overflow-x: auto; font-family: var(--sp-mono); font-size: 12.5px; line-height: 1.55; }
.sp-gutter { margin: 0; padding: 10px; text-align: right; user-select: none; position: sticky; left: 0; flex-shrink: 0; font-family: inherit; color: color-mix(in srgb, currentColor 45%, transparent); background: var(--sp-surface, Canvas); border-right: 1px solid var(--sp-line); }
.sp-source { margin: 0; padding: 10px 12px; font-family: inherit; flex: 1; min-width: 0; white-space: pre; tab-size: 4; }
.sp-code[data-wrap="true"] .sp-source { white-space: pre-wrap; overflow-wrap: anywhere; }
.sp-code[data-wrap="true"] .sp-gutter { display: none; }
.sp-doc { border: 1px solid var(--sp-line); border-radius: 8px; padding: 14px 20px; line-height: 1.6; font-size: 14px; overflow-wrap: anywhere; }
.sp-doc > :first-child { margin-top: 0; }
.sp-doc > :last-child { margin-bottom: 0; }
.sp-doc h1, .sp-doc h2 { padding-bottom: 4px; border-bottom: 1px solid var(--sp-line); margin: 20px 0 10px; }
.sp-doc h1 { font-size: 21px; } .sp-doc h2 { font-size: 17px; } .sp-doc h3 { font-size: 15px; margin: 16px 0 6px; } .sp-doc h4, .sp-doc h5, .sp-doc h6 { font-size: 14px; margin: 14px 0 6px; }
.sp-doc p, .sp-doc ul, .sp-doc ol, .sp-doc blockquote, .sp-doc table { margin: 0 0 10px; }
.sp-doc ul, .sp-doc ol { padding-left: 22px; }
.sp-doc blockquote { padding-left: 12px; border-left: 3px solid var(--sp-line); opacity: .8; }
.sp-doc code { font-family: var(--sp-mono); font-size: .88em; padding: 1px 4px; border-radius: 4px; background: var(--sp-hover); }
.sp-doc pre { font-family: var(--sp-mono); font-size: 12.5px; padding: 10px 12px; border-radius: 7px; background: var(--sp-hover); overflow-x: auto; margin: 0 0 10px; }
.sp-doc pre code { background: none; padding: 0; font-size: inherit; }
.sp-doc hr { border: none; border-top: 1px solid var(--sp-line); margin: 14px 0; }
.sp-doc a { color: inherit; text-underline-offset: 2px; }
.sp-doc table { border-collapse: collapse; display: block; overflow-x: auto; }
.sp-doc th, .sp-doc td { border: 1px solid var(--sp-line); padding: 4px 8px; text-align: left; }
.sp-notice { border: 1px solid var(--sp-line); border-radius: 8px; padding: 14px 16px; }
.sp-notice h2 { font-size: 14.5px; margin: 0 0 2px; }
.sp-notice .sp-btn { margin-top: 10px; }
.sp-skeleton { height: 30px; margin: 3px 0; border-radius: 6px; background: var(--sp-hover); animation: sp-pulse 1.3s ease-in-out infinite; }
@keyframes sp-pulse { 50% { opacity: .45; } }
.sp-diff { border: 1px solid var(--sp-line); border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
.sp-diff summary { display: flex; gap: 10px; align-items: center; padding: 7px 12px; cursor: pointer; font-size: 13px; font-family: var(--sp-mono); }
.sp-diff summary:hover { background: var(--sp-hover); }
.sp-diff-body { overflow-x: auto; border-top: 1px solid var(--sp-line); padding: 6px 0; font-family: var(--sp-mono); font-size: 12.5px; line-height: 1.5; }
.sp-line { white-space: pre; padding: 0 12px; min-height: 1.5em; width: max-content; min-width: 100%; }
.sp-line[data-kind="add"] { background: color-mix(in srgb, #2ea043 18%, transparent); }
.sp-line[data-kind="remove"] { background: color-mix(in srgb, #f85149 18%, transparent); }
.sp-line[data-kind="meta"] { opacity: .6; }
.sp-add { color: #2ea043; } .sp-del { color: #e5534b; }
.sp-kbd { font-size: 11px; opacity: .6; border: 1px solid var(--sp-line); border-radius: 4px; padding: 0 4px; }
[data-sprig-projects] button:focus-visible, [data-sprig-projects] input:focus-visible, [data-sprig-projects] summary:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
@media (prefers-reduced-motion: reduce) { .sp-skeleton { animation: none; } }
`;

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;
  const useMeasure = React.useLayoutEffect || React.useEffect;
  // Shared by the page and the side panel, so switching keeps your place.
  const memories = new Map();
  const memoryFor = (key) => {
    if (!memories.has(key))
      memories.set(key, {
        cache: new Map(),
        views: new Map(),
        repo: null,
        scrollTop: 0,
      });
    return memories.get(key);
  };

  function useConnection() {
    return React.useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
  }

  function useChannels(session) {
    const queries = session.channels;
    React.useEffect(() => queries.ensureList(), [queries]);
    return React.useSyncExternalStore(queries.subscribeList, queries.list);
  }

  function useWidth() {
    const ref = React.useRef(null);
    const [width, setWidth] = React.useState(0);
    useMeasure(() => {
      const element = ref.current;
      if (!element || typeof ResizeObserver === "undefined") return undefined;
      setWidth(element.getBoundingClientRect().width);
      const observer = new ResizeObserver((entries) =>
        setWidth(entries[0].contentRect.width),
      );
      observer.observe(element);
      return () => observer.disconnect();
    }, []);
    return [ref, width];
  }

  function useCopied() {
    const [copied, setCopied] = React.useState(false);
    const timer = React.useRef(null);
    React.useEffect(() => () => clearTimeout(timer.current), []);
    const copy = (text) => {
      if (typeof navigator === "undefined" || !navigator.clipboard) return;
      navigator.clipboard.writeText(text).then(
        () => {
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1600);
        },
        () => {},
      );
    };
    return [copied, copy];
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
        className: "sp-icon",
        "aria-hidden": true,
      },
      h("path", {
        d: folder ? "M3 6h6l2 2h10v11H3z" : "M6 3h8l4 4v14H6zM14 3v4h4",
      }),
    );

  function Inline({ text }) {
    return inlineTokens(text).map((token, index) => {
      if (token.type === "code") return h("code", { key: index }, token.text);
      if (token.type === "bold") return h("strong", { key: index }, token.text);
      if (token.type === "italic") return h("em", { key: index }, token.text);
      if (token.type === "link")
        return h(
          "a",
          {
            key: index,
            href: token.href,
            target: "_blank",
            rel: "noopener noreferrer",
          },
          token.text,
        );
      return h(React.Fragment, { key: index }, token.text);
    });
  }

  function Markdown({ text }) {
    const blocks = React.useMemo(() => parseMarkdown(text), [text]);
    return h(
      "div",
      { className: "sp-doc" },
      blocks.map((block, index) => {
        if (block.type === "heading")
          return h(`h${block.level}`, { key: index }, h(Inline, { text: block.text }));
        if (block.type === "code")
          return h("pre", { key: index }, h("code", null, block.text));
        if (block.type === "rule") return h("hr", { key: index });
        if (block.type === "quote")
          return h("blockquote", { key: index }, h(Inline, { text: block.text }));
        if (block.type === "list")
          return h(
            block.ordered ? "ol" : "ul",
            { key: index },
            block.items.map((item, position) =>
              h("li", { key: position }, h(Inline, { text: item })),
            ),
          );
        if (block.type === "table")
          return h(
            "table",
            { key: index },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                block.head.map((cell, position) =>
                  h("th", { key: position }, h(Inline, { text: cell })),
                ),
              ),
            ),
            h(
              "tbody",
              null,
              block.rows.map((row, rowIndex) =>
                h(
                  "tr",
                  { key: rowIndex },
                  row.map((cell, position) =>
                    h("td", { key: position }, h(Inline, { text: cell })),
                  ),
                ),
              ),
            ),
          );
        return h("p", { key: index }, h(Inline, { text: block.text }));
      }),
    );
  }

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
          error: {
            title: "Files aren't available here",
            detail: "This version of Buzz can't read repository files.",
          },
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

  function Pending({ read, retry, rows = 6 }) {
    const [slow, setSlow] = React.useState(false);
    const loading = read.status !== "error";
    React.useEffect(() => {
      if (!loading) return undefined;
      setSlow(false);
      const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
      return () => clearTimeout(timer);
    }, [loading]);
    if (!loading)
      return h(
        "div",
        { className: "sp-notice", role: "alert" },
        h("h2", null, read.error.title),
        h("p", { className: "sp-muted" }, read.error.detail),
        h(
          "button",
          { type: "button", className: "sp-btn", onClick: retry },
          "Try again",
        ),
      );
    return h(
      "div",
      { role: "status", "aria-label": "Loading" },
      h(
        "p",
        { className: "sp-muted", style: { marginBottom: 6 } },
        slow ? "Still loading. This can take up to 12 seconds." : "Loading…",
      ),
      Array.from({ length: rows }, (_, index) =>
        h("div", { key: index, className: "sp-skeleton", "aria-hidden": true }),
      ),
    );
  }

  function Breadcrumbs({ repo, path, openFolder }) {
    const parts = crumbs(path);
    return h(
      "nav",
      { "aria-label": "Folder path", className: "sp-crumbs" },
      parts.length
        ? h(
            "button",
            { type: "button", className: "sp-crumb", onClick: () => openFolder("") },
            repo.name,
          )
        : h("span", null, repo.name),
      parts.map((part, index) =>
        h(
          React.Fragment,
          { key: part.path },
          h("span", { style: { opacity: 0.45 } }, "/"),
          index === parts.length - 1
            ? h("span", { style: { overflowWrap: "anywhere", fontWeight: 600 } }, part.name)
            : h(
                "button",
                {
                  type: "button",
                  className: "sp-crumb",
                  onClick: () => openFolder(part.path),
                },
                part.name,
              ),
        ),
      ),
    );
  }

  function FileSearch({ files, query, setQuery, openFile, globalKeys }) {
    const input = React.useRef(null);
    const [active, setActive] = React.useState(0);
    const results = React.useMemo(() => searchFiles(files, query), [files, query]);
    React.useEffect(() => setActive(0), [query]);
    React.useEffect(() => {
      if (!globalKeys || typeof document === "undefined") return undefined;
      const onKey = (event) => {
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName || "");
        if (event.key === "/" && !typing && !event.target.isContentEditable) {
          event.preventDefault();
          if (input.current) input.current.focus();
        }
      };
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, [globalKeys]);
    const onKeyDown = (event) => {
      if (event.key === "Escape") setQuery("");
      else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((value) => Math.min(value + 1, results.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((value) => Math.max(value - 1, 0));
      } else if (event.key === "Enter" && results[active]) {
        openFile(results[active].path);
        setQuery("");
      }
    };
    return h(
      React.Fragment,
      null,
      h("input", {
        ref: input,
        className: "sp-input",
        type: "search",
        placeholder: globalKeys ? "Go to file  ( / )" : "Go to file",
        "aria-label": "Go to file",
        value: query,
        onChange: (event) => setQuery(event.target.value),
        onKeyDown,
      }),
      query.trim()
        ? h(
            "div",
            { className: "sp-tree", role: "listbox", "aria-label": "Matching files" },
            results.length
              ? results.map((file, index) =>
                  h(
                    "button",
                    {
                      key: file.path,
                      type: "button",
                      role: "option",
                      className: "sp-row",
                      "aria-selected": index === active,
                      style: { display: "block", padding: "4px 8px" },
                      onClick: () => {
                        openFile(file.path);
                        setQuery("");
                      },
                    },
                    h("div", { className: "sp-oneline", style: { fontSize: 13 } }, file.path.split("/").pop()),
                    parentOf(file.path)
                      ? h(
                          "div",
                          { className: "sp-oneline sp-muted", style: { fontSize: 11.5, margin: 0 } },
                          parentOf(file.path),
                        )
                      : null,
                  ),
                )
              : h("p", { className: "sp-muted", style: { padding: 8, margin: 0 } }, "No files match."),
          )
        : null,
    );
  }

  function Tree({ files, selected, expanded, toggle, openFolder, openFile }) {
    const rows = React.useMemo(
      () => treeRows(files, expanded),
      [files, expanded],
    );
    return h(
      "div",
      { className: "sp-tree", role: "tree", "aria-label": "Files" },
      rows.map((row) =>
        h(
          "div",
          {
            key: row.path,
            className: "sp-tree-row",
            "data-selected": row.path === selected,
            style: { paddingLeft: row.depth * 14 },
          },
          row.type === "folder"
            ? h(
                "button",
                {
                  type: "button",
                  className: "sp-twist",
                  "aria-label": `${row.open ? "Collapse" : "Expand"} ${row.name}`,
                  "aria-expanded": row.open,
                  onClick: () => toggle(row.path),
                },
                row.open ? "▾" : "▸",
              )
            : h("span", { style: { width: 18, flexShrink: 0 } }),
          h(
            "button",
            {
              type: "button",
              className: "sp-tree-open",
              "aria-current": row.path === selected ? "true" : undefined,
              onClick: () =>
                row.type === "folder" ? openFolder(row.path) : openFile(row.path),
            },
            h(Icon, { folder: row.type === "folder" }),
            h("span", { className: "sp-oneline" }, row.name),
          ),
        ),
      ),
    );
  }

  function FolderList({ snapshot, dir, openFolder, openFile, showParent }) {
    const listing = React.useMemo(
      () => listFolder(snapshot.files, dir),
      [snapshot, dir],
    );
    return h(
      "div",
      { className: "sp-list" },
      showParent && dir
        ? h(
            "button",
            {
              type: "button",
              className: "sp-row",
              onClick: () => openFolder(parentOf(dir)),
            },
            h("span", { className: "sp-icon" }),
            h("span", { className: "sp-oneline sp-grow" }, ".."),
          )
        : null,
      listing.folders.map((folder) =>
        h(
          "button",
          {
            key: folder.path,
            type: "button",
            className: "sp-row",
            onClick: () => openFolder(folder.path),
          },
          h(Icon, { folder: true }),
          h("span", { className: "sp-oneline sp-grow" }, folder.name),
          h(
            "span",
            { className: "sp-size" },
            `${folder.count} file${folder.count === 1 ? "" : "s"}`,
          ),
        ),
      ),
      listing.files.map((file) =>
        h(
          "button",
          {
            key: file.path,
            type: "button",
            className: "sp-row",
            onClick: () => openFile(file.path),
          },
          h(Icon, { folder: false }),
          h("span", { className: "sp-oneline sp-grow" }, file.name),
          h("span", { className: "sp-size" }, formatSize(file.size)),
        ),
      ),
    );
  }

  function FileView({ session, cache, repo, path, openFolder }) {
    const [attempt, setAttempt] = React.useState(0);
    const [raw, setRaw] = React.useState(false);
    const [wrap, setWrap] = React.useState(false);
    const [copied, copy] = useCopied();
    const read = useGitRead(session, cache, repo, { path }, attempt);
    const file = read.status === "ready" ? read.data.file : null;
    const text = file && file.content !== null ? file.content : null;
    const count = React.useMemo(
      () => (text === null ? 0 : text.replace(/\n$/, "").split("\n").length),
      [text],
    );
    const gutter = React.useMemo(
      () => Array.from({ length: count }, (_, index) => index + 1).join("\n"),
      [count],
    );
    const markdown = isMarkdown(path);
    const crumbsRow = h(Breadcrumbs, { repo, path, openFolder });
    if (read.status !== "ready")
      return h(
        React.Fragment,
        null,
        crumbsRow,
        h(Pending, {
          read,
          rows: 10,
          retry: () => setAttempt((value) => value + 1),
        }),
      );
    if (!file)
      return h(React.Fragment, null, crumbsRow, h("p", null, "That file isn't available."));
    if (text === null)
      return h(
        React.Fragment,
        null,
        crumbsRow,
        h(
          "div",
          { className: "sp-notice" },
          h("h2", null, file.size > 1048576 ? "This file is too large to show" : "This file can't be shown as text"),
          h(
            "p",
            { className: "sp-muted" },
            `${formatSize(file.size)}. Clone the repository to open it.`,
          ),
        ),
      );
    return h(
      React.Fragment,
      null,
      crumbsRow,
      h(
        "div",
        { className: "sp-toolbar" },
        h(
          "span",
          { className: "sp-size sp-grow" },
          `${count} line${count === 1 ? "" : "s"} · ${formatSize(file.size)}`,
        ),
        markdown
          ? h(
              "button",
              {
                type: "button",
                className: "sp-btn",
                "aria-pressed": raw,
                onClick: () => setRaw((value) => !value),
              },
              "Source",
            )
          : null,
        !markdown || raw
          ? h(
              "button",
              {
                type: "button",
                className: "sp-btn",
                "aria-pressed": wrap,
                onClick: () => setWrap((value) => !value),
              },
              "Wrap lines",
            )
          : null,
        h(
          "button",
          { type: "button", className: "sp-btn", onClick: () => copy(text) },
          copied ? "Copied" : "Copy",
        ),
      ),
      markdown && !raw
        ? h(Markdown, { text })
        : h(
            "div",
            { className: "sp-code", "data-wrap": wrap },
            h("pre", { className: "sp-gutter", "aria-hidden": true }, gutter),
            h("pre", { className: "sp-source" }, text),
          ),
    );
  }

  function FilesPane({ session, cache, repo, snapshot, view, go, wide, globalKeys }) {
    const [query, setQuery] = React.useState("");
    const expanded = React.useMemo(
      () => new Set(view.expanded || []),
      [view.expanded],
    );
    const withOpen = (path) => [
      ...new Set([...(view.expanded || []), ...ancestors(path)]),
    ];
    const openFolder = (dir) =>
      go({
        dir,
        file: undefined,
        expanded: dir ? [...new Set([...withOpen(dir), dir])] : view.expanded,
      });
    const openFile = (path) =>
      go({ dir: parentOf(path), file: path, expanded: withOpen(path) });
    const toggle = (path) =>
      go({
        expanded: expanded.has(path)
          ? [...expanded].filter((item) => item !== path)
          : [...expanded, path],
      });
    if (!snapshot.files.length)
      return h(
        "div",
        { className: "sp-notice" },
        h("h2", null, "This repository is empty"),
        h("p", { className: "sp-muted" }, "Push a first commit and its files will show up here."),
      );
    const search = h(FileSearch, {
      files: snapshot.files,
      query,
      setQuery,
      openFile,
      globalKeys,
    });
    const searching = query.trim().length > 0;
    const showTree = wide && !view.hideTree;
    const main = view.file
      ? h(FileView, {
          key: view.file,
          session,
          cache,
          repo,
          path: view.file,
          openFolder,
        })
      : h(
          React.Fragment,
          null,
          h(Breadcrumbs, { repo, path: view.dir, openFolder }),
          h(FolderList, {
            snapshot,
            dir: view.dir,
            openFolder,
            openFile,
            showParent: !showTree,
          }),
          !view.dir && snapshot.readme
            ? h(
                "section",
                { "aria-label": "README", style: { marginTop: 14 } },
                h(Markdown, { text: snapshot.readme }),
              )
            : null,
        );
    if (!wide)
      return h(
        React.Fragment,
        null,
        h("div", { style: { marginBottom: 10 } }, search),
        searching ? null : main,
      );
    return h(
      "div",
      { className: "sp-split" },
      showTree
        ? h(
            "aside",
            { className: "sp-aside" },
            search,
            searching
              ? null
              : h(Tree, {
                  files: snapshot.files,
                  selected: view.file || view.dir,
                  expanded,
                  toggle,
                  openFolder,
                  openFile,
                }),
          )
        : null,
      h(
        "div",
        { className: "sp-main" },
        main,
      ),
    );
  }

  function CommitList({ snapshot, openCommit }) {
    const groups = React.useMemo(
      () => groupCommits(snapshot.commits),
      [snapshot],
    );
    if (!snapshot.commits.length)
      return h(
        "div",
        { className: "sp-notice" },
        h("h2", null, "No commits yet"),
      );
    return h(
      React.Fragment,
      null,
      groups.map((group) =>
        h(
          "section",
          { key: group.label },
          h("h2", { className: "sp-section", style: { marginTop: 12 } }, group.label),
          h(
            "div",
            { className: "sp-list" },
            group.commits.map((commit) =>
              h(
                "button",
                {
                  key: commit.hash,
                  type: "button",
                  className: "sp-row",
                  onClick: () => openCommit(commit),
                },
                h("span", { className: "sp-oneline sp-grow" }, commit.subject),
                h(
                  "span",
                  { className: "sp-size", title: new Date(commit.date * 1000).toLocaleString() },
                  `${commit.author} · ${relativeTime(commit.date)}`,
                ),
              ),
            ),
          ),
        ),
      ),
      h(
        "p",
        { className: "sp-muted", style: { marginTop: 10 } },
        `Showing the latest ${snapshot.commits.length} commit${snapshot.commits.length === 1 ? "" : "s"}.`,
      ),
    );
  }

  function CommitView({ session, cache, repo, commit, back }) {
    const [attempt, setAttempt] = React.useState(0);
    const read = useGitRead(session, cache, repo, { commit: commit.hash }, attempt);
    const diff = React.useMemo(
      () => parseDiff(read.status === "ready" ? read.data.diff || "" : ""),
      [read.status, read.key],
    );
    const additions = diff.files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = diff.files.reduce((sum, file) => sum + file.deletions, 0);
    let budget = DIFF_LINE_LIMIT;
    return h(
      React.Fragment,
      null,
      h("button", { type: "button", className: "sp-back", onClick: back }, "← Commits"),
      h("h2", { style: { fontSize: 16, margin: "6px 0 2px", overflowWrap: "anywhere" } }, commit.subject),
      h(
        "p",
        { className: "sp-muted", style: { marginBottom: 12 } },
        `${commit.author} · ${relativeTime(commit.date)} · ${commit.hash.slice(0, 7)}`,
      ),
      read.status !== "ready"
        ? h(Pending, { read, rows: 8, retry: () => setAttempt((value) => value + 1) })
        : h(
            React.Fragment,
            null,
            diff.message && diff.message !== commit.subject
              ? h(
                  "pre",
                  {
                    style: {
                      whiteSpace: "pre-wrap",
                      font: "inherit",
                      fontSize: 13.5,
                      margin: "0 0 12px",
                    },
                  },
                  diff.message.replace(commit.subject, "").trim(),
                )
              : null,
            h(
              "p",
              { className: "sp-muted", style: { marginBottom: 8 } },
              `${diff.files.length} file${diff.files.length === 1 ? "" : "s"} changed · `,
              h("span", { className: "sp-add" }, `+${additions}`),
              " ",
              h("span", { className: "sp-del" }, `−${deletions}`),
            ),
            diff.files.map((file) => {
              const shown = file.lines.slice(0, Math.max(budget, 0));
              budget -= shown.length;
              return h(
                "details",
                { key: file.path, className: "sp-diff", open: diff.files.length <= 12 },
                h(
                  "summary",
                  null,
                  h("span", { className: "sp-oneline sp-grow" }, file.path),
                  file.binary
                    ? h("span", { className: "sp-size" }, "binary")
                    : h(
                        "span",
                        { className: "sp-size" },
                        h("span", { className: "sp-add" }, `+${file.additions}`),
                        " ",
                        h("span", { className: "sp-del" }, `−${file.deletions}`),
                      ),
                ),
                shown.length
                  ? h(
                      "div",
                      { className: "sp-diff-body" },
                      shown.map((line, index) =>
                        h(
                          "div",
                          { key: index, className: "sp-line", "data-kind": line.kind },
                          line.text,
                        ),
                      ),
                    )
                  : null,
                shown.length < file.lines.length
                  ? h(
                      "p",
                      { className: "sp-muted", style: { padding: "0 12px 8px" } },
                      "The rest of this change is too long to show here.",
                    )
                  : null,
              );
            }),
          ),
    );
  }

  function RepoBrowser({ session, cache, views, repo, scope, back, compact }) {
    const [ref, width] = useWidth();
    const wide = width >= WIDE_LAYOUT;
    const [view, setView] = React.useState(
      () => views.get(repo.address) || { tab: "files", dir: "" },
    );
    const [attempt, setAttempt] = React.useState(0);
    const [copied, copy] = useCopied();
    const read = useGitRead(session, cache, repo, {}, attempt);
    const go = (changes) =>
      setView((held) => {
        const next = { ...held, ...changes };
        views.set(repo.address, next);
        return next;
      });
    const refresh = () => {
      const prefix = JSON.stringify([repo.owner, repo.dtag]).slice(0, -1);
      for (const key of [...cache.keys()])
        if (key.startsWith(prefix)) cache.delete(key);
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
          className: "sp-tab",
          "aria-current": view.tab === tab ? "page" : undefined,
          onClick: () => go({ tab }),
        },
        label,
      );
    let body;
    if (read.status !== "ready")
      body = h(Pending, {
        read,
        rows: 8,
        retry: () => setAttempt((value) => value + 1),
      });
    else if (view.tab === "commits" && view.commit)
      body = h(CommitView, {
        session,
        cache,
        repo,
        commit: view.commit,
        back: () => go({ commit: undefined }),
      });
    else if (view.tab === "commits")
      body = h(CommitList, {
        snapshot: read.data,
        openCommit: (commit) => go({ commit }),
      });
    else
      body = h(FilesPane, {
        session,
        cache,
        repo,
        snapshot: read.data,
        view,
        go,
        wide,
        globalKeys: !compact,
      });
    const home = view.tab === "files" && !view.dir && !view.file;
    return h(
      "div",
      { className: "sp-scroll", ref },
      h(
        "div",
        { className: `sp-page${wide ? " sp-wide" : ""}` },
        h(
          "div",
          { className: "sp-header", style: { marginBottom: home ? 4 : 10 } },
          h("button", { type: "button", className: "sp-back", onClick: back }, "← Projects"),
          h("h1", { className: "sp-grow" }, repo.name),
          h(
            "button",
            {
              type: "button",
              className: "sp-btn",
              title: cloneUrl(repo, scope.communityOrigin),
              onClick: () => copy(cloneUrl(repo, scope.communityOrigin)),
            },
            copied ? "Copied" : wide ? "Copy clone URL" : "Clone",
          ),
          h(
            "button",
            {
              type: "button",
              className: "sp-btn",
              "aria-label": "Refresh",
              title: "Refresh",
              onClick: refresh,
            },
            wide ? "Refresh" : "↻",
          ),
        ),
        home && repo.description
          ? h(
              "p",
              {
                className: "sp-muted sp-oneline",
                title: repo.description,
                style: { marginBottom: 10 },
              },
              repo.description,
            )
          : null,
        h(
          "div",
          { className: "sp-tabs" },
          tabButton("files", "Files"),
          tabButton("commits", "Commits"),
          h(
            "button",
            { type: "button", className: "sp-tab", onClick: () => openInBuzz("prs") },
            "Pull requests ↗",
          ),
          h(
            "button",
            { type: "button", className: "sp-tab", onClick: () => openInBuzz("issues") },
            "Issues ↗",
          ),
          wide && view.tab === "files" && read.status === "ready" && read.data.files.length
            ? h(
                "button",
                {
                  type: "button",
                  className: "sp-tab",
                  style: { marginLeft: "auto", fontSize: 12 },
                  onClick: () => go({ hideTree: !view.hideTree }),
                },
                view.hideTree ? "Show file tree" : "Hide file tree",
              )
            : null,
        ),
        body,
      ),
    );
  }

  function RepoRow({ repo, openRepo }) {
    return h(
      "button",
      { type: "button", className: "sp-row", onClick: () => openRepo(repo) },
      h("span", { className: "sp-row-name sp-oneline" }, repo.name),
      h("span", { className: "sp-oneline sp-grow sp-muted", style: { margin: 0 } }, repo.description),
      h("span", { className: "sp-chevron", "aria-hidden": true }, "›"),
    );
  }

  function ChannelChips({ ids, names, openChannel }) {
    if (!ids.length) return null;
    return h(
      "div",
      { className: "sp-chips" },
      ids.map((id) =>
        h(
          "button",
          {
            key: id,
            type: "button",
            className: "sp-chip sp-oneline",
            title: names.has(id) ? "Open channel" : "You haven't joined this channel",
            onClick: () => openChannel(id),
          },
          names.has(id) ? `# ${names.get(id)}` : "Channel not joined",
        ),
      ),
    );
  }

  function ProjectsFeature({ session, scope, memory, compact, channel }) {
    const [state, setState] = React.useState({ status: "loading" });
    const [query, setQuery] = React.useState("");
    const [attempt, setAttempt] = React.useState(0);
    const [repo, setRepoState] = React.useState(memory.repo);
    const setRepo = (next) => {
      memory.repo = next;
      setRepoState(next);
    };
    const recentKey = `sprig.projects.recent:${scope.communityOrigin}:${scope.viewer}`;
    const [recent, setRecent] = React.useState(() => readRecent(recentKey));
    const { cache, views } = memory;
    const scroller = React.useRef(null);
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

    useMeasure(() => {
      if (!repo && scroller.current) scroller.current.scrollTop = memory.scrollTop;
    }, [repo]);

    const names = React.useMemo(
      () => new Map(channels.channels.map((c) => [c.id, c.name])),
      [channels],
    );
    const openRepo = (next) => {
      if (scroller.current) memory.scrollTop = scroller.current.scrollTop;
      const updated = nextRecent(recent, next.address);
      setRecent(updated);
      writeRecent(recentKey, updated);
      setRepo(next);
    };
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
        views,
        repo,
        scope,
        compact,
        back: () => setRepo(null),
      });

    const frame = (...children) =>
      h(
        "div",
        { className: "sp-scroll", ref: scroller },
        h("div", { className: "sp-page" }, ...children),
      );
    const header = (subtitle) =>
      h(
        "div",
        { className: "sp-header" },
        h(
          "div",
          { className: "sp-grow" },
          h("h1", null, "Projects"),
          subtitle ? h("p", { className: "sp-muted" }, subtitle) : null,
        ),
        h(
          "button",
          {
            type: "button",
            className: "sp-btn",
            onClick: () => setAttempt((value) => value + 1),
          },
          "Refresh",
        ),
      );
    if (state.status === "loading")
      return frame(
        header(),
        h(Pending, { read: { status: "loading" }, rows: 7 }),
      );
    if (state.status === "error")
      return frame(
        header(),
        h(Pending, {
          read: {
            status: "error",
            error: { title: "Couldn't load projects", detail: state.error },
          },
          retry: () => setAttempt((value) => value + 1),
        }),
      );

    const all = state.model;
    const everyRepo = [...all.projects.flatMap((p) => p.repos), ...all.unassigned];
    const byAddress = new Map(everyRepo.map((item) => [item.address, item]));
    const recentRepos = recent.map((item) => byAddress.get(item)).filter(Boolean);
    const channelRepos = channel
      ? [...byAddress.values()].filter((item) => item.channelId === channel.channelId)
      : [];
    const total = byAddress.size;
    const model = filterModel(all, query);
    const empty = !model.projects.length && !model.unassigned.length;
    return frame(
      header(
        `${all.projects.length} project${all.projects.length === 1 ? "" : "s"} · ${total} repositor${total === 1 ? "y" : "ies"}`,
      ),
      h("input", {
        className: "sp-input",
        style: { marginBottom: 14 },
        type: "search",
        placeholder: "Search projects and repositories",
        "aria-label": "Search projects and repositories",
        value: query,
        onChange: (event) => setQuery(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Escape") setQuery("");
        },
      }),
      all.capped
        ? h(
            "p",
            { className: "sp-muted", style: { marginBottom: 10 } },
            `Showing the first ${READ_LIMIT} records; some may be missing.`,
          )
        : null,
      !query.trim() && channelRepos.length
        ? h(
            "section",
            { "aria-label": "In this channel" },
            h("h2", { className: "sp-section", style: { marginTop: 0 } }, `In #${channel.channelName}`),
            h(
              "div",
              { className: "ui-card sp-card", style: { paddingTop: 8 } },
              channelRepos.map((item) =>
                h(RepoRow, { key: item.address, repo: item, openRepo }),
              ),
            ),
          )
        : null,
      !query.trim() && recentRepos.length
        ? h(
            "section",
            { "aria-label": "Recently opened" },
            h("h2", { className: "sp-section", style: { marginTop: 0 } }, "Recently opened"),
            h(
              "div",
              { className: "ui-card sp-card", style: { paddingTop: 8 } },
              recentRepos.map((item) =>
                h(RepoRow, { key: item.address, repo: item, openRepo }),
              ),
            ),
          )
        : null,
      empty
        ? h(
            "div",
            { className: "sp-notice" },
            h("h2", null, query ? "Nothing matches that search" : "No projects yet"),
            h(
              "p",
              { className: "sp-muted" },
              query
                ? "Try a project or repository name."
                : "Projects created in Buzz will appear here.",
            ),
          )
        : null,
      model.projects.map((project) => {
        const ids = [
          ...new Set(
            [project.channelId, ...project.repos.map((r) => r.channelId)].filter(Boolean),
          ),
        ];
        return h(
          "section",
          { key: project.address, className: "ui-card sp-card" },
          h(
            "div",
            { className: "sp-card-head" },
            h("h2", { className: "sp-grow sp-oneline" }, project.name),
            h(
              "span",
              { className: "sp-size" },
              project.repos.length
                ? `${project.repos.length} repositor${project.repos.length === 1 ? "y" : "ies"}`
                : "No repositories",
            ),
          ),
          project.description
            ? h("p", { className: "sp-muted sp-card-body" }, project.description)
            : null,
          h(ChannelChips, { ids, names, openChannel }),
          project.repos.length
            ? h(
                "div",
                { style: { marginTop: 6 } },
                project.repos.map((item) =>
                  h(RepoRow, { key: item.address, repo: item, openRepo }),
                ),
              )
            : null,
          project.missing
            ? h(
                "p",
                { className: "sp-muted sp-card-body", style: { marginTop: 6, marginBottom: 4 } },
                `${project.missing} linked repositor${project.missing === 1 ? "y isn't" : "ies aren't"} available`,
              )
            : null,
        );
      }),
      model.unassigned.length
        ? h(
            React.Fragment,
            null,
            h("h2", { className: "sp-section" }, "Other repositories"),
            h(
              "section",
              { className: "ui-card sp-card", style: { paddingTop: 8 } },
              model.unassigned.map((item) =>
                h(RepoRow, { key: item.address, repo: item, openRepo }),
              ),
            ),
          )
        : null,
    );
  }

  function Surface({ compact, channel }) {
    const connection = useConnection();
    const ready =
      connection.status === "ready" && connection.origin && connection.viewer;
    return h(
      "div",
      { "data-sprig-projects": "", className: compact ? "sp-compact" : undefined },
      h("style", null, CSS),
      ready
        ? h(ProjectsFeature, {
            key: `${connection.scope}:${connection.generation}`,
            session: connection.session,
            memory: memoryFor(connection.scope),
            compact,
            channel,
            scope: {
              viewer: connection.viewer,
              communityOrigin: connection.origin,
            },
          })
        : h(
            "div",
            { className: "sp-page" },
            h("p", null, connection.error || "Connecting to your community…"),
          ),
    );
  }

  const ProjectsPage = () => h(Surface, { compact: false });
  const ProjectsPanel = ({ channelContext }) =>
    h(Surface, { compact: true, channel: channelContext });

  function ChannelButton({ toggle, pressed }) {
    return h(
      "button",
      {
        type: "button",
        "aria-label": "Toggle Projects",
        "aria-expanded": pressed,
        title: "Projects",
        onClick: () => toggle(PANEL_TARGET),
        style: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          padding: 0,
          border: "none",
          borderRadius: 6,
          background: pressed
            ? "color-mix(in srgb, currentColor 12%, transparent)"
            : "transparent",
          color: "inherit",
          cursor: "pointer",
        },
      },
      h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: 16,
          height: 16,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinejoin: "round",
          "aria-hidden": true,
        },
        h("path", { d: "M3 6h6l2 2h10v11H3z" }),
      ),
    );
  }

  const icon = `data:image/svg+xml;base64,${btoa(ICON)}`;
  ctx.pages.register({
    id: "projects",
    title: "Projects",
    layout: "document",
    primary: true,
    icon,
    component: ProjectsPage,
  });
  ctx.panels.register({
    id: "projects-panel",
    title: "Projects",
    matches: () => false,
    launcher: { icon, target: PANEL_TARGET },
    channelLauncher: ChannelButton,
    channelPlacement: "tab",
    deferUntilShown: true,
    component: ProjectsPanel,
  });
}

export const inject = ["react", "pages", "panels", "relay", "navigation"];
