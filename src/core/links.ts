export interface WikiLink {
  raw: string;
  target: string;
  heading?: string;
  label?: string;
}

const WIKI_LINK = /\[\[([^[\]|#]+)(?:#([^[\]|]+))?(?:\|([^[\]]+))?\]\]/g;

export function extractWikiLinks(body: string): WikiLink[] {
  const links: WikiLink[] = [];
  for (const match of body.matchAll(WIKI_LINK)) {
    const target = match[1]?.trim();
    if (!target) continue;
    links.push({
      raw: match[0],
      target,
      heading: match[2]?.trim() || undefined,
      label: match[3]?.trim() || undefined,
    });
  }
  return links;
}

export function wikiLink(target: string, label?: string): string {
  if (!label || label === target) return `[[${target}]]`;
  return `[[${target}|${label.replaceAll('|', '-').replaceAll(']', '')}]]`;
}

/** Normalized lookup key. Keeps letters/numbers, collapses everything else. */
export function normalizeRef(input: string): string {
  return input
    .trim()
    .replace(/^\[\[/, '')
    .replace(/\]\]$/, '')
    .replace(/^#/, '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

export function fileNodeId(project: string | undefined, filePath: string): string {
  return `file:${project || 'workspace'}:${normalizeFilePath(filePath)}`;
}

export function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function projectNodeId(project: string): string {
  return `project:${project}`;
}

export function agentNodeId(agent: string): string {
  return `agent:${agent}`;
}

export function missingNodeId(ref: string): string {
  return `missing:${normalizeRef(ref) || ref.toLowerCase()}`;
}
