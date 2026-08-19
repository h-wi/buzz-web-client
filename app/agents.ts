import type { Event as NostrEvent } from "nostr-tools";

/// NIP-AP: kind:30175 persona (agent definition). Field order mirrors the
/// Rust `PersonaEventContent` so content bytes — and therefore the NIP-01
/// event id / `persona_content_hash` — stay stable across clients.
export type Persona = {
  slug: string;
  displayName: string;
  systemPrompt: string | null;
  avatarUrl: string | null;
  runtime: string | null;
  model: string | null;
  provider: string | null;
  namePool: string[];
  respondTo: string | null;
  respondToAllowlist: string[];
  parallelism: number | null;
  shared: boolean;
  updatedAt: number;
};

/// NIP-AP: kind:30176 team. Field order mirrors `TeamEventContent`.
export type Team = {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  personaIds: string[];
  updatedAt: number;
};

/// Normalize a raw slug to the NIP-AP grammar `^[a-z0-9][a-z0-9_-]{0,63}$`
/// (mirrors `normalize_d_tag` in the desktop).
export function normalizeSlug(raw: string): string {
  let out = "";
  for (const char of raw) {
    const c = char.toLowerCase();
    out += /^[a-z0-9_-]$/.test(c) ? c : "-";
  }
  if (!/^[a-z0-9]/.test(out)) out = `a${out}`;
  return out.slice(0, 64);
}

/// Monotonic NIP-33 created_at: `max(now, priorHead + 1)`.
export function monotonicCreatedAt(priorHeadCreatedAt: number | undefined): number {
  const now = Math.floor(Date.now() / 1000);
  const floor = priorHeadCreatedAt ? priorHeadCreatedAt + 1 : 0;
  return Math.max(now, floor);
}

export function parsePersona(event: NostrEvent): Persona | null {
  const slug = event.tags.find((tag) => tag[0] === "d")?.[1];
  if (!slug) return null;
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(event.content);
  } catch {
    return null;
  }
  const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
  const strList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return {
    slug,
    displayName: typeof body.display_name === "string" ? body.display_name : "unnamed",
    systemPrompt: str(body.system_prompt),
    avatarUrl: str(body.avatar_url),
    runtime: str(body.runtime),
    model: str(body.model),
    provider: str(body.provider),
    namePool: strList(body.name_pool),
    respondTo: str(body.respond_to),
    respondToAllowlist: strList(body.respond_to_allowlist),
    parallelism: typeof body.parallelism === "number" ? body.parallelism : null,
    shared: event.tags.some((tag) => tag[0] === "shared" && tag[1] === "true"),
    updatedAt: event.created_at,
  };
}

/// Build a kind:30175 persona event body. Null/empty optional fields are
/// omitted, exactly like the desktop projection, so unchanged fields keep
/// stable content bytes.
export function personaContentBody(persona: Omit<Persona, "slug" | "shared" | "updatedAt">): string {
  const body: Record<string, unknown> = { display_name: persona.displayName };
  if (persona.systemPrompt !== null && persona.systemPrompt !== "") body.system_prompt = persona.systemPrompt;
  if (persona.avatarUrl) body.avatar_url = persona.avatarUrl;
  if (persona.runtime) body.runtime = persona.runtime;
  if (persona.model) body.model = persona.model;
  if (persona.provider) body.provider = persona.provider;
  if (persona.namePool.length > 0) body.name_pool = persona.namePool;
  if (persona.respondTo) body.respond_to = persona.respondTo;
  if (persona.respondToAllowlist.length > 0) body.respond_to_allowlist = persona.respondToAllowlist;
  if (persona.parallelism !== null) body.parallelism = persona.parallelism;
  return JSON.stringify(body);
}

export function personaTags(slug: string, shared: boolean): string[][] {
  const tags: string[][] = [["d", slug]];
  if (shared) tags.push(["shared", "true"]);
  return tags;
}

export function parseTeam(event: NostrEvent): Team | null {
  const id = event.tags.find((tag) => tag[0] === "d")?.[1];
  if (!id) return null;
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(event.content);
  } catch {
    return null;
  }
  const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
  const strList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return {
    id,
    name: typeof body.name === "string" ? body.name : "unnamed team",
    description: str(body.description),
    instructions: str(body.instructions),
    personaIds: strList(body.persona_ids),
    updatedAt: event.created_at,
  };
}

export function teamContentBody(team: Omit<Team, "id" | "updatedAt">): string {
  const body: Record<string, unknown> = { name: team.name };
  if (team.description) body.description = team.description;
  if (team.instructions) body.instructions = team.instructions;
  body.persona_ids = team.personaIds;
  return JSON.stringify(body);
}
