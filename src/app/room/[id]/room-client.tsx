"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import TileMap, { type MapLine, type MapPoint } from "@/components/tile-map";
import { Icon } from "@/components/icons";
import { KEY_EVENT, loadApiConfig, openSettings } from "@/lib/api-key";
import {
  loadRoom,
  NEED_STRENGTH_LABEL,
  type CandidateScore,
  type NeedCheck,
  type Origin,
  type PlanResult,
  SAMPLE_CHAT,
  TRAVEL_LABEL,
} from "@/lib/meetmate";

type ApiError = {
  code?: string;
  error?: string;
  detail?: string | null;
  hint?: string;
};

type Bubble = {
  id: number;
  role: "ai" | "user";
  text: string;
  updated?: boolean;
};

type Phase = "loading" | "nokey" | "ready" | "error";

type OriginOverride = { originName: string; lat: number; lng: number };
type PlaceOption = { name: string; address: string; lat: number; lng: number };

const LOADING_STEPS = [
  "正在读懂群聊里每个人说了什么…",
  "正在把每个人的出发地落到地图上…",
  "正在按成员所在位置检索真实地点…",
  "正在算每人打车和坐地铁分别要多久、多少钱…",
];

function fmtMin(s: number | null) {
  if (s == null) return "";
  return `${Math.max(1, Math.round(s / 60))} 分钟`;
}

function fmtFare(f: number | null | undefined) {
  if (f == null) return "";
  return f === 0 ? "免费" : `¥${Math.round(f)}`;
}

