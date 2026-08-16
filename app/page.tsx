"use client";

import {
  finalizeEvent,
  getPublicKey,
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
  return new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Seoul" }).format(new Date(timestamp * 1000));
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

  const isConnected = status === "connected";
  const visibleChannels = isConnected ? channels : DEMO_CHANNELS;
  const visibleMessages = isConnected ? messages : DEMO_MESSAGES;
  const visibleProfiles = isConnected ? profiles : DEMO_PROFILES;
  const visibleActive = isConnected ? activeChannel : DEMO_CHANNELS[0];
  const workspaceName = relayInfo.name || (connectedRelay ? new URL(connectedRelay).hostname : "My Buzz");

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
      } else if (profileSubRefs.current.has(idOrChallenge)) {
        sendFrame(["CLOSE", idOrChallenge]);
        profileSubRefs.current.delete(idOrChallenge);
      }
      return;
    }

    if (type === "OK" && typeof idOrChallenge === "string") {
      const accepted = payload === true;
      const reason = typeof frame[3] === "string" ? frame[3] : "";
      if (idOrChallenge === authEventIdRef.current && !accepted) {
        setError(reason || "relay가 인증을 거부했습니다.");
        setStatus("error");
      } else if (!accepted) {
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
    setMessages([]);
    setMemberPubkeys([]);
    setProfiles({});
    setActiveChannel(null);
    setRelayInfo({});
    setReactions({});
    setReplyTo(null);
    setPickerFor("");
    setNotice("");
    setError("");
  };

  const sendMessage = () => {
    const content = composer.trim();
    const key = secretRef.current;
    if (!content || !key || !activeChannel || sending) return;

    try {
      const tags: string[][] = [["h", activeChannel.id]];
      if (replyTo) tags.push(["e", replyTo.id, "", "reply"]);
      for (const pubkey of resolveMentions(content, memberProfiles)) tags.push(["p", pubkey]);
      const event = finalizeEvent({
        kind: 9,
        created_at: nowInSeconds(),
        content,
        tags,
      }, key);
      setSending(true);
      setComposer("");
      setReplyTo(null);
      setMessages((current) => [...current, event].sort((a, b) => a.created_at - b.created_at));
      sendFrame(["EVENT", event]);
      window.setTimeout(() => setSending(false), 5000);
    } catch (sendError) {
      setNotice(sendError instanceof Error ? sendError.message : "메시지를 보내지 못했습니다.");
      setSending(false);
    }
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
            <h2><span>{visibleActive?.isPrivate ? "⌑" : "#"}</span> {visibleActive?.name || "채널을 선택하세요"}</h2>
            <p>{visibleActive?.about || "연결한 relay의 채널이 여기에 표시됩니다."}</p>
          </div>
          <div className="header-actions">
            {isConnected && <span className="member-count"><i className="member-dot one" /><i className="member-dot two" /><i className="member-dot three" /> {memberCount || "—"}</span>}
            <button aria-label="채널 정보" onClick={() => setNotice(visibleActive?.id || "채널 정보가 없습니다.")}>•••</button>
          </div>
        </header>

        <div className="message-list">
          <div className="channel-intro">
            <div className="intro-hash">{visibleActive?.isPrivate ? "⌑" : "#"}</div>
            <h3>{visibleActive?.name || "Buzz"}에 오신 걸 환영해요</h3>
            <p>{visibleActive?.about || "사람과 에이전트가 같은 공간에서 함께 일해요."}</p>
          </div>
          <div className="date-rule"><span>최근 메시지</span></div>

          {visibleMessages.map((message) => {
            const profile = visibleProfiles[message.pubkey];
            const name = profile?.name || shortPubkey(message.pubkey);
            const replyTargetId = findTag(message, "e");
            const parent = replyTargetId ? messages.find((item) => item.id === replyTargetId) : undefined;
            const parentName = parent ? (profiles[parent.pubkey]?.name || shortPubkey(parent.pubkey)) : null;
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
                </div>
                {isConnected && activeChannel && (
                  <div className="message-actions">
                    <button aria-label="답장" onClick={() => setReplyTo(message)}>↩</button>
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
              placeholder={isConnected ? `#${activeChannel?.name || "channel"}에 메시지 보내기` : "relay에 연결하면 메시지를 보낼 수 있어요"}
              rows={1}
              value={composer}
              disabled={!isConnected || !activeChannel}
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={handleComposerKey}
            />
            <span className="composer-hint">Shift + Enter</span>
            <button className="send-button" aria-label="메시지 보내기" disabled={!composer.trim() || sending || !isConnected} onClick={sendMessage}>↑</button>
          </div>
          <p className="security-note"><span>◇</span> 메시지는 연결한 Buzz relay에만 저장됩니다.</p>
        </div>
      </section>

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
