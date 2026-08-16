import type { Profile } from "./profiles";

const MENTION_CAP = 50;

/// Extract `@mention` names from content using known member display names.
/// Mirrors buzz-sdk `extract_at_mentions_with_known`: at each `@` preceded by
/// whitespace or start-of-string, try known names longest-first
/// (case-insensitive, word-boundary-checked), then fall back to single-word
/// tokenization. Returns lowercased names in first-seen order, deduplicated.
export function extractAtMentions(content: string, knownNames: string[]): string[] {
  if (!content || !content.includes("@")) return [];

  const sorted = knownNames
    .map((name) => name.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  const names: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "@") continue;
    const preceded = i === 0 || /\s/.test(content[i - 1]);
    if (!preceded) continue;
    const rest = content.slice(i + 1);
    if (!rest) continue;

    const isBoundary = (s: string) => !s || !/[A-Za-z0-9._-]/.test(s[0]);
    const known = sorted.find((k) => rest.slice(0, k.length).toLowerCase() === k.toLowerCase() && isBoundary(rest.slice(k.length)));
    const name = known ?? rest.split(/[^\w.-]/, 1)[0];
    if (!name) continue;
    const lower = name.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      names.push(lower);
    }
  }
  return names;
}

/// Resolve mention names to member pubkeys using profile display names.
/// Longest-name match wins (handled by extractAtMentions); returns unique
/// pubkeys in first-seen order, capped at MENTION_CAP.
export function resolveMentions(content: string, profiles: Record<string, Profile>): string[] {
  const knownNames = Object.values(profiles).map((profile) => profile.name);
  const byName = new Map<string, string>();
  for (const [pubkey, profile] of Object.entries(profiles)) {
    const lower = profile.name.toLowerCase();
    if (!byName.has(lower)) byName.set(lower, pubkey);
  }
  const pubkeys: string[] = [];
  for (const name of extractAtMentions(content, knownNames)) {
    const pubkey = byName.get(name);
    if (pubkey && !pubkeys.includes(pubkey)) pubkeys.push(pubkey);
    if (pubkeys.length >= MENTION_CAP) break;
  }
  return pubkeys;
}

/// Split content into text and mention segments for rendering.
export function segmentMentions(content: string, profiles: Record<string, Profile>): { text: string; mention: string }[] {
  const knownNames = Object.values(profiles).map((profile) => profile.name);
  if (!knownNames.length || !content.includes("@")) return [{ text: content, mention: "" }];

  const byName = new Map<string, string>();
  for (const [pubkey, profile] of Object.entries(profiles)) {
    const lower = profile.name.toLowerCase();
    if (!byName.has(lower)) byName.set(lower, pubkey);
  }
  const sorted = [...knownNames].sort((a, b) => b.length - a.length);
  const isBoundary = (s: string) => !s || !/[A-Za-z0-9._-]/.test(s[0]);

  const segments: { text: string; mention: string }[] = [];
  let buffer = "";
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "@" && (i === 0 || /\s/.test(content[i - 1]))) {
      const rest = content.slice(i + 1);
      const known = sorted.find((k) => rest.slice(0, k.length).toLowerCase() === k.toLowerCase() && isBoundary(rest.slice(k.length)));
      if (known && byName.has(known.toLowerCase())) {
        if (buffer) segments.push({ text: buffer, mention: "" });
        segments.push({ text: `@${known}`, mention: byName.get(known.toLowerCase())! });
        buffer = "";
        i += known.length;
        continue;
      }
    }
    buffer += content[i];
  }
  if (buffer) segments.push({ text: buffer, mention: "" });
  return segments;
}