export default function RoomClient({ roomId }: { roomId: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState("");
  const [chatting, setChatting] = useState(false);
  // 我自己的出发地：可选，只在群聊里一个人都没读到位置时当兜底锚点。
  // 没有任何预设校区可选项，必须由用户输入地名、走高德解析。
  const [myPlace, setMyPlace] = useState<Origin | null>(null);
  const [myOpen, setMyOpen] = useState(false);
  const [myQuery, setMyQuery] = useState("");
  const [myBusy, setMyBusy] = useState(false);
  const [myErr, setMyErr] = useState("");
  const [tick, setTick] = useState(0);
  const [demo, setDemo] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, OriginOverride>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeOptions, setPlaceOptions] = useState<PlaceOption[]>([]);
  const [placeBusy, setPlaceBusy] = useState(false);
  const [placeErr, setPlaceErr] = useState("");
  const [rerouting, setRerouting] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const reqId = useRef(0);

  const chatText = useMemo(() => {
    const room = loadRoom(roomId);
    return room.chat && room.chat.trim().length >= 10 ? room.chat : SAMPLE_CHAT;
  }, [roomId]);

  useEffect(() => {
    const room = loadRoom(roomId);
    setDemo(!(room.chat && room.chat.trim().length >= 10));
  }, [roomId]);

  const overrideList = useMemo(
    () =>
      Object.entries(overrides).map(([name, o]) => ({
        name,
        originName: o.originName,
        lat: o.lat,
        lng: o.lng,
      })),
    [overrides]
  );

  const run = useCallback(
    async (extra?: string[]) => {
      const my = ++reqId.current;
      const cfg = loadApiConfig();
      setErr(null);

      if (!cfg.key.trim()) {
        setPlan(null);
        setPhase("nokey");
        return;
      }

      setPhase("loading");
      setTick(0);
      try {
        const room = loadRoom(roomId);
        const res = await fetch("/api/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat: chatText,
            activityId: room.activityId ?? "food",
            origin: myPlace,
            config: cfg,
            amapKey: cfg.amapKey,
            extraConstraints: extra ?? [],
            memberOverrides: overrideList,
          }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          plan?: PlanResult;
        } & ApiError;
        if (my !== reqId.current) return;
        if (!res.ok || !data.ok || !data.plan) {
          setErr(data);
          setPhase("error");
          return;
        }
        setPlan(data.plan);
        setPhase("ready");
      } catch {
        if (my !== reqId.current) return;
        setErr({
          code: "NETWORK",
          error: "没能连上本地服务，确认 dev server 还在运行",
        });
        setPhase("error");
      }
    },
    [chatText, myPlace, roomId, overrideList]
  );

  useEffect(() => {
    void run();
    // 只在首次进入 / 换默认出发点 / 换房间时整链路重跑；
    // 成员位置变化走 reroute，不触发这里
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatText, myPlace, roomId]);

  useEffect(() => {
    const bump = () => void run();
    window.addEventListener(KEY_EVENT, bump);
    return () => window.removeEventListener(KEY_EVENT, bump);
  }, [run]);

  useEffect(() => {
    if (phase !== "loading") return;
    const timer = window.setInterval(
      () => setTick((v) => (v + 1) % LOADING_STEPS.length),
      2800
    );
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [bubbles, chatting]);

  const mapPoints = useMemo<MapPoint[]>(() => {
    if (!plan) {
      // 没有方案时不摆任何假点；用户填了自己的出发地才显示它
      return myPlace
        ? [
            {
              id: `me:${myPlace.name}`,
              name: `我 · ${myPlace.name}`,
              lat: myPlace.lat,
              lng: myPlace.lng,
              kind: "member" as const,
            },
          ]
        : [];
    }

    // 出发地没读到的人不落到地图上：画在市中心是假位置，容易误导
    const members: MapPoint[] = plan.members
      .filter((m) => m.resolved)
      .map((m) => ({
        id: `m:${m.name}`,
        name: m.name,
        lat: m.lat,
        lng: m.lng,
        kind: "member" as const,
        color: m.color,
        sub: m.originName,
      }));

    const candidates: MapPoint[] = plan.candidates
      .filter((c) => c.id !== plan.pick?.id)
      .slice(0, 8)
      .map((c) => ({
        id: `c:${c.id}`,
        name: c.name,
        lat: c.lat,
        lng: c.lng,
        kind: "candidate" as const,
      }));

    const spot: MapPoint[] = plan.pick
      ? [
          {
            id: "spot",
            name: plan.pick.name,
            lat: plan.pick.lat,
            lng: plan.pick.lng,
            kind: "spot" as const,
          },
        ]
      : [];

    return [...candidates, ...members, ...spot];
  }, [plan, myPlace]);

  const mapLines = useMemo<MapLine[]>(() => {
    if (!plan) return [];
    return plan.routes
      .filter((r) => r.points.length >= 2)
      .map((r) => ({
        id: r.name,
        color: r.color,
        points: r.points,
        // 坐地铁/公交的线路画成虚线，和路面打车区分开
        dashed: r.mode === "transit",
      }));
  }, [plan]);

  async function reroute(next: Record<string, OriginOverride>) {
    if (!plan) return;
    const cfg = loadApiConfig();
    setRerouting(true);
    setPlaceErr("");
    try {
      const res = await fetch("/api/reroute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan,
          memberOverrides: Object.entries(next).map(([name, o]) => ({
            name,
            ...o,
          })),
          config: cfg,
          amapKey: cfg.amapKey,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        plan?: PlanResult;
      } & ApiError;
      if (!res.ok || !data.ok || !data.plan) {
        setPlaceErr(data.error ?? "重算失败");
        return;
      }
      setPlan(data.plan);
    } catch {
      setPlaceErr("网络异常，位置没改成功");
    } finally {
      setRerouting(false);
    }
  }

  async function applyOrigin(
    name: string,
    originName: string,
    lat: number,
    lng: number
  ) {
    const next = { ...overrides, [name]: { originName, lat, lng } };
    setOverrides(next);
    setEditing(null);
    setPlaceQuery("");
    setPlaceOptions([]);
    await reroute(next);
  }

  /** 设置我自己的出发地：必须输入地名，由高德解析成坐标 */
  async function applyMyPlace() {
    const q = myQuery.trim();
    if (q.length < 2) {
      setMyErr("至少两个字，比如「文三路」");
      return;
    }
    const cfg = loadApiConfig();
    setMyBusy(true);
    setMyErr("");
    try {
      const res = await fetch("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q, amapKey: cfg.amapKey }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        name?: string;
        lat?: number;
        lng?: number;
        error?: string;
      };
      if (!res.ok || !data.ok || data.lat == null || data.lng == null) {
        setMyErr(data.error ?? "没能解析这个地点");
        return;
      }
      setMyPlace({ name: data.name ?? q, lat: data.lat, lng: data.lng });
      setMyOpen(false);
      setMyQuery("");
    } catch {
      setMyErr("网络异常，没解析成功");
    } finally {
      setMyBusy(false);
    }
  }

  async function searchPlace(name: string) {
    const q = placeQuery.trim();
    if (q.length < 2) {
      setPlaceErr("至少两个字，比如「文三路」");
      return;
    }
    const cfg = loadApiConfig();
    setPlaceBusy(true);
    setPlaceErr("");
    setPlaceOptions([]);
    try {
      // 先列出高德的真实候选，让人自己确认。
      // 地名常有歧义（「转塘」是镇、公交站、还是小区），猜一个不如让人点一个。
      const res = await fetch("/api/places", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q, amapKey: cfg.amapKey }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        items?: PlaceOption[];
        error?: string;
      };
      if (res.ok && data.ok && data.items?.length) {
        if (data.items.length === 1) {
          const one = data.items[0];
          await applyOrigin(name, one.name, one.lat, one.lng);
          return;
        }
        setPlaceOptions(data.items);
        return;
      }

      // 候选搜不到，退回单点解析（POI 打分 + 地理编码兜底）
      const res2 = await fetch("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q, amapKey: cfg.amapKey }),
      });
      const data2 = (await res2.json()) as {
        ok?: boolean;
        name?: string;
        lat?: number;
        lng?: number;
        error?: string;
      };
      if (!res2.ok || !data2.ok || data2.lat == null || data2.lng == null) {
        setPlaceErr(data2.error ?? data.error ?? "没能解析这个地点");
        return;
      }
      await applyOrigin(name, data2.name ?? q, data2.lat, data2.lng);
    } catch {
      setPlaceErr("网络异常，没解析成功");
    } finally {
      setPlaceBusy(false);
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || chatting) return;

    const cfg = loadApiConfig();
    if (!cfg.key.trim()) {
      setPhase("nokey");
      return;
    }

    const room = loadRoom(roomId);
    setBubbles((prev) => [...prev, { id: nextId.current++, role: "user", text }]);
    setDraft("");
    setChatting(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat: chatText,
          message: text,
          history: bubbles.slice(-6).map((b) => ({ role: b.role, text: b.text })),
          plan,
          activityId: room.activityId ?? "food",
          origin: myPlace,
          config: cfg,
          amapKey: cfg.amapKey,
          previousConstraints: plan?.hardConstraints ?? [],
          memberOverrides: overrideList,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        reply?: string;
        replanned?: boolean;
        plan?: PlanResult;
      } & ApiError;

      if (!res.ok || !data.ok) {
        setBubbles((prev) => [
          ...prev,
          {
            id: nextId.current++,
            role: "ai",
            text: `没能调整：${data.error ?? "接口异常"}${
              data.detail ? `（${data.detail}）` : ""
            }`,
          },
        ]);
        return;
      }

      setBubbles((prev) => [
        ...prev,
        {
          id: nextId.current++,
          role: "ai",
          text: data.reply ?? "已更新。",
          updated: Boolean(data.replanned),
        },
      ]);
      if (data.plan) setPlan(data.plan);
    } catch {
      setBubbles((prev) => [
        ...prev,
        { id: nextId.current++, role: "ai", text: "网络异常，这条没能发出去。" },
      ]);
    } finally {
      setChatting(false);
    }
  }

  const memberCount = plan?.members.length ?? null;

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-line px-5 py-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="text-base font-medium">MeetMate AI</span>
            <p className="mt-1 truncate text-xs text-fg-muted">
              房间 ID：<span className="font-mono">{roomId}</span>
              {memberCount ? ` · ${memberCount} 位成员` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {demo && (
              <span className="rounded-full bg-amber-400/12 px-3 py-1 text-xs text-amber-300">
                演示群聊
              </span>
            )}
            <span
              className={`rounded-full px-3 py-1 text-xs ${
                phase === "ready"
                  ? "bg-green/12 text-green"
                  : phase === "error"
                    ? "bg-amber-400/12 text-amber-300"
                    : "bg-white/6 text-fg-muted"
              }`}
            >
              {rerouting
                ? "重新检索中"
                : phase === "ready"
                  ? "方案已生成"
                  : phase === "error"
                    ? "出错了"
                    : phase === "nokey"
                      ? "待配置"
                      : "分析中"}
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-6xl flex-1 gap-4 px-5 py-5 lg:grid-cols-2">
        <section className="flex min-h-[460px] flex-col rounded-2xl border border-line bg-surface lg:min-h-[600px]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
            <h1 className="text-base font-semibold">AI 组局助手</h1>
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <span className="text-[10px] text-fg-dim">我的出发地</span>
              <button
                type="button"
                onClick={() => {
                  setMyOpen((v) => !v);
                  setMyErr("");
                }}
                title="只在群聊里一个人都没读到出发地时兜底；成员的位置始终以群聊为准"
                className="rounded-md border border-line px-2 py-1 text-[11px] text-fg-muted transition-colors hover:text-fg"
              >
                {myPlace ? myPlace.name : "未设置（可选）"}
              </button>
              {myPlace && (
                <button
                  type="button"
                  onClick={() => setMyPlace(null)}
                  className="text-[10px] text-fg-dim underline underline-offset-2 transition-colors hover:text-fg-muted"
                >
                  清除
                </button>
              )}
              {myOpen && (
                <div className="flex w-full items-center justify-end gap-1.5">
                  <input
                    value={myQuery}
                    onChange={(e) => setMyQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        void applyMyPlace();
                      }
                    }}
                    placeholder="输入地名，如「文三路」"
                    className="h-7 w-40 rounded-md border border-line bg-surface px-2 text-[11px] outline-none placeholder:text-fg-dim focus:border-green/40"
                  />
                  <button
                    type="button"
                    disabled={myBusy}
                    onClick={() => void applyMyPlace()}
                    className="rounded-md border border-line px-2 py-1 text-[10px] text-fg-muted transition-colors hover:text-fg disabled:opacity-40"
                  >
                    {myBusy ? "解析中" : "确定"}
                  </button>
                </div>
              )}
              {myErr && (
                <p className="w-full text-right text-[10px] text-amber-300">
                  {myErr}
                </p>
              )}
            </div>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
            {phase === "nokey" && <NoKeyCard />}
            {phase === "loading" && <LoadingCard text={LOADING_STEPS[tick]} />}
            {phase === "error" && <ErrorCard err={err} onRetry={() => void run()} />}

            {plan && (phase === "ready" || rerouting) && (
              <>
                <RequirementCard plan={plan} />
                <MemberPanel
                  plan={plan}
                  editing={editing}
                  placeQuery={placeQuery}
                  placeOptions={placeOptions}
                  placeBusy={placeBusy}
                  placeErr={placeErr}
                  rerouting={rerouting}
                  onEdit={(name) => {
                    setEditing(editing === name ? null : name);
                    setPlaceQuery("");
                    setPlaceOptions([]);
                    setPlaceErr("");
                  }}
                  onQuery={setPlaceQuery}
                  onSearch={(name) => void searchPlace(name)}
                  onPick={(name, o) => void applyOrigin(name, o.name, o.lat, o.lng)}
                />
                <NeedPanel plan={plan} />
                <PickCard plan={plan} />
                <RankingCard plan={plan} />
              </>
            )}

            {bubbles.map((b) =>
              b.role === "user" ? (
                <div key={b.id} className="flex justify-end">
                  <p className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-2 px-4 py-2.5 text-sm leading-relaxed">
                    {b.text}
                  </p>
                </div>
              ) : (
                <div key={b.id} className="space-y-1.5">
                  <p className="text-xs text-fg-dim">MeetMate AI</p>
                  <p className="text-sm leading-relaxed">{b.text}</p>
                  {b.updated && (
                    <p className="text-[11px] text-green">已重新检索并更新上面的方案</p>
                  )}
                </div>
              )
            )}

            {chatting && (
              <p className="flex items-center gap-2 text-[11px] text-fg-dim">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green" />
                正在理解你的新要求…
              </p>
            )}
            <div ref={endRef} />
          </div>

          <div className="border-t border-line p-3">
            <div className="flex items-end gap-2 rounded-xl border border-line bg-bg/60 p-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) void send();
                }}
                placeholder={
                  phase === "ready"
                    ? "提新要求，比如「人均降到 50」"
                    : "先配置 Key 才能对话"
                }
                disabled={phase === "nokey"}
                className="h-9 flex-1 bg-transparent px-2 text-sm outline-none placeholder:text-fg-dim disabled:cursor-not-allowed"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={chatting || phase === "nokey"}
                aria-label="发送"
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-2 text-fg-muted transition-colors hover:bg-white/10 hover:text-fg disabled:opacity-40"
              >
                <Icon name="send" size={16} />
              </button>
            </div>
          </div>
        </section>

        <section className="flex min-h-[460px] flex-col rounded-2xl border border-line bg-surface">
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
            <h2 className="text-base font-semibold">聚会地图</h2>
            <span className="rounded-full bg-white/5 px-2.5 py-0.5 text-[11px] text-fg-dim">
              可拖拽 · 滚轮缩放
            </span>
          </div>
          <div className="relative flex-1 overflow-hidden rounded-b-2xl">
            <TileMap points={mapPoints} lines={mapLines} />
            {rerouting && (
              <div className="pointer-events-none absolute inset-0 z-[600] flex items-center justify-center bg-black/40 backdrop-blur-[1px]">
                <span className="rounded-full bg-black/70 px-3 py-1.5 text-[11px] text-fg-muted">
                  正在按新位置重新检索地点并重算路程…
                </span>
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="mx-auto w-full max-w-6xl px-5 pb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-xs text-fg-dim">
          <span>
            条件与取舍理由由 AI 写，地点、路程、地铁票价、打车费全部来自高德实时接口；
            打车费按杭州起步价估算，人均与营业时间以商户实际为准。
          </span>
          <Link
            href={`/room/${roomId}/chat`}
            className="text-fg-muted underline underline-offset-4 hover:text-fg"
          >
            修改群聊
          </Link>
        </div>
      </div>
    </div>
  );
}

