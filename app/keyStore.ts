import { nip19 } from "nostr-tools";

const STORE_KEY = "buzz-web-key-v1";
const PBKDF2_ITERATIONS = 210_000;

type StoredKey = {
  v: 1;
  salt: string;
  iv: string;
  data: string;
};

function subtle(): SubtleCrypto {
  if (typeof globalThis.crypto?.subtle === "undefined") {
    throw new Error("이 브라우저는 Web Crypto를 지원하지 않습니다. HTTPS 환경에서 접속해 주세요.");
  }
  return globalThis.crypto.subtle;
}

export function parseSecretKey(value: string): Uint8Array {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Uint8Array.from(trimmed.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
  }

  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === "nsec") return decoded.data;
  }

  throw new Error("개인키는 64자리 hex 또는 nsec 형식이어야 합니다.");
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await subtle().importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle().deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}

export function hasStoredKey(): boolean {
  try {
    return localStorage.getItem(STORE_KEY) !== null;
  } catch {
    return false;
  }
}

export async function saveKey(secretKey: Uint8Array, password: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const encrypted = await subtle().encrypt(
    { name: "AES-GCM", iv },
    key,
    secretKey,
  );
  const record: StoredKey = {
    v: 1,
    salt: toHex(salt),
    iv: toHex(iv),
    data: toHex(new Uint8Array(encrypted)),
  };
  localStorage.setItem(STORE_KEY, JSON.stringify(record));
}

export async function unlockKey(password: string): Promise<Uint8Array> {
  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) throw new Error("저장된 계정이 없습니다.");
  const record = JSON.parse(raw) as StoredKey;
  const key = await deriveKey(password, fromHex(record.salt));
  const decrypted = await subtle().decrypt(
    { name: "AES-GCM", iv: fromHex(record.iv) },
    key,
    fromHex(record.data),
  );
  return new Uint8Array(decrypted);
}

export function removeStoredKey(): void {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // Nothing stored, or storage unavailable.
  }
}
