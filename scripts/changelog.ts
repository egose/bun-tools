#!/usr/bin/env bun
/**
 * Generate/update CHANGELOG.md from conventional commits.
 *
 * Used by the release-it `after:bump` hook, which exports RELEASE_IT_VERSION
 * and RELEASE_IT_PREVIOUS_VERSION to hooks. Also works standalone:
 *
 *   bun run changelog                     # documents the latest git tag
 *   RELEASE_IT_VERSION=0.2.0 bun run changelog
 */

const SECTIONS: Array<[type: string, title: string]> = [
  ["feat", "Features"],
  ["fix", "Bug Fixes"],
  ["perf", "Performance"],
];

const OTHER_TITLE = "Other Changes";

type Commit = {
  hash: string;
  type: string;
  scope: string;
  breaking: boolean;
  description: string;
  body: string;
};

const CONVENTIONAL_RE =
  /^(?<type>\w+)(?<scope>\([^)]*\))?(?<breaking>!)?: (?<description>.+)/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawnSync(["git", ...args]);
  return proc.stdout.toString().trim();
}

async function resolveVersions(): Promise<{
  version: string;
  previous: string | null;
}> {
  let version = process.env.RELEASE_IT_VERSION?.replace(/^v/, "") ?? "";
  let previous =
    process.env.RELEASE_IT_PREVIOUS_VERSION?.replace(/^v/, "") ?? null;

  if (!version) {
    // Standalone mode: document the latest tag.
    const tag = await git(["describe", "--tags", "--abbrev=0"]);
    if (!tag) {
      console.error("no RELEASE_IT_VERSION and no git tags found");
      process.exit(1);
    }
    version = tag.replace(/^v/, "");
    const parent = await git(["describe", "--tags", "--abbrev=0", `${tag}^`]);
    previous = parent ? parent.replace(/^v/, "") : null;
  }

  return { version, previous: previous || null };
}

function parseCommits(raw: string): Commit[] {
  const commits: Commit[] = [];
  // tformat terminates every record with the record separator, so entries
  // split cleanly; trim() drops the inter-record newlines and empty tail.
  for (const record of raw.split("\x1e")) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [hash = "", subject = "", body = ""] = trimmed.split("\x1f");
    if (!hash || !subject) continue;
    if (/^merge (branch|pull request)/i.test(subject)) continue;
    if (/^chore: release candidate v/.test(subject)) continue;

    const match = CONVENTIONAL_RE.exec(subject);
    if (!match?.groups) continue;

    commits.push({
      hash,
      type: match.groups.type ?? "",
      scope: (match.groups.scope ?? "").replace(/[()]/g, ""),
      breaking:
        Boolean(match.groups.breaking) || /^BREAKING[ -]CHANGE:/m.test(body),
      description: match.groups.description ?? "",
      body,
    });
  }
  return commits;
}

function bullet(commit: Commit): string {
  const scope = commit.scope ? `**${commit.scope}:** ` : "";
  return `- ${scope}${commit.description} (${commit.hash.slice(0, 7)})`;
}

function renderSection(
  version: string,
  date: string,
  commits: Commit[],
): string {
  const lines = [`## v${version} (${date})`];
  if (commits.length === 0) {
    lines.push("", "_No changes._");
    return lines.join("\n");
  }

  const breaking = commits.filter((c) => c.breaking);
  if (breaking.length > 0) {
    lines.push("", "### ⚠ BREAKING CHANGES");
    for (const commit of breaking) {
      const change = commit.body.match(/^BREAKING[ -]CHANGE:\s*(.+)/m)?.[1];
      lines.push(
        `- ${change ?? commit.description} (${commit.hash.slice(0, 7)})`,
      );
    }
  }

  const rest = commits.filter((c) => !c.breaking);
  const usedTypes = new Set<string>();
  for (const [type, title] of SECTIONS) {
    const group = rest.filter((c) => c.type === type);
    if (group.length === 0) continue;
    usedTypes.add(type);
    lines.push("", `### ${title}`);
    for (const commit of group) lines.push(bullet(commit));
  }

  const others = rest.filter((c) => !usedTypes.has(c.type));
  if (others.length > 0) {
    lines.push("", `### ${OTHER_TITLE}`);
    for (const commit of others) lines.push(bullet(commit));
  }

  return lines.join("\n");
}

function upsertSection(
  changelog: string,
  version: string,
  section: string,
): string {
  const trimmed = changelog.trimEnd();

  if (!trimmed) {
    return `# Changelog\n\n${section}\n`;
  }

  const headingRe = new RegExp(`^## v${escapeRegExp(version)} \\(`, "m");
  const existing = headingRe.exec(trimmed);
  if (existing) {
    // Replace the section for this version (up to the next heading or EOF).
    const start = existing.index;
    const rest = trimmed.slice(start + existing[0].length);
    const next = rest.search(/^## /m);
    const end =
      next === -1 ? trimmed.length : start + existing[0].length + next;
    return (
      `${trimmed.slice(0, start)}${section}\n\n${trimmed.slice(end).replace(/^\n+/, "")}`.trimEnd() +
      "\n"
    );
  }

  // Insert after the top-level header if present, otherwise at the top.
  const header = trimmed.match(/^# [^\n]*\n/);
  const offset = header ? header[0].length : 0;
  return (
    `${trimmed.slice(0, offset)}\n${section}\n${trimmed.slice(offset).replace(/^\n+/, "")}`.trimEnd() +
    "\n"
  );
}

const { version, previous } = await resolveVersions();
const range = previous ? `v${previous}..HEAD` : "HEAD";

const raw = await git(["log", range, "--pretty=tformat:%H%x1f%s%x1f%b%x1e"]);
const commits = parseCommits(raw);
const date = new Date().toISOString().slice(0, 10);
const section = renderSection(version, date, commits);

const path = new URL("../CHANGELOG.md", import.meta.url);
const existing = await Bun.file(path)
  .text()
  .catch(() => "");
await Bun.write(path, upsertSection(existing, version, section));

console.log(
  `CHANGELOG.md: documented v${version} (${commits.length} commit${commits.length === 1 ? "" : "s"})`,
);