function NoKeyCard() {
  return (
    <div className="rounded-xl border border-dashed border-green/30 bg-green/[0.05] p-4">
      <p className="text-sm font-medium">需要先配一个 AI Key</p>
      <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">
        这一版不再用任何预设数据：每个人的条件、地点、路程全部实时算。
        填上你自己的 Key，点左下角齿轮即可；Key 只存在你这台浏览器里。
      </p>
      <button
        type="button"
        onClick={openSettings}
        className="mt-3 rounded-lg bg-green px-3 py-1.5 text-xs font-medium text-black transition-opacity hover:opacity-90"
      >
        去配置 Key
      </button>
    </div>
  );
}

function LoadingCard({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-line bg-bg/40 p-4">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green" />
        <span className="text-xs text-fg-muted">{text}</span>
      </div>
      <div className="mt-3 space-y-2">
        <div className="h-2.5 w-4/5 animate-pulse rounded bg-white/6" />
        <div className="h-2.5 w-3/5 animate-pulse rounded bg-white/6" />
        <div className="h-2.5 w-2/3 animate-pulse rounded bg-white/6" />
      </div>
      <p className="mt-3 text-[11px] text-fg-dim">
        成员越多，要算的路程越多，通常 10–20 秒。
      </p>
    </div>
  );
}

