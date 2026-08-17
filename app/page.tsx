"use client";

import {
  finalizeEvent,
  getPublicKey,
  nip19,
  type Event as NostrEvent,
} from "nostr-tools";
import { hasStoredKey, parseSecretKey, removeStoredKey, saveKey, unlockKey } from "./keyStore";
import { resolveMentions, segmentMentions } from "./mentions";
import type { Profile } from "./profiles";
import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

const RELAY_URL = (import.meta.env.VITE_RELAY_URL as string | undefined) ?? "wss://buzz.indra.network";

type AuthMode = "loading" | "setup" | "locked" | "unlocked";

type ConnectionStatus = "disconnected" | "connecting" | "authenticating" | "connected" | "error";

type Channel = {
  id: string;
  name: string;
  about: string;
  isPrivate: boolean;
  createdAt: number;
  isDm?: boolean;
  participants?: string[];
};

type Reaction = {
  id: string;
  emoji: string;
  pubkey: string;
};

type RelayInfo = {
  name?: string;
  description?: string;
  icon?: string;
};

const REACTION_EMOJIS = ["👍", "❤️", "😂", "🎉", "👀"];

const DEMO_CHANNELS: Channel[] = [
  { id: "demo-general", name: "general", about: "팀 전체가 함께 이야기하는 공간", isPrivate: false, createdAt: 3 },
  { id: "demo-product", name: "product", about: "제품을 함께 만드는 공간", isPrivate: false, createdAt: 2 },
  { id: "demo-random", name: "random", about: "가벼운 이야기를 나누는 공간", isPrivate: false, createdAt: 1 },
];

const DEMO_MESSAGES: NostrEvent[] = [
  { id: "demo-1", pubkey: "minji", created_at: 1776312240, kind: 9, tags: [], content: "태블릿에서도 Buzz를 바로 열 수 있으면 좋겠어요. 오늘 웹 클라이언트 연결해볼까요?", sig: "" },
  { id: "demo-2", pubkey: "hive-agent", created_at: 1776312300, kind: 9, tags: [], content: "릴레이 연결 준비가 끝났어요. 채널 목록과 최근 메시지를 불러올 수 있습니다.", sig: "" },
  { id: "demo-3", pubkey: "taehwi", created_at: 1776312420, kind: 9, tags: [], content: "좋아요. 우선 채널 읽기와 메시지 보내기부터 시작하죠 🐝", sig: "" },
];

const DEMO_PROFILES: Record<string, Profile> = {
  minji: { name: "minji" },
  "hive-agent": { name: "hive-agent", isAgent: true },
  taehwi: { name: "taehwi" },
};