function ErrorCard({ err, onRetry }: { err: ApiError | null; onRetry: () => void }) {
  const needsKey = err?.code === "NO_KEY" || err?.code === "AUTH";
  return (
    <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-4">
      <p className="text-sm font-medium text-amber-300">
        {err?.error ?? "分析失败"}
      </p>
      {err?.detail && (
        <p className="mt-1.5 break-words rounded-lg bg-black/30 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-fg-muted">
          {err.detail}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
        >
          重试
        </button>
        {needsKey && (
          <button
            type="button"
            onClick={openSettings}
            className="rounded-lg bg-green px-3 py-1.5 text-xs font-medium text-black transition-opacity hover:opacity-90"
          >
            去检查 Key
          </button>
        )}
      </div>
    </div>
  );
}

function RequirementCard({ plan }: { plan: PlanResult }) {
  return (
    <div className="rounded-xl border border-line bg-bg/40 p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-fg-dim">
          从群聊读出的条件 · {plan.activityLabel}
        </p>
        <span className="rounded-md bg-white/6 px-1.5 py-0.5 text-[10px] text-fg-dim">
          {plan.trace.model}
        </span>
      </div>
      <ul className="mt-2.5 space-y-2 text-sm">
        {plan.requirements.map((r) => (
          <li key={r.label} className="flex gap-2 leading-relaxed">
            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-fg-muted" />
            <span>
              <span className="text-fg-muted">{r.label}：</span>
              {r.value}
            </span>
          </li>
        ))}
      </ul>

      {(plan.budget != null || plan.maxTravelMin != null) && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {plan.budget != null && (
            <span className="rounded-md bg-green/10 px-2 py-0.5 text-[11px] text-green">
              人均上限 ¥{plan.budget}
            </span>
          )}
          {plan.maxTravelMin != null && (
            <span className="rounded-md bg-white/6 px-2 py-0.5 text-[11px] text-fg-muted">
              单程上限 {plan.maxTravelMin} 分钟
            </span>
          )}
        </div>
      )}
      {(plan.hardConstraints.length > 0 || plan.softWishes.length > 0) && (
        <div className="mt-3 space-y-1.5 border-t border-line pt-2.5">
          {plan.hardConstraints.length > 0 && (
            <p className="text-[11px] leading-relaxed">
              <span className="text-amber-300">全体硬性条件</span>
              <span className="text-fg-muted">：{plan.hardConstraints.join(" · ")}</span>
            </p>
          )}
          {plan.softWishes.length > 0 && (
            <p className="text-[11px] leading-relaxed">
              <span className="text-fg-dim">全体期望</span>
              <span className="text-fg-muted">：{plan.softWishes.join(" · ")}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const VERDICT_STYLE: Record<
  NeedCheck["verdict"],
  { label: string; cls: string; dot: string }
> = {
  pass: { label: "满足", cls: "text-green", dot: "bg-green" },
  conflict: { label: "违背", cls: "text-red-400", dot: "bg-red-400" },
  unknown: { label: "待确认", cls: "text-fg-dim", dot: "bg-white/30" },
};

function NeedPanel({ plan }: { plan: PlanResult }) {
  const needs = plan.needs ?? [];
  if (!needs.length) {
    return (
      <div className="rounded-xl border border-line bg-bg/40 p-4">
        <p className="text-xs text-fg-dim">逐条核对</p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-fg-muted">
          这次没从群聊里拆出可逐条核对的要求，AI 可能只给了整体结论。换个说法或在对话里补充一句会更容易拆开。
        </p>
      </div>
    );
  }

  const checks = plan.pick?.checks ?? [];
  const pressure = plan.pressure ?? [];
  const maxWeight = Math.max(1, ...pressure.map((p) => p.weight));
  const groups = pressure
    .map((p) => ({
      ...p,
      items: checks.filter((c) => c.who === p.name),
    }))
    .filter((g) => g.items.length > 0);
  const globalItems = checks.filter((c) => !c.who);
  const counts = {
    pass: checks.filter((c) => c.verdict === "pass").length,
    conflict: checks.filter((c) => c.verdict === "conflict").length,
    unknown: checks.filter((c) => c.verdict === "unknown").length,
  };

  return (
    <div className="rounded-xl border border-line bg-bg/40 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-fg-dim">逐条核对 · 谁的要求更重</p>
        <span className="rounded-md bg-white/6 px-1.5 py-0.5 text-[10px] text-fg-dim">
          {needs.length} 条要求
        </span>
      </div>

      <div className="mt-2.5 space-y-1.5">
        {pressure
          .filter((p) => p.weight > 0)
          .map((p) => (
            <div key={p.name} className="flex items-center gap-2">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: p.color }}
              />
              <span className="w-9 shrink-0 text-[11px] text-fg-muted">{p.name}</span>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/8">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${Math.max(6, (p.weight / maxWeight) * 100)}%`,
                    background: p.color,
                  }}
                />
              </span>
              <span className="shrink-0 text-[10px] text-fg-dim">
                {p.top
                  .slice(0, 2)
                  .map((t) => t.category)
                  .join("·")}
                {p.hardCount > 0 ? ` · 硬 ${p.hardCount}` : ""}
              </span>
            </div>
          ))}
      </div>

      {plan.pick && (
        <p className="mt-3 border-t border-line pt-2.5 text-[10px] leading-relaxed text-fg-dim">
          以下是每条要求对着「{plan.pick.name}」的核对结果：满足 {counts.pass} · 违背{" "}
          {counts.conflict} · 数据判断不了 {counts.unknown}
        </p>
      )}

      <div className="mt-2 space-y-2.5">
        {groups.map((g) => (
          <div key={g.name}>
            <p className="text-[11px] text-fg-muted">
              <span
                className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
                style={{ background: g.color }}
              />
              {g.name}
            </p>
            <ul className="mt-1 space-y-1.5">
              {g.items.map((c) => (
                <li key={c.needId} className="rounded-lg border border-line/60 px-2 py-1.5">
                  <div className="flex items-start gap-1.5">
                    <span
                      className={`mt-0.5 shrink-0 rounded px-1 text-[10px] ${
                        c.strength === "hard"
                          ? "bg-amber-400/15 text-amber-300"
                          : c.strength === "strong"
                            ? "bg-white/8 text-fg-muted"
                            : "bg-white/4 text-fg-dim"
                      }`}
                    >
                      {NEED_STRENGTH_LABEL[c.strength]}
                    </span>
                    <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-fg">
                      {c.text}
                    </span>
                    <span
                      className={`shrink-0 text-[10px] ${VERDICT_STYLE[c.verdict].cls}`}
                    >
                      {VERDICT_STYLE[c.verdict].label}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-fg-dim">
                    原话「{c.quote}」
                  </p>
                  <p className="mt-0.5 flex items-start gap-1 text-[10px] leading-relaxed text-fg-muted">
                    <span
                      className={`mt-1 h-1 w-1 shrink-0 rounded-full ${
                        VERDICT_STYLE[c.verdict].dot
                      }`}
                    />
                    <span>
                      {c.evidence}
                      {c.source === "ai" && (
                        <span className="ml-1 text-fg-dim">（AI 判断）</span>
                      )}
                    </span>
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ))}

        {globalItems.length > 0 && (
          <div>
            <p className="text-[11px] text-fg-muted">全体</p>
            <ul className="mt-1 space-y-1.5">
              {globalItems.map((c) => (
                <li key={c.needId} className="rounded-lg border border-line/60 px-2 py-1.5">
                  <div className="flex items-start gap-1.5">
                    <span className="mt-0.5 shrink-0 rounded bg-white/8 px-1 text-[10px] text-fg-muted">
                      {NEED_STRENGTH_LABEL[c.strength]}
                    </span>
                    <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-fg">
                      {c.text}
                    </span>
                    <span
                      className={`shrink-0 text-[10px] ${VERDICT_STYLE[c.verdict].cls}`}
                    >
                      {VERDICT_STYLE[c.verdict].label}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-fg-dim">
                    {c.evidence}
                    {c.source === "ai" && "（AI 判断）"}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {counts.unknown > 0 && (
        <p className="mt-2.5 border-t border-line pt-2 text-[10px] leading-relaxed text-fg-dim">
          「待确认」不是没查，是商户资料里确实没有这项（比如辣不辣、吵不吵、卫生如何）。这类只能到店确认，我没有替你猜。
        </p>
      )}
    </div>
  );
}

function MemberPanel({
  plan,
  editing,
  placeQuery,
  placeOptions,
  placeBusy,
  placeErr,
  rerouting,
  onEdit,
  onQuery,
  onSearch,
  onPick,
}: {
  plan: PlanResult;
  editing: string | null;
  placeQuery: string;
  placeOptions: PlaceOption[];
  placeBusy: boolean;
  placeErr: string;
  rerouting: boolean;
  onEdit: (name: string) => void;
  onQuery: (v: string) => void;
  onSearch: (name: string) => void;
  onPick: (name: string, o: PlaceOption) => void;
}) {
  const unresolved = plan.members.filter((m) => !m.resolved);

  return (
    <div className="rounded-xl border border-line bg-bg/40 p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-fg-dim">
          参与的人 · 每人各有自己的位置和要求
        </p>
        <span
          className={`rounded-md px-1.5 py-0.5 text-[10px] ${
            plan.members.every((m) => m.resolved)
              ? "bg-white/6 text-fg-dim"
              : "bg-amber-400/12 text-amber-300"
          }`}
        >
          {plan.members.length} 人 · 已定位{" "}
          {plan.members.filter((m) => m.resolved).length}
        </span>
      </div>

      {unresolved.length > 0 && (
        <div className="mt-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-2.5 py-1.5">
          <p className="text-[10px] leading-relaxed text-amber-300">
            {unresolved.map((m) => m.name).join("、")} 的话里没读出出发地，这几个人
            {unresolved.length === plan.members.length
              ? "全部没有位置，检索暂时以城市中心为基准"
              : "不计入位置分布"}
            。点下面的「改位置」填一下，路程和推荐会立刻重算。
          </p>
        </div>
      )}

      <ul className="mt-2.5 space-y-2.5">
        {plan.members.map((m) => {
          const leg = plan.pick?.perMember.find((l) => l.name === m.name);
          const route = plan.routes.find((r) => r.name === m.name);
          const mode = route?.mode ?? leg?.mode ?? null;
          const durationS = route?.durationS ?? leg?.durationS ?? null;
          const fare = route?.fareYuan ?? leg?.fareYuan ?? null;
          const detail = route?.detail ?? leg?.detail ?? "";

          return (
            <li key={m.name} className="rounded-lg border border-line/60 bg-surface/40 p-2.5">
              <div className="flex items-start gap-2">
                <span
                  className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-black/40"
                  style={{ background: m.color }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-sm font-medium">{m.name}</span>
                    <span className="text-[11px] text-fg-dim">
                      {m.resolved ? `从${m.originName}出发` : "出发地未识别"}
                    </span>
                    {!m.resolved && (
                      <span className="rounded bg-amber-400/12 px-1 py-0.5 text-[10px] text-amber-300">
                        位置待确认
                      </span>
                    )}
                    {durationS != null && mode && (
                      <span className="rounded bg-green/12 px-1.5 py-0.5 text-[10px] text-green">
                        {TRAVEL_LABEL[mode]} {fmtMin(durationS)}
                        {fare != null && ` · ${fmtFare(fare)}`}
                      </span>
                    )}
                  </div>

                  {detail && (
                    <p className="mt-1 text-[10px] leading-relaxed text-fg-dim">
                      {detail}
                      {leg?.alt && (
                        <span>
                          {" "}
                          ｜另一种：{TRAVEL_LABEL[leg.alt.mode]}{" "}
                          {fmtMin(leg.alt.durationS)} · {fmtFare(leg.alt.fareYuan)}
                        </span>
                      )}
                    </p>
                  )}

                  {(m.constraints.length > 0 || m.wishes.length > 0) && (
                    <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
                      {m.constraints.length > 0 && (
                        <span className="text-amber-300/90">
                          {m.constraints.join("、")}
                        </span>
                      )}
                      {m.constraints.length > 0 && m.wishes.length > 0 && "；"}
                      {m.wishes.length > 0 && <span>想{m.wishes.join("、")}</span>}
                    </p>
                  )}

                  <p className="mt-0.5 text-[10px] leading-relaxed text-fg-dim">
                    {m.originSource === "chat" && m.originQuote
                      ? `原话「${m.originQuote}」`
                      : m.originSource === "ai"
                        ? "AI 从群聊里读到的出发地 · 没找到他的原话，建议核对"
                        : m.originSource === "override"
                          ? "手动指定的位置"
                          : m.originTried
                            ? `读到「${m.originTried}」，但高德没能定位到这个说法`
                            : "群聊里没有提到这个人的出发地"}
                  </p>

                  {m.resolved && m.originAddress && (
                    <p className="mt-0.5 truncate text-[10px] leading-relaxed text-fg-dim/80">
                      定位到 {m.originAddress}
                      <span className="text-fg-dim/60"> · 不对就点「改位置」</span>
                    </p>
                  )}

                  <button
                    type="button"
                    onClick={() => onEdit(m.name)}
                    className="mt-1 text-[10px] text-fg-dim underline underline-offset-2 transition-colors hover:text-fg-muted"
                  >
                    {editing === m.name ? "收起" : "改位置"}
                  </button>

                  {editing === m.name && (
                    <div className="mt-2 space-y-1.5 rounded-lg border border-line bg-bg/60 p-2">
                      <div className="flex items-center gap-1.5">
                        <input
                          value={placeQuery}
                          onChange={(e) => onQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                              onSearch(m.name);
                            }
                          }}
                          placeholder="或输入地点，如「文三路」"
                          className="h-7 flex-1 rounded-md border border-line bg-surface px-2 text-[11px] outline-none placeholder:text-fg-dim focus:border-green/40"
                        />
                        <button
                          type="button"
                          disabled={placeBusy || rerouting}
                          onClick={() => onSearch(m.name)}
                          className="rounded-md border border-line px-2 py-1 text-[10px] text-fg-muted transition-colors hover:text-fg disabled:opacity-40"
                        >
                          {placeBusy ? "解析中" : "搜索"}
                        </button>
                      </div>
                      {placeErr && (
                        <p className="text-[10px] text-amber-300">{placeErr}</p>
                      )}

                      {placeOptions.length > 0 && (
                        <div className="space-y-1">
                          <p className="text-[10px] text-fg-dim">
                            高德搜到这些，点一个就是他的出发地：
                          </p>
                          {placeOptions.map((o, idx) => (
                            <button
                              key={`${o.name}-${idx}`}
                              type="button"
                              disabled={rerouting}
                              onClick={() => onPick(m.name, o)}
                              className="block w-full rounded-md border border-line bg-surface/60 px-2 py-1.5 text-left transition-colors hover:border-green/40 disabled:opacity-40"
                            >
                              <span className="block truncate text-[11px] text-fg">
                                {o.name}
                              </span>
                              <span className="block truncate text-[10px] text-fg-dim">
                                {o.address || "高德未提供详细地址"}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-2.5 text-[10px] leading-relaxed text-fg-dim">
        改了位置会围绕新位置重新检索地点，并重算每人的打车/地铁时间与车费，不会重新读群聊。
      </p>
    </div>
  );
}

function PickCard({ plan }: { plan: PlanResult }) {
  if (!plan.pick) return null;
  const p = plan.pick;
  const facts = [
    p.cost ? `人均 ${p.cost} 元` : "人均未标注",
    p.rating ? `评分 ${p.rating}` : null,
    p.openTime ? `营业 ${p.openTime}` : null,
  ].filter(Boolean) as string[];

  const legs = p.perMember.filter((l) => l.durationS != null);
  const sc = p.score;
  const parts = sc
    ? [
        { key: "需求", v: sc.parts.needs },
        { key: "通勤", v: sc.parts.travel },
        { key: "均衡", v: sc.parts.fairness },
        { key: "花钱", v: sc.parts.cost },
        { key: "口碑", v: sc.parts.quality },
      ]
    : [];

  return (
    <div className="rounded-xl border border-green/30 bg-green/[0.06] p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded-md bg-green/15 px-2 py-0.5 text-[11px] text-green">
          高德实时检索 · 推荐
        </span>
        {sc && (
          <span className="rounded-md bg-black/25 px-2 py-0.5 text-[11px] text-green">
            综合 {sc.score} 分
          </span>
        )}
      </div>
      <p className="mt-2.5 text-base font-semibold">{p.name}</p>
      <p className="mt-1 text-xs text-fg-muted">
        {p.type || "类型未知"}
        {p.address ? ` · ${p.address}` : ""}
      </p>

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {facts.map((f) => (
          <span
            key={f}
            className="rounded-md bg-white/6 px-2 py-0.5 text-[11px] text-fg-muted"
          >
            {f}
          </span>
        ))}
      </div>

      {legs.length > 0 && (
        <div className="mt-3 rounded-lg border border-white/8 bg-black/20 p-2.5">
          <p className="text-[10px] text-fg-dim">
            每人怎么去 · 打车和地铁都算过，取更划算的那条
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {legs.map((l) => (
              <li key={l.name} className="text-[11px]">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: l.color }}
                  />
                  <span className="w-10 shrink-0 text-fg-muted">{l.name}</span>
                  {l.mode && (
                    <span className="rounded bg-white/6 px-1 text-[10px] text-fg-dim">
                      {TRAVEL_LABEL[l.mode]}
                    </span>
                  )}
                  <span className="text-fg">{fmtMin(l.durationS)}</span>
                  {l.fareYuan != null && (
                    <span className="text-fg-dim">· {fmtFare(l.fareYuan)}</span>
                  )}
                </div>
                {l.detail && (
                  <p className="ml-[3.4rem] mt-0.5 text-[10px] leading-relaxed text-fg-dim">
                    {l.detail}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {sc && sc.worstMin != null && (
            <p className="mt-2 border-t border-white/8 pt-1.5 text-[10px] leading-relaxed text-fg-dim">
              最远 {sc.worstName} {sc.worstMin} 分钟 · 平均 {sc.avgMin} 分钟 · 首尾差{" "}
              {sc.spreadMin} 分钟
            </p>
          )}
        </div>
      )}

      {sc && (
        <div className="mt-2.5 rounded-lg border border-white/8 bg-black/20 p-2.5">
          <p className="text-[10px] text-fg-dim">为什么是这家 · 打分拆解</p>
          <div className="mt-1.5 space-y-1">
            {parts.map((x) => (
              <div key={x.key} className="flex items-center gap-2">
                <span className="w-7 shrink-0 text-[10px] text-fg-muted">
                  {x.key}
                </span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/8">
                  <span
                    className="block h-full rounded-full bg-green/70"
                    style={{ width: `${Math.max(2, x.v)}%` }}
                  />
                </span>
                <span className="w-6 shrink-0 text-right text-[10px] tabular-nums text-fg-dim">
                  {x.v}
                </span>
              </div>
            ))}
          </div>
          {sc.totalPerPerson != null && (
            <p className="mt-2 border-t border-white/8 pt-1.5 text-[11px] leading-relaxed text-fg-muted">
              每人总花费（含往返车费）约{" "}
              <span className="text-green">{sc.totalPerPerson} 元</span>
              {plan.budget != null
                ? sc.totalPerPerson <= plan.budget
                  ? "，在预算内"
                  : `，比预算多 ${sc.totalPerPerson - plan.budget} 元`
                : ""}
            </p>
          )}
        </div>
      )}

      <p className="mt-3 text-sm leading-relaxed text-fg-muted">{p.reason}</p>
      {plan.trace.decisionFallback && (
        <p className="mt-1 text-[10px] leading-relaxed text-amber-300/80">
          AI 这次没返回理由（可能超时或额度用尽），上面是按综合分排序第一直接给出的结果。
        </p>
      )}
      {(p.checks?.length ?? 0) > 0 && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-fg-dim">
          需求核对：满足 {p.checks.filter((c) => c.verdict === "pass").length} 条 · 违背{" "}
          {p.checks.filter((c) => c.verdict === "conflict").length} 条 · 数据判断不了{" "}
          {p.checks.filter((c) => c.verdict === "unknown").length} 条
        </p>
      )}

      {p.matchPoints.length > 0 && (
        <ul className="mt-2.5 space-y-1">
          {p.matchPoints.map((m) => (
            <li key={m} className="flex gap-1.5 text-[11px] leading-relaxed text-fg-muted">
              <Icon name="check" size={11} className="mt-0.5 shrink-0 text-green" />
              <span>{m}</span>
            </li>
          ))}
        </ul>
      )}

      {p.cautions.length > 0 && (
        <ul className="mt-2 space-y-1">
          {p.cautions.map((c) => (
            <li key={c} className="text-[11px] leading-relaxed text-amber-300/90">
              注意：{c}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/8 pt-2.5 text-[11px] text-fg-dim">
        {p.tel && <span>电话 {p.tel.split(";")[0]}</span>}
        <span className="font-mono">
          {p.lat.toFixed(5)}, {p.lng.toFixed(5)}
        </span>
      </div>
    </div>
  );
}

/** 榜单上的一行。资料查不全的店统一挂「备选」标，一眼能看出为什么没选它 */
function RankRow({
  r,
  index,
  current,
}: {
  r: CandidateScore;
  index?: number;
  current?: boolean;
}) {
  return (
    <li
      className={`rounded-lg border px-2.5 py-2 ${
        current ? "border-green/40 bg-green/[0.06]" : "border-line/60"
      }`}
    >
      <div className="flex items-center gap-2">
        {index != null && (
          <span className="w-3 shrink-0 text-[10px] tabular-nums text-fg-dim">
            {index}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[13px]">{r.name}</span>
        {r.clear === false && !r.rejected && !current && (
          <span className="shrink-0 rounded border border-amber-300/40 px-1 py-[1px] text-[9px] text-amber-300/90">
            备选 · 资料不全
          </span>
        )}
        <span
          className={`shrink-0 text-[11px] tabular-nums ${
            current ? "text-green" : "text-fg-muted"
          }`}
        >
          {r.score} 分
        </span>
      </div>
      <p className="mt-0.5 pl-5 text-[10px] leading-relaxed text-fg-dim">
        最远 {r.worstName} {r.worstMin ?? "?"} 分钟 · 平均 {r.avgMin ?? "?"} 分钟
        {r.perCapita != null ? ` · 人均 ${r.perCapita} 元` : " · 人均未标注"}
        {r.metroCount ? ` · ${r.metroCount} 人坐地铁` : ""} · 资料完整{" "}
        {r.clarity}%
      </p>
      {r.clear === false && !r.rejected && r.clearNote && (
        <p className="mt-0.5 pl-5 text-[10px] leading-relaxed text-amber-300/80">
          {r.clearNote}
        </p>
      )}
      {r.rejected && (
        <p className="mt-0.5 pl-5 text-[10px] leading-relaxed text-amber-300/90">
          已排后：{r.rejected}
        </p>
      )}
    </li>
  );
}

function RankingCard({ plan }: { plan: PlanResult }) {
  const all = plan.ranking ?? [];
  if (!all.length) return null;

  const chosen = all.find((r) => r.id === plan.pick?.id) ?? null;
  const rest = all.filter((r) => r.id !== plan.pick?.id);
  // 备选分两摞：资料查得清的（可以直接换）、资料不全的（换了也得先确认）
  const clearAlts = rest.filter((r) => r.clear !== false && !r.rejected).slice(0, 3);
  const blurred = rest.filter((r) => r.clear === false && !r.rejected).slice(0, 3);
  const rejected = rest.filter((r) => r.rejected).slice(0, 2);

  return (
    <details className="rounded-xl border border-line bg-bg/40 p-3.5">
      <summary className="cursor-pointer list-none text-xs text-fg-muted">
        首选 + 备选 · 共 {all.length} 家（资料查得清的排前面）
        <span className="ml-1 text-fg-dim">（点击展开）</span>
      </summary>

      <ul className="mt-2.5 space-y-2">
        {chosen && <RankRow r={chosen} current />}
      </ul>

      {clearAlts.length > 0 && (
        <>
          <p className="mt-3 text-[10px] text-fg-dim">
            备选 · 要求都核对过，换个条件可以顶上
          </p>
          <ul className="mt-1.5 space-y-2">
            {clearAlts.map((r, i) => (
              <RankRow key={r.id} r={r} index={i + 1} />
            ))}
          </ul>
        </>
      )}

      {blurred.length > 0 && (
        <>
          <p className="mt-3 text-[10px] text-fg-dim">
            备选 · 资料没说清，选之前得先确认（不参与首选比较）
          </p>
          <ul className="mt-1.5 space-y-2">
            {blurred.map((r, i) => (
              <RankRow key={r.id} r={r} index={i + 1} />
            ))}
          </ul>
        </>
      )}

      {rejected.length > 0 && (
        <>
          <p className="mt-3 text-[10px] text-fg-dim">已排除</p>
          <ul className="mt-1.5 space-y-2">
            {rejected.map((r, i) => (
              <RankRow key={r.id} r={r} index={i + 1} />
            ))}
          </ul>
        </>
      )}

      <p className="mt-2.5 text-[10px] leading-relaxed text-fg-dim">
        检索词 {plan.keywords.join("、")} · 半径 {plan.trace.radius / 1000} km · 围绕
        {plan.trace.anchors.map((a) => a.name).join(" + ")} 检索 ·{" "}
        {plan.trace.transitQueries} 次地铁/公交查询 · 耗时{" "}
        {(plan.trace.elapsedMs / 1000).toFixed(1)} s
      </p>
    </details>
  );
}