function findTag(event: NostrEvent, name: string) {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

function hasTag(event: NostrEvent, name: string) {
  return event.tags.some((tag) => tag[0] === name);
}

function relayHttpUrl(relayUrl: string) {
  return relayUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

function channelFromEvent(event: NostrEvent): Channel | null {
  const id = findTag(event, "d");
  if (!id || hasTag(event, "hidden")) return null;
  return {
    id,
    name: findTag(event, "name") || "unnamed",
    about: findTag(event, "about") || "이 채널에는 아직 설명이 없습니다.",
    isPrivate: hasTag(event, "private"),
    createdAt: event.created_at,
  };
}

function messageText(content: string) {
  if (!content.trim().startsWith("{")) return content;
  try {
    const parsed = JSON.parse(content);
    return parsed.text || parsed.content || parsed.message || content;
  } catch {
    return content;
  }
}

function shortPubkey(pubkey: string) {
  return pubkey.length > 16 ? `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}` : pubkey;
}

function initials(name: string) {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : name.slice(0, 2)).toUpperCase();
}

function avatarTone(value: string) {
  const tones = ["coral", "violet", "blue", "green", "amber"];
  const score = [...value].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return tones[score % tones.length];
}

function formatTime(timestamp: number) {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat("ko-KR", {
    ...(sameDay ? {} : { month: "numeric", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function nextSubscription(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
}

function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

export default function Home() {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [authMode, setAuthMode] = useState<AuthMode>("loading");
  const [secretInput, setSecretInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<NostrEvent[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [relayInfo, setRelayInfo] = useState<RelayInfo>({});
  const [connectedRelay, setConnectedRelay] = useState("");
  const [ownPubkey, setOwnPubkey] = useState("");
  const [memberCount, setMemberCount] = useState(0);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [reactions, setReactions] = useState<Record<string, Reaction[]>>({});
  const [replyTo, setReplyTo] = useState<NostrEvent | null>(null);
  const [pickerFor, setPickerFor] = useState("");
  const [memberPubkeys, setMemberPubkeys] = useState<string[]>([]);
  const [dms, setDms] = useState<Channel[]>([]);
  const [dmBusy, setDmBusy] = useState(false);
  const [openThreadId, setOpenThreadId] = useState("");
  const [threadComposer, setThreadComposer] = useState("");
  const [threadTarget, setThreadTarget] = useState<NostrEvent | null>(null);
  const [mentionState, setMentionState] = useState<{ field: "main" | "thread"; query: string } | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [addMemberInput, setAddMemberInput] = useState("");

  const socketRef = useRef<WebSocket | null>(null);
  const secretRef = useRef<Uint8Array | null>(null);
  const pubkeyRef = useRef("");
  const relayRef = useRef("");
  const authEventIdRef = useRef("");
  const channelSubRef = useRef("");
  const messageSubRef = useRef("");
  const memberSubRef = useRef("");
  const reactionSubRef = useRef("");
  const profileSubRefs = useRef(new Map<string, string>());
  const requestedProfilesRef = useRef(new Set<string>());
  const authTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const dmListSubRef = useRef("");
  const dmOpenCallbackRef = useRef<((reason: string, accepted: boolean) => void) | null>(null);

  const isConnected = status === "connected";
  const visibleChannels = isConnected ? channels : DEMO_CHANNELS;
  const dmNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const dm of dms) {
      const others = (dm.participants ?? []).filter((pubkey) => pubkey !== ownPubkey);
      map.set(dm.id, others.map((pubkey) => profiles[pubkey]?.name || shortPubkey(pubkey)).join(", ") || "나");
    }
    return map;
  }, [dms, profiles, ownPubkey]);
  const visibleMessages = isConnected ? messages : DEMO_MESSAGES;
  const visibleProfiles = isConnected ? profiles : DEMO_PROFILES;
  const visibleActive = isConnected ? activeChannel : DEMO_CHANNELS[0];
  const workspaceName = relayInfo.name || (connectedRelay ? new URL(connectedRelay).hostname : "My Buzz");
  const activeHeadingName = visibleActive?.isDm ? (dmNames.get(visibleActive.id) || "DM") : visibleActive?.name;

  const ownProfile = profiles[ownPubkey];
  const ownName = ownProfile?.name || shortPubkey(ownPubkey || "TH");

  const memberProfiles = useMemo(() => {
    const map: Record<string, Profile> = {};
    for (const pubkey of memberPubkeys) {
      const profile = profiles[pubkey];
      if (profile) map[pubkey] = profile;
    }
    return map;
  }, [memberPubkeys, profiles]);

  const messagesById = useMemo(() => {
    const map = new Map<string, NostrEvent>();
    for (const message of visibleMessages) map.set(message.id, message);
    return map;
  }, [visibleMessages]);

  const repliesByRoot = useMemo(() => {
    const map = new Map<string, NostrEvent[]>();
    for (const message of visibleMessages) {
      const rootId = findTag(message, "e");
      if (!rootId || !messagesById.has(rootId)) continue;
      map.set(rootId, [...(map.get(rootId) ?? []), message]);
    }
    return map;
  }, [visibleMessages, messagesById]);

  const openThread = openThreadId ? messagesById.get(openThreadId) ?? null : null;
  const openThreadReplies = openThreadId ? repliesByRoot.get(openThreadId) ?? [] : [];

  const mentionCandidates = useMemo(() => {
    return memberPubkeys
      .filter((pubkey) => pubkey !== ownPubkey && profiles[pubkey])
      .map((pubkey) => ({ pubkey, profile: profiles[pubkey] }))
      .filter((item) => !mentionState?.query || item.profile.name.toLowerCase().includes(mentionState.query.toLowerCase()))
      .sort((a, b) => (a.profile.isAgent === b.profile.isAgent ? a.profile.name.localeCompare(b.profile.name) : a.profile.isAgent ? -1 : 1))
      .slice(0, 8);
  }, [memberPubkeys, profiles, ownPubkey, mentionState]);

  const updateMentionState = (field: "main" | "thread", value: string, caret: number) => {
    const before = value.slice(0, caret);
    const match = /(^|\s)@([\w.-]*)$/.exec(before);
    setMentionState(match ? { field, query: match[2] } : null);
  };

  const insertMention = (candidate: { pubkey: string; profile: Profile }) => {
    if (!mentionState) return;
    const setter = mentionState.field === "main" ? setComposer : setThreadComposer;
    setter((current) => current.replace(/(^|\s)(@[\w.-]*)$/, (_, prefix) => `${prefix}@${candidate.profile.name} `));
    setMentionState(null);
  };

  const parsePubkeyInput = (value: string): string | null => {
    const trimmed = value.trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();
    if (trimmed.startsWith("npub1")) {
      try {
        const decoded = nip19.decode(trimmed);
        if (decoded.type === "npub") return decoded.data;
      } catch {
        return null;
      }
    }
    return null;
  };

  const addMemberToChannel = () => {
    const key = secretRef.current;
    const target = parsePubkeyInput(addMemberInput);
    if (!key || !activeChannel) return;
    if (!target) {
      setNotice("npub 또는 64자리 hex 공개키를 입력해 주세요.");
      return;
    }
    if (memberPubkeys.includes(target)) {
      setNotice("이미 채널 멤버예요.");
      return;
    }
    try {
      const event = finalizeEvent({
        kind: 9000,
        created_at: nowInSeconds(),
        content: "",
        tags: [["h", activeChannel.id], ["p", target], ["role", "member"]],
      }, key);
      sendFrame(["EVENT", event]);
      setAddMemberInput("");
      setMemberPubkeys((current) => [...current, target]);
      setNotice(`${profiles[target]?.name || shortPubkey(target)} 멤버 추가 요청을 보냈어요.`);
      requestProfile(target);
    } catch {
      setNotice("멤버 추가 이벤트를 만들지 못했어요.");
    }
  };

  const removeMemberFromChannel = (target: string) => {
    const key = secretRef.current;
    if (!key || !activeChannel || target === ownPubkey) return;
    try {
      const event = finalizeEvent({
        kind: 9001,
        created_at: nowInSeconds(),
        content: "",
        tags: [["h", activeChannel.id], ["p", target]],
      }, key);
      sendFrame(["EVENT", event]);
      setMemberPubkeys((current) => current.filter((pubkey) => pubkey !== target));
      setNotice(`${profiles[target]?.name || shortPubkey(target)} 제거 요청을 보냈어요.`);
    } catch {
      setNotice("멤버 제거 이벤트를 만들지 못했어요.");
    }
  };


  const sendFrame = (frame: unknown[]) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) throw new Error("relay 연결이 끊겼습니다.");
    socketRef.current.send(JSON.stringify(frame));
  };

  const requestProfile = (pubkey: string) => {
    if (!pubkey || requestedProfilesRef.current.has(pubkey)) return;
    requestedProfilesRef.current.add(pubkey);
    const subId = nextSubscription("profile");
    profileSubRefs.current.set(subId, pubkey);
    sendFrame(["REQ", subId, { kinds: [0], authors: [pubkey], limit: 1 }]);
  };

  const subscribeToChannel = (channel: Channel) => {
    try {
      if (messageSubRef.current) sendFrame(["CLOSE", messageSubRef.current]);
      if (memberSubRef.current) sendFrame(["CLOSE", memberSubRef.current]);
      if (reactionSubRef.current) sendFrame(["CLOSE", reactionSubRef.current]);
    } catch {
      // The old connection may already be gone.
    }

    const messageSub = nextSubscription("messages");
    const memberSub = nextSubscription("members");
    const reactionSub = nextSubscription("reactions");
    messageSubRef.current = messageSub;
    memberSubRef.current = memberSub;
    reactionSubRef.current = reactionSub;
    setActiveChannel(channel);
    setMessages([]);
    setMemberCount(0);
    setMemberPubkeys([]);
    setReactions({});
    setReplyTo(null);
    setPickerFor("");
    setOpenThreadId("");
    setThreadComposer("");
    setThreadTarget(null);
    setMentionState(null);
    setMembersOpen(false);
    setDrawerOpen(false);
    sendFrame(["REQ", messageSub, { kinds: [9, 40002], "#h": [channel.id], limit: 200 }]);
    sendFrame(["REQ", memberSub, { kinds: [39002], "#d": [channel.id], limit: 1 }]);
    sendFrame(["REQ", reactionSub, { kinds: [7], "#h": [channel.id], limit: 300 }]);
  };

  const fetchRelayInfo = async (relayUrl: string) => {
    try {
      const response = await fetch(relayHttpUrl(relayUrl), { headers: { Accept: "application/nostr+json" } });
      if (response.ok) setRelayInfo(await response.json());
    } catch {
      // Relay metadata is optional; WebSocket chat can still work without it.
    }
  };

  const handleRelayMessage = (raw: MessageEvent<string>) => {
    let frame: unknown[];
    try {
      frame = JSON.parse(raw.data);
    } catch {
      return;
    }

    const [type, idOrChallenge, payload] = frame;
    if (type === "AUTH" && typeof idOrChallenge === "string") {
      const key = secretRef.current;
      if (!key) return;
      if (authTimerRef.current) clearTimeout(authTimerRef.current);
      setStatus("authenticating");
      const authEvent = finalizeEvent({
        kind: 22242,
        created_at: nowInSeconds(),
        content: "",
        tags: [["relay", relayRef.current], ["challenge", idOrChallenge]],
      }, key);
      authEventIdRef.current = authEvent.id;
      sendFrame(["AUTH", authEvent]);

      const channelSub = nextSubscription("channels");
      channelSubRef.current = channelSub;
      sendFrame(["REQ", channelSub, { kinds: [39000], limit: 500 }]);
      const dmSub = nextSubscription("dmlist");
      dmListSubRef.current = dmSub;
      sendFrame(["REQ", dmSub, { kinds: [41001], "#p": [pubkeyRef.current], limit: 50 }]);
      requestProfile(pubkeyRef.current);
      setStatus("connected");
      setAuthMode("unlocked");
      setAuthBusy(false);
      setSecretInput("");
      setPasswordInput("");
      setPasswordConfirm("");
      return;
    }

    if (type === "EVENT" && typeof idOrChallenge === "string" && payload && typeof payload === "object") {
      const event = payload as NostrEvent;
      if (event.kind === 39000) {
        const channel = channelFromEvent(event);
        if (channel) {
          setChannels((current) => {
            const existing = current.find((item) => item.id === channel.id);
            if (existing && existing.createdAt > channel.createdAt) return current;
            return [...current.filter((item) => item.id !== channel.id), channel].sort((a, b) => a.name.localeCompare(b.name));
          });
        }
      } else if ((event.kind === 9 || event.kind === 40002) && idOrChallenge === messageSubRef.current) {
        setMessages((current) => {
          if (current.some((item) => item.id === event.id)) return current;
          return [...current, event].sort((a, b) => a.created_at - b.created_at);
        });
        requestProfile(event.pubkey);
      } else if (event.kind === 7 && idOrChallenge === reactionSubRef.current) {
        const target = findTag(event, "e");
        const emoji = event.content.trim();
        if (!target || !emoji) return;
        setReactions((current) => {
          const list = current[target] ?? [];
          if (list.some((item) => item.id === event.id)) return current;
          return { ...current, [target]: [...list, { id: event.id, emoji, pubkey: event.pubkey }] };
        });
      } else if (event.kind === 39002 && idOrChallenge === memberSubRef.current) {
        const pubkeys = event.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]).filter(Boolean);
        setMemberCount(pubkeys.length);
        setMemberPubkeys(pubkeys);
        for (const pubkey of pubkeys) requestProfile(pubkey);
      } else if (event.kind === 41001 && idOrChallenge === dmListSubRef.current) {
        const dmId = findTag(event, "d");
        if (!dmId) return;
        const participants = [event.pubkey, ...event.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1])].filter((pubkey, index, all) => pubkey && all.indexOf(pubkey) === index);
        const dm: Channel = { id: dmId, name: "", about: "다이렉트 메시지", isPrivate: true, isDm: true, createdAt: event.created_at, participants };
        setDms((current) => {
          const existing = current.find((item) => item.id === dm.id);
          if (existing && existing.createdAt > dm.createdAt) return current;
          return [...current.filter((item) => item.id !== dm.id), dm].sort((a, b) => b.createdAt - a.createdAt);
        });
        for (const pubkey of participants) requestProfile(pubkey);
      } else if (event.kind === 0) {
        try {
          const metadata = JSON.parse(event.content);
          setProfiles((current) => ({
            ...current,
            [event.pubkey]: {
              name: metadata.display_name || metadata.name || shortPubkey(event.pubkey),
              picture: metadata.picture,
              isAgent: Boolean(metadata.bot || metadata.agent),
            },
          }));
        } catch {
          // Invalid profile metadata is ignored.
        }
      }
      return;
    }

    if (type === "EOSE" && typeof idOrChallenge === "string") {
      if (idOrChallenge === channelSubRef.current) {
        sendFrame(["CLOSE", idOrChallenge]);
        setChannels((current) => {
          if (current.length && !activeChannel) queueMicrotask(() => subscribeToChannel(current[0]));
          return current;
        });
      } else if (idOrChallenge === dmListSubRef.current) {
        sendFrame(["CLOSE", idOrChallenge]);
      } else if (profileSubRefs.current.has(idOrChallenge)) {
        sendFrame(["CLOSE", idOrChallenge]);
        profileSubRefs.current.delete(idOrChallenge);
      }
      return;
    }

    if (type === "OK" && typeof idOrChallenge === "string") {
      const accepted = payload === true;
      const reason = typeof frame[3] === "string" ? frame[3] : "";
      const dmCallback = dmOpenCallbackRef.current;
      if (dmCallback) {
        dmOpenCallbackRef.current = null;
        dmCallback(reason, accepted);
      }
      if (idOrChallenge === authEventIdRef.current && !accepted) {
        setError(reason || "relay가 인증을 거부했습니다.");
        setStatus("error");
      } else if (!accepted && !dmCallback) {
        setNotice(reason || "메시지를 보낼 수 없습니다.");
      }
      setSending(false);
      return;
    }

    if (type === "CLOSED" || type === "NOTICE") {
      const reason = typeof payload === "string" ? payload : typeof idOrChallenge === "string" ? idOrChallenge : "relay 요청이 종료되었습니다.";
      if (/auth|required|restricted|error/i.test(reason)) {
        setError(reason);
        setStatus("error");
      } else {
        setNotice(reason);
      }
    }
  };

  const connect = (key: Uint8Array) => {
    setError("");
    setNotice("");
    setAuthBusy(true);
    setStatus("connecting");
    secretRef.current = key;
    const pubkey = getPublicKey(key);
    pubkeyRef.current = pubkey;
    relayRef.current = RELAY_URL;
    setOwnPubkey(pubkey);
    setConnectedRelay(RELAY_URL);

    const socket = new WebSocket(RELAY_URL);
    socketRef.current = socket;
    socket.addEventListener("message", handleRelayMessage);
    socket.addEventListener("open", () => {
      authTimerRef.current = setTimeout(() => {
        setError("relay가 인증 요청을 보내지 않았습니다. Buzz relay 주소인지 확인해 주세요.");
        setStatus("error");
        setAuthBusy(false);
        socket.close();
      }, 10000);
    });
    socket.addEventListener("error", () => {
      setError("relay에 연결할 수 없습니다. 주소와 TLS 설정을 확인해 주세요.");
      setStatus("error");
      setAuthBusy(false);
    });
    socket.addEventListener("close", () => {
      if (authTimerRef.current) clearTimeout(authTimerRef.current);
      setStatus((current) => current === "error" || current === "disconnected" ? current : "error");
      setError((current) => current || "relay 연결이 종료되었습니다. 다시 연결해 주세요.");
      setAuthBusy(false);
    });
    void fetchRelayInfo(RELAY_URL);
  };

  const handleSetup = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (passwordInput.length < 4) {
      setError("비밀번호는 4자 이상으로 정해 주세요.");
      return;
    }
    if (passwordInput !== passwordConfirm) {
      setError("비밀번호가 일치하지 않습니다.");
      return;
    }
    let key: Uint8Array;
    try {
      key = parseSecretKey(secretInput);
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : "개인키를 확인해 주세요.");
      return;
    }
    try {
      await saveKey(key, passwordInput);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "키를 저장하지 못했습니다.");
      return;
    }
    setSecretInput("");
    setPasswordInput("");
    setPasswordConfirm("");
    connect(key);
  };

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setAuthBusy(true);
    try {
      const key = await unlockKey(passwordInput);
      setPasswordInput("");
      connect(key);
    } catch {
      setError("비밀번호가 올바르지 않습니다.");
      setAuthBusy(false);
      return;
    }
  };

  const lock = () => {
    disconnect();
    setAuthMode("locked");
  };

  const removeAccount = () => {
    removeStoredKey();
    disconnect();
    setAuthMode("setup");
  };

  const disconnect = () => {
    setStatus("disconnected");
    socketRef.current?.close();
    socketRef.current = null;
    secretRef.current?.fill(0);
    secretRef.current = null;
    pubkeyRef.current = "";
    relayRef.current = "";
    setOwnPubkey("");
    setConnectedRelay("");
    setChannels([]);
    setDms([]);
    setMessages([]);
    setMemberPubkeys([]);
    setProfiles({});
    setActiveChannel(null);
    setRelayInfo({});
    setReactions({});
    setReplyTo(null);
    setOpenThreadId("");
    setThreadComposer("");
    setThreadTarget(null);
    setPickerFor("");
    setNotice("");
    setError("");
  };

  const publishMessage = (content: string, parentEvent: NostrEvent | null) => {
    const key = secretRef.current;
    if (!content || !key || !activeChannel || sending) return;

    try {
      const tags: string[][] = [["h", activeChannel.id]];
      if (parentEvent) tags.push(["e", parentEvent.id, "", "reply"]);
      for (const pubkey of resolveMentions(content, memberProfiles)) tags.push(["p", pubkey]);
      const event = finalizeEvent({
        kind: 9,
        created_at: nowInSeconds(),
        content,
        tags,
      }, key);
      setSending(true);
      setMessages((current) => [...current, event].sort((a, b) => a.created_at - b.created_at));
      sendFrame(["EVENT", event]);
      window.setTimeout(() => setSending(false), 5000);
      return true;
    } catch (sendError) {
      setNotice(sendError instanceof Error ? sendError.message : "메시지를 보내지 못했습니다.");
      setSending(false);
      return false;
    }
  };

  const sendMessage = () => {
    const content = composer.trim();
    if (!content) return;
    if (publishMessage(content, replyTo)) {
      setComposer("");
      setReplyTo(null);
    }
  };

  const sendThreadMessage = () => {
    const content = threadComposer.trim();
    if (!content || !openThread) return;
    if (publishMessage(content, threadTarget ?? openThread)) setThreadComposer("");
  };

  const openDm = (pubkey: string) => {
    const key = secretRef.current;
    if (!key || dmBusy || pubkey === ownPubkey) return;
    requestProfile(pubkey);

    const existing = dms.find((dm) => (dm.participants ?? []).includes(pubkey));
    if (existing) {
      subscribeToChannel(existing);
      return;
    }

    setDmBusy(true);
    const dmId = crypto.randomUUID();
    const event = finalizeEvent({
      kind: 41010,
      created_at: nowInSeconds(),
      content: "",
      tags: [["p", pubkey], ["d", dmId]],
    }, key);

    dmOpenCallbackRef.current = (reason, accepted) => {
      setDmBusy(false);
      if (!accepted) {
        setNotice(reason || "DM을 열 수 없습니다.");
        return;
      }
      const relayId = reason.match(/"channel_id":"([^"]+)"/)?.[1] ?? dmId;
      const dm: Channel = { id: relayId, name: "", about: "다이렉트 메시지", isPrivate: true, isDm: true, createdAt: nowInSeconds(), participants: [ownPubkey, pubkey] };
      setDms((current) => (current.some((item) => item.id === dm.id) ? current : [dm, ...current]));
      subscribeToChannel(dm);
    };
    sendFrame(["EVENT", event]);
  };

  const toggleReaction = (targetId: string, emoji: string) => {
    const key = secretRef.current;
    if (!key || !activeChannel || sending) return;
    setPickerFor("");

    const own = (reactions[targetId] ?? []).find((item) => item.pubkey === pubkeyRef.current && item.emoji === emoji);
    try {
      if (own) {
        const deletion = finalizeEvent({
          kind: 5,
          created_at: nowInSeconds(),
          content: "",
          tags: [["e", own.id]],
        }, key);
        sendFrame(["EVENT", deletion]);
        setReactions((current) => ({
          ...current,
          [targetId]: (current[targetId] ?? []).filter((item) => item.id !== own.id),
        }));
        return;
      }

      const reaction = finalizeEvent({
        kind: 7,
        created_at: nowInSeconds(),
        content: emoji,
        tags: [["e", targetId], ["h", activeChannel.id]],
      }, key);
      sendFrame(["EVENT", reaction]);
      setReactions((current) => ({
        ...current,
        [targetId]: [...(current[targetId] ?? []), { id: reaction.id, emoji, pubkey: pubkeyRef.current }],
      }));
    } catch (reactionError) {
      setNotice(reactionError instanceof Error ? reactionError.message : "반응을 보내지 못했습니다.");
    }
  };

  const handleComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setAuthMode(hasStoredKey() ? "locked" : "setup"), 0);
    return () => {
      window.clearTimeout(timer);
      socketRef.current?.close();
      secretRef.current?.fill(0);
      if (authTimerRef.current) clearTimeout(authTimerRef.current);
    };
  }, []);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [visibleMessages.length, activeChannel?.id]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const connectionLabel = useMemo(() => {
    if (status === "connecting") return "연결 중";
    if (status === "authenticating") return "인증 중";
    if (status === "connected") return "연결됨";
    if (status === "error") return "연결 오류";
    return "오프라인";
  }, [status]);

  return (
    <main className={`app-shell ${!isConnected ? "preview-mode" : ""}`}>
      <aside className="workspace-rail" aria-label="워크스페이스">
        <div className="brand-mark" aria-label="Buzz Web">B</div>
        <div className="rail-spacer" />
        <button className="avatar-button" aria-label="내 프로필" title={ownName}>{initials(ownName)}</button>
      </aside>

      <aside className={`channel-sidebar ${drawerOpen ? "drawer-open" : ""}`}>
        <div className="workspace-title">
          <div><span className="eyebrow">WORKSPACE</span><h1>{workspaceName}</h1></div>
          <span className={`status-pill ${status}`}><i /> {connectionLabel}</span>
        </div>
        <nav className="channel-nav" aria-label="채널">
          <p className="nav-label">CHANNELS <span>{visibleChannels.length}</span></p>
          {visibleChannels.map((channel) => (
            <button
              key={channel.id}
              className={`channel-link ${visibleActive?.id === channel.id ? "active" : ""}`}
              onClick={() => isConnected && subscribeToChannel(channel)}
              disabled={!isConnected}
            >
              <span className="hash">{channel.isPrivate ? "⌑" : "#"}</span><span className="channel-name">{channel.name}</span>
            </button>
          ))}
          {isConnected && channels.length === 0 && <p className="empty-channels">볼 수 있는 채널이 없습니다.</p>}
        </nav>
        {isConnected && (
          <nav className="channel-nav dm-nav" aria-label="다이렉트 메시지">
            <p className="nav-label">DIRECT MESSAGES <span>{dms.length}</span></p>
            {dms.map((dm) => (
              <button
                key={dm.id}
                className={`channel-link dm ${visibleActive?.id === dm.id ? "active" : ""}`}
                onClick={() => subscribeToChannel(dm)}
              >
                <span className="hash">✉</span><span className="channel-name">{dmNames.get(dm.id) || shortPubkey(dm.participants?.[0] ?? dm.id)}</span>
              </button>
            ))}
          </nav>
        )}
        <div className="sidebar-note">
          <span className="note-icon">↗</span>
          <div><strong>브라우저에서 바로</strong><p>설치 없이 Buzz에 연결했어요.</p></div>
        </div>
        {isConnected && <button className="disconnect-button" onClick={lock}>잠금</button>}
      </aside>

      {drawerOpen && <button className="drawer-backdrop" aria-label="채널 메뉴 닫기" onClick={() => setDrawerOpen(false)} />}

      <section className="chat-panel">
        <header className="chat-header">
          <button className="mobile-menu" aria-label="채널 메뉴" onClick={() => setDrawerOpen(true)}><span /><span /><span /></button>
          <div className="channel-heading">
            <h2><span>{visibleActive?.isDm ? "✉" : visibleActive?.isPrivate ? "⌑" : "#"}</span> {activeHeadingName || "채널을 선택하세요"}</h2>
            <p>{visibleActive?.about || "연결한 relay의 채널이 여기에 표시됩니다."}</p>
          </div>
          <div className="header-actions">
            {isConnected && <span className="member-count"><i className="member-dot one" /><i className="member-dot two" /><i className="member-dot three" /> {memberCount || "—"}</span>}
            <button aria-label="채널 멤버" onClick={() => setMembersOpen((value) => !value)}>•••</button>
          </div>
        </header>

        <div className="message-list">
          <div className="channel-intro">
            <div className="intro-hash">{visibleActive?.isPrivate ? "⌑" : "#"}</div>
            <h3>{activeHeadingName || "Buzz"}에 오신 걸 환영해요</h3>
            <p>{visibleActive?.about || "사람과 에이전트가 같은 공간에서 함께 일해요."}</p>
          </div>
          <div className="date-rule"><span>최근 메시지</span></div>

          {visibleMessages.map((message) => {
            const profile = visibleProfiles[message.pubkey];
            const name = profile?.name || shortPubkey(message.pubkey);
            const replyTargetId = findTag(message, "e");
            if (replyTargetId && messagesById.has(replyTargetId)) return null;
            const parent = replyTargetId ? messagesById.get(replyTargetId) : undefined;
            const parentName = parent ? (profiles[parent.pubkey]?.name || shortPubkey(parent.pubkey)) : null;
            const threadReplies = repliesByRoot.get(message.id) ?? [];
            const grouped = new Map<string, string[]>();
            for (const item of reactions[message.id] ?? []) {
              grouped.set(item.emoji, [...(grouped.get(item.emoji) ?? []), item.pubkey]);
            }
            return (
              <article className="message" key={message.id}>
                {profile?.picture ? (
                  // External relay profile images have arbitrary hosts, so next/image cannot safely preconfigure them.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="message-avatar image" src={profile.picture} alt="" />
                ) : <div className={`message-avatar ${avatarTone(message.pubkey)}`}>{initials(name)}</div>}
                <div className="message-body">
                  <div className="message-meta"><strong>{name}</strong>{profile?.isAgent && <span className="agent-badge">AGENT</span>}<time>{formatTime(message.created_at)}</time></div>
                  {replyTargetId && (
                    <p className="reply-context">↩ {parentName ? `${parentName}: ${messageText(parent.content).slice(0, 80)}` : shortPubkey(replyTargetId)}</p>
                  )}
                  <p>{segmentMentions(messageText(message.content), memberProfiles).map((segment, index) => (
                    segment.mention ? <span key={index} className="mention-token">{segment.text}</span> : <span key={index}>{segment.text}</span>
                  ))}</p>
                  {(grouped.size > 0 || (isConnected && activeChannel)) && (
                    <div className="reaction-row">
                      {[...grouped.entries()].map(([emoji, pubkeys]) => (
                        <button
                          key={emoji}
                          className={`reaction-chip ${pubkeys.includes(ownPubkey) ? "own" : ""}`}
                          disabled={!isConnected || !activeChannel}
                          onClick={() => toggleReaction(message.id, emoji)}
                        >
                          {emoji} {pubkeys.length}
                        </button>
                      ))}
                      {isConnected && activeChannel && (
                        <button
                          className={`reaction-add ${pickerFor === message.id ? "open" : ""}`}
                          aria-label="반응 추가"
                          disabled={sending}
                          onClick={() => setPickerFor((current) => (current === message.id ? "" : message.id))}
                        >＋</button>
                      )}
                    </div>
                  )}
                  {pickerFor === message.id && (
                    <div className="reaction-picker" role="menu">
                      {REACTION_EMOJIS.map((emoji) => (
                        <button key={emoji} onClick={() => toggleReaction(message.id, emoji)} aria-label={`반응 ${emoji}`}>{emoji}</button>
                      ))}
                    </div>
                  )}
                  {threadReplies.length > 0 && (
                    <button
                      className={`thread-indicator ${openThreadId === message.id ? "active" : ""}`}
                      onClick={() => {
                        setOpenThreadId(message.id);
                        setThreadTarget(null);
                      }}
                    >
                      <span className="thread-avatars">
                        {[...new Set(threadReplies.map((item) => item.pubkey))].slice(0, 3).map((pubkey) => (
                          <span key={pubkey} className={`thread-avatar ${avatarTone(pubkey)}`}>{initials(visibleProfiles[pubkey]?.name || shortPubkey(pubkey))}</span>
                        ))}
                      </span>
                      답글 {threadReplies.length}개
                    </button>
                  )}
                </div>
                {isConnected && activeChannel && (
                  <div className="message-actions">
                    <button aria-label="스레드 열기" onClick={() => { setOpenThreadId(message.id); setThreadTarget(null); }}>💬</button>
                    <button aria-label="답장" onClick={() => setReplyTo(message)}>↩</button>
                    {isConnected && message.pubkey !== ownPubkey && (
                      <button aria-label="DM 보내기" disabled={dmBusy} onClick={() => openDm(message.pubkey)}>✉</button>
                    )}
                    <button aria-label="반응" onClick={() => setPickerFor((current) => (current === message.id ? "" : message.id))}>☺</button>
                  </div>
                )}
              </article>
            );
          })}
          {isConnected && activeChannel && messages.length === 0 && <div className="empty-messages"><span>⋯</span><p>아직 메시지가 없습니다. 첫 메시지를 남겨보세요.</p></div>}
          <div ref={messageEndRef} />
        </div>

        <div className="composer-wrap">
          {replyTo && (
            <div className="reply-bar">
              <span className="reply-arrow">↩</span>
              <div className="reply-preview">
                <strong>{visibleProfiles[replyTo.pubkey]?.name || shortPubkey(replyTo.pubkey)}</strong>
                <p>{messageText(replyTo.content).slice(0, 90) || "빈 메시지"}</p>
              </div>
              <button aria-label="답장 취소" onClick={() => setReplyTo(null)}>×</button>
            </div>
          )}
          <div className={`composer ${!isConnected || !activeChannel ? "disabled" : ""}`}>
            <span className="composer-plus">＋</span>
            <textarea
              aria-label="메시지"
              placeholder={isConnected ? (activeChannel?.isDm ? `${activeHeadingName || "상대"}에게 메시지 보내기` : `#${activeChannel?.name || "channel"}에 메시지 보내기`) : "relay에 연결하면 메시지를 보낼 수 있어요"}
              rows={1}
              value={composer}
              disabled={!isConnected || !activeChannel}
              onChange={(event) => { setComposer(event.target.value); updateMentionState("main", event.target.value, event.target.selectionStart ?? event.target.value.length); }}
              onKeyDown={(event) => {
                if (mentionState && mentionCandidates.length) {
                  if (event.key === "Escape") { setMentionState(null); return; }
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    insertMention(mentionCandidates[0]);
                    return;
                  }
                }
                handleComposerKey(event);
              }}
            />
            {mentionState?.field === "main" && mentionCandidates.length > 0 && (
              <div className="mention-popup" role="listbox">
                {mentionCandidates.map((candidate) => (
                  <button key={candidate.pubkey} role="option" aria-selected={false} onClick={() => insertMention(candidate)}>
                    <span className={`message-avatar ${avatarTone(candidate.pubkey)}`}>{initials(candidate.profile.name)}</span>
                    <span className="mention-candidate-name">{candidate.profile.name}</span>
                    {candidate.profile.isAgent && <span className="agent-badge">AGENT</span>}
                  </button>
                ))}
              </div>
            )}
            <span className="composer-hint">Shift + Enter</span>
            <button className="send-button" aria-label="메시지 보내기" disabled={!composer.trim() || sending || !isConnected} onClick={sendMessage}>↑</button>
          </div>
          <p className="security-note"><span>◇</span> 메시지는 연결한 Buzz relay에만 저장됩니다.</p>
        </div>
      </section>

      {membersOpen && isConnected && activeChannel && (
        <section className="members-panel" aria-label="채널 멤버">
          <header className="thread-header">
            <button className="thread-close" aria-label="멤버 패널 닫기" onClick={() => setMembersOpen(false)}>×</button>
            <div>
              <span className="eyebrow">MEMBERS</span>
              <h3>{memberPubkeys.length}명 · {visibleActive?.name}</h3>
            </div>
          </header>
          <div className="members-list">
            {memberPubkeys.map((pubkey) => (
              <div key={pubkey} className="member-row">
                {profiles[pubkey]?.picture ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="message-avatar image" src={profiles[pubkey].picture} alt="" />
                ) : <div className={`message-avatar ${avatarTone(pubkey)}`}>{initials(profiles[pubkey]?.name || shortPubkey(pubkey))}</div>}
                <span className="mention-candidate-name">{profiles[pubkey]?.name || shortPubkey(pubkey)}</span>
                {profiles[pubkey]?.isAgent && <span className="agent-badge">AGENT</span>}
                {pubkey === ownPubkey ? (
                  <span className="member-you">나</span>
                ) : (
                  <div className="member-row-actions">
                    <button aria-label="DM 보내기" disabled={dmBusy} onClick={() => openDm(pubkey)}>✉</button>
                    <button aria-label="멤버 제거" onClick={() => removeMemberFromChannel(pubkey)}>✕</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="members-add">
            <label className="field-label" htmlFor="add-member">멤버 추가 (에이전트 포함)</label>
            <div className="field-shell">
              <input
                id="add-member"
                value={addMemberInput}
                placeholder="npub1… 또는 hex 공개키"
                autoCapitalize="none" autoCorrect="off" spellCheck={false}
                onChange={(event) => setAddMemberInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") addMemberToChannel(); }}
              />
            </div>
            <button className="connect-button small" onClick={addMemberToChannel} disabled={!addMemberInput.trim()}>추가</button>
            <p className="members-hint">에이전트 공개키는 Buzz 앱의 프로필에서 확인하거나, 멤버 목록의 에이전트를 다른 채널에서 ✉/복사로 가져올 수 있어요.</p>
          </div>
        </section>
      )}

      {openThread && (
        <section className="thread-panel" aria-label="스레드">
          <header className="thread-header">
            <button className="thread-close" aria-label="스레드 닫기" onClick={() => setOpenThreadId("")}>×</button>
            <div>
              <span className="eyebrow">THREAD</span>
              <h3>{visibleActive?.isDm ? "" : "#"}{activeHeadingName || "channel"}의 스레드</h3>
            </div>
          </header>

          <div className="thread-scroll">
            <div
              className={`thread-message root ${threadTarget?.id === openThread.id || !threadTarget ? "focused" : ""}`}
              role="button" tabIndex={0}
              onClick={() => setThreadTarget(openThread)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setThreadTarget(openThread); }}
            >
              <div className={`message-avatar ${avatarTone(openThread.pubkey)}`}>{initials(visibleProfiles[openThread.pubkey]?.name || shortPubkey(openThread.pubkey))}</div>
              <div className="message-body">
                <div className="message-meta"><strong>{visibleProfiles[openThread.pubkey]?.name || shortPubkey(openThread.pubkey)}</strong><time>{formatTime(openThread.created_at)}</time></div>
                <p>{segmentMentions(messageText(openThread.content), memberProfiles).map((segment, index) => (
                  segment.mention ? <span key={index} className="mention-token">{segment.text}</span> : <span key={index}>{segment.text}</span>
                ))}</p>
              </div>
            </div>

            {openThreadReplies.length > 0 && <div className="thread-divider"><span>{openThreadReplies.length}개 답글</span></div>}

            {openThreadReplies.map((reply) => (
              <div
                key={reply.id}
                className={`thread-message ${threadTarget?.id === reply.id ? "focused" : ""}`}
                role="button" tabIndex={0}
                onClick={() => setThreadTarget(reply)}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setThreadTarget(reply); }}
              >
                <div className={`message-avatar ${avatarTone(reply.pubkey)}`}>{initials(visibleProfiles[reply.pubkey]?.name || shortPubkey(reply.pubkey))}</div>
                <div className="message-body">
                  <div className="message-meta"><strong>{visibleProfiles[reply.pubkey]?.name || shortPubkey(reply.pubkey)}</strong>{visibleProfiles[reply.pubkey]?.isAgent && <span className="agent-badge">AGENT</span>}<time>{formatTime(reply.created_at)}</time></div>
                  <p>{segmentMentions(messageText(reply.content), memberProfiles).map((segment, index) => (
                    segment.mention ? <span key={index} className="mention-token">{segment.text}</span> : <span key={index}>{segment.text}</span>
                  ))}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="thread-composer-wrap">
            {threadTarget && threadTarget.id !== openThread.id && (
              <div className="reply-bar">
                <span className="reply-arrow">↩</span>
                <div className="reply-preview">
                  <strong>{visibleProfiles[threadTarget.pubkey]?.name || shortPubkey(threadTarget.pubkey)}</strong>
                  <p>{messageText(threadTarget.content).slice(0, 90) || "빈 메시지"}</p>
                </div>
                <button aria-label="답장 대상 초기화" onClick={() => setThreadTarget(openThread)}>↺</button>
              </div>
            )}
            <div className={`composer ${!isConnected || !activeChannel ? "disabled" : ""}`}>
              <textarea
                aria-label="스레드 답글"
                placeholder="스레드에 답글 달기"
                rows={1}
                value={threadComposer}
                disabled={!isConnected || !activeChannel}
                onChange={(event) => { setThreadComposer(event.target.value); updateMentionState("thread", event.target.value, event.target.selectionStart ?? event.target.value.length); }}
                onKeyDown={(event) => {
                  if (mentionState && mentionCandidates.length) {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      insertMention(mentionCandidates[0]);
                      return;
                    }
                    if (event.key === "Escape") { setMentionState(null); return; }
                  }
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    sendThreadMessage();
                  }
                  if (event.key === "Escape") setOpenThreadId("");
                }}
              />
              {mentionState?.field === "thread" && mentionCandidates.length > 0 && (
                <div className="mention-popup" role="listbox">
                  {mentionCandidates.map((candidate) => (
                    <button key={candidate.pubkey} role="option" aria-selected={false} onClick={() => insertMention(candidate)}>
                      <span className={`message-avatar ${avatarTone(candidate.pubkey)}`}>{initials(candidate.profile.name)}</span>
                      <span className="mention-candidate-name">{candidate.profile.name}</span>
                      {candidate.profile.isAgent && <span className="agent-badge">AGENT</span>}
                    </button>
                  ))}
                </div>
              )}
              <span className="composer-hint">Shift + Enter</span>
              <button className="send-button" aria-label="답글 보내기" disabled={!threadComposer.trim() || sending || !isConnected} onClick={sendThreadMessage}>↑</button>
            </div>
          </div>
        </section>
      )}

      {(authMode === "setup" || authMode === "locked") && (
        <div className="connect-layer">
          {authMode === "setup" ? (
            <form className="connect-card" onSubmit={handleSetup}>
              <div className="connect-brand"><span>B</span><div><strong>Buzz Web</strong><small>TABLET CLIENT</small></div></div>
              <div className="connect-copy">
                <span className="beta-label">FIRST TIME SETUP</span>
                <h2>이 기기에 계정 추가</h2>
                <p>개인키는 비밀번호로 암호화해 이 브라우저에만 저장됩니다. 서버에는 저장되지 않아요.</p>
              </div>

              <div className="key-label-row"><label className="field-label" htmlFor="private-key">Nostr 개인키</label><span>평문 저장 안 함</span></div>
              <div className="field-shell"><span className="field-icon key">◇</span><input id="private-key" type={showSecret ? "text" : "password"} value={secretInput} onChange={(event) => setSecretInput(event.target.value)} placeholder="nsec1… 또는 64자리 hex" autoComplete="off" autoCapitalize="none" spellCheck={false} /><button type="button" className="reveal-key" onClick={() => setShowSecret((value) => !value)}>{showSecret ? "숨김" : "보기"}</button></div>

              <label className="field-label" htmlFor="new-password">비밀번호</label>
              <div className="field-shell"><span className="field-icon">◈</span><input id="new-password" type="password" value={passwordInput} onChange={(event) => setPasswordInput(event.target.value)} placeholder="키를 잠글 비밀번호" autoComplete="new-password" /></div>

              <label className="field-label" htmlFor="password-confirm">비밀번호 확인</label>
              <div className="field-shell"><span className="field-icon">◈</span><input id="password-confirm" type="password" value={passwordConfirm} onChange={(event) => setPasswordConfirm(event.target.value)} placeholder="비밀번호 다시 입력" autoComplete="new-password" /></div>

              {error && <div className="connect-error" role="alert"><span>!</span>{error}</div>}
              <button className="connect-button" type="submit" disabled={authBusy || status === "connecting" || status === "authenticating"}>
                {authBusy || status === "connecting" || status === "authenticating" ? <><i /> {connectionLabel}</> : <>계정 저장하고 들어가기 <span>→</span></>}
              </button>
              <p className="connect-footnote"><span>●</span> 개인키는 브라우저에서 PBKDF2 + AES-GCM으로 암호화되며, 복호화는 이 기기에서만 일어납니다.</p>
            </form>
          ) : (
            <form className="connect-card" onSubmit={handleLogin}>
              <div className="connect-brand"><span>B</span><div><strong>Buzz Web</strong><small>TABLET CLIENT</small></div></div>
              <div className="connect-copy">
                <span className="beta-label">BUZZ</span>
                <h2>들어가기</h2>
                <p>{new URL(RELAY_URL).hostname}</p>
              </div>

              <label className="field-label" htmlFor="login-password">비밀번호</label>
              <div className="field-shell"><span className="field-icon">◈</span><input id="login-password" type="password" value={passwordInput} onChange={(event) => setPasswordInput(event.target.value)} placeholder="비밀번호 입력" autoComplete="current-password" ref={(input) => input?.focus()} /></div>

              {error && <div className="connect-error" role="alert"><span>!</span>{error}</div>}
              <button className="connect-button" type="submit" disabled={authBusy || status === "connecting" || status === "authenticating"}>
                {authBusy || status === "connecting" || status === "authenticating" ? <><i /> {connectionLabel}</> : <>들어가기 <span>→</span></>}
              </button>
              <button type="button" className="remove-account-button" onClick={removeAccount}>이 기기에서 계정 삭제</button>
              <p className="connect-footnote"><span>●</span> 비밀번호는 이 기기에서 키를 복호화하는 데만 사용됩니다.</p>
            </form>
          )}
        </div>
      )}

      {notice && <div className="toast" role="status"><span>i</span>{notice}<button onClick={() => setNotice("")} aria-label="알림 닫기">×</button></div>}
    </main>
  );
}
