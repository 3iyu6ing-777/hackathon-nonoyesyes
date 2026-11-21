"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import TileMap, { type MapApi, type MapLine, type MapPoint } from "@/components/tile-map";
import SiteHeader from "@/components/site-header";
import { ActivityArt, Icon } from "@/components/icons";
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

type PlanResponse = { ok?: boolean; plan?: PlanResult } & ApiError;

type OriginOverride = { originName: string; lat: number; lng: number };
type PlaceOption = { name: string; address: string; lat: number; lng: number };

const LOADING_STEPS = [
  "正在读懂群聊里每个人说了什么…",
  "正在把每个人的出发地落到地图上…",
  "正在按成员所在位置检索真实地点…",
  "正在算每人打车和坐地铁分别要多久、多少钱…",
];

const QUICK_ASKS = ["这家店人均多少？", "附近有地铁吗？", "需要提前预约吗？"];

function fmtMin(s: number | null) {
  if (s == null) return "";
  return `${Math.max(1, Math.round(s / 60))} 分钟`;
}

function fmtFare(f: number | null | undefined) {
  if (f == null) return "";
  return f === 0 ? "免费" : `¥${Math.round(f)}`;
}

function AiAvatar({ size = 24 }: { size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#7cb8ff] to-[#2563eb] text-white shadow-[0_5px_12px_-7px_rgba(37,99,235,0.95)]"
      style={{ width: size, height: size }}
    >
      <Icon name="sparkles" size={Math.round(size * 0.56)} strokeWidth={1.7} />
    </span>
  );
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
  /** 这次是不是走了「跳过 AI 总结」的快速模式（线上 10 秒限时兜底） */
  const [fast, setFast] = useState(false);
  const [rerouting, setRerouting] = useState(false);
  const [legend, setLegend] = useState(true);
  const [detailOpen, setDetailOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  // 对话区自己的滚动容器：只让这一块滚，不要让整页跟着滚
  const scrollRef = useRef<HTMLDivElement>(null);
  const mapApi = useRef<MapApi | null>(null);
  const nextId = useRef(1);
  const reqId = useRef(0);

  const room = useMemo(() => loadRoom(roomId), [roomId]);
  const roomTitle = room.title ?? "周末出去玩";

  const chatText = useMemo(() => {
    const r = loadRoom(roomId);
    return r.chat && r.chat.trim().length >= 10 ? r.chat : SAMPLE_CHAT;
  }, [roomId]);

  useEffect(() => {
    const r = loadRoom(roomId);
    setDemo(!(r.chat && r.chat.trim().length >= 10));
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

      /** 发一次规划请求；fast=true 时跳过 AI 总结，只用代码排序出结论（快 3 秒左右） */
      const post = async (fast: boolean) => {
        const r = loadRoom(roomId);
        const res = await fetch("/api/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat: chatText,
            activityId: r.activityId ?? "food",
            customActivity: r.customActivity ?? "",
            origin: myPlace,
            config: cfg,
            amapKey: cfg.amapKey,
            extraConstraints: extra ?? [],
            memberOverrides: overrideList,
            fast,
          }),
        });
        // 线上函数超时（Netlify 免费版 10 秒）返回的是 HTML 或空响应，
        // 直接 res.json() 会抛 SyntaxError，被下面的 catch 当成「服务没起来」。
        // 先拿文本再自己解析，才能把「超时」和「连不上」分开告诉用户。
        const raw = await res.text();
        let data: PlanResponse | null = null;
        try {
          data = raw ? (JSON.parse(raw) as PlanResponse) : null;
        } catch {
          data = null;
        }
        return { res, raw, data };
      };

      try {
        // 已经降级过的会话直接用快速模式，别每次都先白等 10 秒再退回
        let out = await post(fast);
        if (my !== reqId.current) return;

        // 10 秒硬上限掐掉了第一次：自动降级重试一次。
        // 服务端已经把「读群聊」的结果缓存住（同一进程内 10 分钟），
        // 第二次再跳过 AI 总结，基本 3-5 秒一定能出结果，比让用户对着报错强。
        if (
          !out.data &&
          (out.res.status === 502 || out.res.status === 504 || !out.res.status)
        ) {
          setFast(true);
          out = await post(true);
          if (my !== reqId.current) return;
        }

        const { res, raw, data } = out;
        if (!data) {
          const timedOut = res.status === 502 || res.status === 504 || !res.status;
          setErr({
            code: timedOut ? "TIMEOUT" : "BAD_RESPONSE",
            error: timedOut
              ? "分析超时了：线上函数单次只能跑 10 秒"
              : `服务返回了异常响应（${res.status || "无状态码"}）`,
            detail: timedOut
              ? "已经自动降级重试过一次还是超时。点「重试」通常就能出结果——读群聊的结果会在服务端缓存 10 分钟。"
              : raw.slice(0, 300),
          });
          setPhase("error");
          return;
        }
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
          error: "请求没有发出去或被中断",
          detail:
            location.hostname === "localhost"
              ? "本地开发服务可能已经停了，重新跑 npm run dev"
              : "网络中断或请求超时，稍等一下点「重试」",
        });
        setPhase("error");
      }
    },
    [chatText, myPlace, roomId, overrideList, fast]
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
    // 只滚对话容器。用 scrollIntoView 会连带把整个窗口滚下去。
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
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
          city: plan.trace.city,
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
        body: JSON.stringify({ q, amapKey: cfg.amapKey, city: plan?.trace.city }),
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
        body: JSON.stringify({ q, amapKey: cfg.amapKey, city: plan?.trace.city }),
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
        body: JSON.stringify({ q, amapKey: cfg.amapKey, city: plan?.trace.city }),
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

    const r = loadRoom(roomId);
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
          activityId: r.activityId ?? "food",
          customActivity: r.customActivity ?? "",
          origin: myPlace,
          config: cfg,
          amapKey: cfg.amapKey,
          previousConstraints: plan?.hardConstraints ?? [],
          memberOverrides: overrideList,
          city: plan?.trace.city,
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
  const spotName = plan?.pick?.name;

  const status =
    rerouting
      ? { text: "重新检索中", cls: "bg-amber-50 text-amber-600", dot: "bg-amber-500" }
      : phase === "ready"
        ? { text: "方案已生成", cls: "bg-emerald-50 text-emerald-600", dot: "bg-emerald-500" }
        : phase === "error"
          ? { text: "出错了", cls: "bg-amber-50 text-amber-600", dot: "bg-amber-500" }
          : phase === "nokey"
            ? { text: "待配置 Key", cls: "bg-surface-2 text-fg-muted", dot: "bg-slate-300" }
            : { text: "分析中", cls: "bg-brand-soft text-brand", dot: "bg-brand animate-pulse" };

  return (
    // 任何宽度都锁成一屏：页头 + 房间条 + 内容区，余下高度分给左右两块面板，
    // 各自内部滚动，整页永远不出现滚动条
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
      <SiteHeader active="room" />

      <div className="mx-auto w-full max-w-[1240px] shrink-0 overflow-hidden px-3 pt-2.5 sm:px-5">
        <div className="mm-card flex items-center gap-2 px-3 py-2">
          <AiAvatar size={26} />
          <span className="truncate text-[13.5px] font-semibold">{roomTitle}</span>
          <span className="hidden shrink-0 text-[10.5px] text-fg-dim sm:inline">
            房间 ID <span className="font-mono text-fg-muted">#{roomId}</span>
          </span>
          {memberCount ? (
            <span className="mm-chip shrink-0">
              <Icon name="users" size={11} />
              {memberCount} 人
            </span>
          ) : null}
          {demo && (
            <span className="hidden shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] text-amber-600 sm:inline">
              演示群聊
            </span>
          )}

          <span
            className={`ml-auto hidden shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[10.5px] sm:flex ${status.cls}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
            {status.text}
          </span>

          <Link
            href={`/room/${roomId}/chat`}
            className="mm-btn-ghost h-7 shrink-0 px-2.5 text-[10.5px]"
          >
            <Icon name="chat" size={12} />
            修改群聊
          </Link>
        </div>
      </div>

      {/* 窄屏：上下两块按比例分高度；宽屏：左右两栏 */}
      <div className="mx-auto grid w-full max-w-[1240px] min-h-0 flex-1 grid-rows-[minmax(0,1.55fr)_minmax(0,1fr)] gap-2.5 px-3 py-2.5 sm:px-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)] lg:grid-rows-1">
        {/* 左：AI 目的地助手 */}
        <section className="mm-card flex min-h-0 min-w-0 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <AiAvatar size={28} />
            <div className="min-w-0">
              <h1 className="truncate text-[13.5px] font-semibold">AI 目的地助手</h1>
              <p className="truncate text-[10px] text-fg-dim">
                想了解推荐地点的更多信息？随时问我。
              </p>
            </div>
            <button
              type="button"
              onClick={() => setMyOpen((v) => !v)}
              title="只在群聊里一个人都没读到出发地时兜底；成员的位置始终以群聊为准"
              className="mm-btn-ghost ml-auto h-7 shrink-0 px-2.5 text-[10px]"
            >
              <Icon name="pin" size={11} />
              {myPlace ? myPlace.name : "我的出发地"}
            </button>
          </div>

          {myOpen && (
            <div className="shrink-0 border-b border-line bg-[#fbfdff] px-3 py-2">
              <div className="flex items-center gap-2">
                <input
                  value={myQuery}
                  onChange={(e) => setMyQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      void applyMyPlace();
                    }
                  }}
                  placeholder="输入地名，如「文三路」"
                  className="mm-input h-8 min-w-0 flex-1 px-2.5 text-[11px]"
                />
                <button
                  type="button"
                  disabled={myBusy}
                  onClick={() => void applyMyPlace()}
                  className="mm-btn-primary h-8 shrink-0 px-3 text-[11px]"
                >
                  {myBusy ? "解析中" : "确定"}
                </button>
                {myPlace && (
                  <button
                    type="button"
                    onClick={() => {
                      setMyPlace(null);
                      setMyOpen(false);
                    }}
                    className="shrink-0 text-[10px] text-fg-dim underline underline-offset-2 hover:text-fg-muted"
                  >
                    清除
                  </button>
                )}
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-fg-dim">
                {myErr ? (
                  <span className="text-amber-600">{myErr}</span>
                ) : (
                  "只在群里一个人都没读到位置时兜底，不覆盖成员自己说的出发地。"
                )}
              </p>
            </div>
          )}

          <div
            ref={scrollRef}
            className="mm-scroll min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain px-3 py-2.5"
          >
            {phase === "nokey" && <NoKeyCard />}
            {phase === "loading" && <LoadingCard text={LOADING_STEPS[tick]} />}
            {phase === "error" && <ErrorCard err={err} onRetry={() => void run()} />}

            {plan && (phase === "ready" || rerouting) && (
              <>
                <PlaceCard
                  plan={plan}
                  onLocate={() => mapApi.current?.fitSpot()}
                />

                <div className="overflow-hidden rounded-[13px] border border-line bg-[#fbfdff]">
                  <button
                    type="button"
                    onClick={() => setDetailOpen((v) => !v)}
                    className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11px] text-fg-muted transition-colors hover:text-fg"
                  >
                    <Icon name="layers" size={12} className="text-brand" />
                    方案细节：读到的条件 / 每个人位置 / 逐条核对 / 备选榜单
                    <Icon
                      name="chevron-down"
                      size={12}
                      className={`ml-auto shrink-0 transition-transform ${
                        detailOpen ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                  {detailOpen && (
                    <div className="space-y-2.5 px-2.5 pb-2.5">
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
                      <RankingCard plan={plan} />
                    </div>
                  )}
                </div>

                {bubbles.length === 0 && (
                  <>
                    <div className="flex items-start gap-1.5">
                      <span className="mt-0.5">
                        <AiAvatar size={24} />
                      </span>
                      <p className="max-w-[86%] rounded-2xl rounded-tl-md border border-line bg-white px-3 py-2 text-[12px] leading-relaxed text-fg shadow-[0_6px_16px_-14px_rgba(15,23,42,0.5)]">
                        我从群聊里读到 {plan.members.length} 个人的出发地、
                        {plan.needs.length} 条要求，先按这些筛出了「{plan.pick?.name ?? "首选"}」。
                        关于这家店的细节，可以直接问我。
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 pl-[30px]">
                      <span className="text-[9.5px] text-fg-dim">可以这样问：</span>
                      {QUICK_ASKS.map((q) => (
                        <button
                          key={q}
                          type="button"
                          onClick={() => setDraft(q)}
                          className="rounded-full border border-line bg-white px-2 py-0.5 text-[10px] text-fg-muted transition-colors hover:border-brand/40 hover:text-brand"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {bubbles.map((b) =>
              b.role === "user" ? (
                <div key={b.id} className="mm-in flex items-start justify-end gap-1.5">
                  <p className="max-w-[82%] rounded-2xl rounded-br-md bg-[#e8f0fe] px-3 py-2 text-[12px] leading-relaxed text-[#1e3a8a]">
                    {b.text}
                  </p>
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-white text-fg-dim">
                    <Icon name="users" size={12} />
                  </span>
                </div>
              ) : (
                <div key={b.id} className="mm-in flex items-start gap-1.5">
                  <span className="mt-0.5">
                    <AiAvatar size={24} />
                  </span>
                  <div className="min-w-0 max-w-[86%]">
                    <p className="rounded-2xl rounded-tl-md border border-line bg-white px-3 py-2 text-[12px] leading-relaxed text-fg shadow-[0_6px_16px_-14px_rgba(15,23,42,0.5)]">
                      {b.text}
                    </p>
                    {b.updated && (
                      <p className="mt-1 flex items-center gap-1 text-[10px] text-emerald-600">
                        <Icon name="check" size={10} strokeWidth={2.6} />
                        已重新检索并更新上面的方案
                      </p>
                    )}
                  </div>
                </div>
              )
            )}

            {chatting && (
              <div className="flex items-center gap-1.5 text-[10.5px] text-fg-dim">
                <AiAvatar size={20} />
                正在理解你的新要求…
              </div>
            )}
            <div ref={endRef} />
          </div>

          <div className="shrink-0 border-t border-line p-2">
            <div className="flex items-center gap-1.5 rounded-full border border-line bg-surface-2 py-1 pl-3 pr-1 transition-colors focus-within:border-[#b9cffb] focus-within:bg-white">
              <Icon name="sparkles" size={13} className="shrink-0 text-brand/70" />
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) void send();
                }}
                placeholder={
                  phase === "ready"
                    ? "询问目的地详情，例如价格、交通、营业时间…"
                    : "先配置 Key 才能对话"
                }
                disabled={phase === "nokey"}
                className="h-7 min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-fg-dim disabled:cursor-not-allowed"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={chatting || phase === "nokey"}
                aria-label="发送"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-[#3f8bfb] to-[#2563eb] text-white shadow-[0_6px_14px_-8px_rgba(37,99,235,0.9)] transition-opacity disabled:opacity-40"
              >
                <Icon name="send" size={13} strokeWidth={1.9} />
              </button>
            </div>
          </div>
        </section>

        {/* 右：地图 */}
        <section className="mm-card flex min-h-0 min-w-0 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-brand-soft text-brand">
              <Icon name="map" size={13} />
            </span>
            <div className="min-w-0">
              <h2 className="text-[13.5px] font-semibold">聚会地图</h2>
              <p className="truncate text-[10px] text-fg-dim">
                {spotName ? `AI 推荐：${spotName}` : "查看所有成员位置与推荐目的地"}
              </p>
            </div>
          </div>

          <div className="mm-scroll flex shrink-0 items-center gap-1.5 overflow-x-auto px-2.5 py-1.5">
            <MapTool icon="zoom-in" label="放大" onClick={() => mapApi.current?.zoomIn()} />
            <MapTool icon="zoom-out" label="缩小" onClick={() => mapApi.current?.zoomOut()} />
            <MapTool
              icon="target"
              label="定位到推荐地点"
              onClick={() => mapApi.current?.fitSpot()}
            />
            <MapTool
              icon="users"
              label="显示全部成员"
              onClick={() => mapApi.current?.fitMembers()}
            />
            <MapTool
              icon="info"
              label="图例说明"
              onClick={() => setLegend((v) => !v)}
              active={legend}
            />
          </div>

          <div className="relative mx-2 mb-2 min-h-0 flex-1 overflow-hidden rounded-[14px] border border-line bg-[#eef4fb]">
            <TileMap points={mapPoints} lines={mapLines} apiRef={mapApi} />

            {legend && (
              <div className="pointer-events-none absolute bottom-2 left-2 z-[450] hidden w-[126px] sm:block rounded-[10px] border border-line bg-white/95 p-2 shadow-[0_10px_24px_-16px_rgba(15,23,42,0.6)] backdrop-blur">
                <p className="text-[9.5px] font-semibold text-fg-muted">图例</p>
                <ul className="mt-1 space-y-1">
                  <li className="flex items-center gap-1.5 text-[9.5px] text-fg-muted">
                    <span className="flex h-2.5 w-2.5 items-center justify-center rounded-full bg-brand">
                      <span className="h-1 w-1 rounded-full bg-white" />
                    </span>
                    AI 推荐目的地
                  </li>
                  <li className="flex items-center gap-1.5 text-[9.5px] text-fg-muted">
                    <span className="flex gap-0.5">
                      <span className="h-2 w-2 rounded-full bg-[#60a5fa]" />
                      <span className="h-2 w-2 rounded-full bg-[#f472b6]" />
                      <span className="h-2 w-2 rounded-full bg-[#fbbf24]" />
                    </span>
                    成员出发地
                  </li>
                  <li className="flex items-center gap-1.5 text-[9.5px] text-fg-muted">
                    <span className="h-2 w-2 rounded-full bg-[#a8b6cc]" />
                    其他候选
                  </li>
                  <li className="flex items-center gap-1.5 text-[9.5px] text-fg-muted">
                    <span className="h-[2px] w-4 rounded-full bg-[#60a5fa]" />
                    实线打车 / 虚线地铁
                  </li>
                </ul>
              </div>
            )}

            <div className="pointer-events-none absolute bottom-2 right-2 z-[450] hidden max-w-[230px] items-start gap-1.5 rounded-[10px] bg-white/92 px-2 py-1.5 text-[9.5px] leading-relaxed text-fg-muted shadow-[0_10px_24px_-18px_rgba(15,23,42,0.6)] backdrop-blur sm:flex">
              <Icon name="info" size={10} className="mt-[2px] shrink-0 text-brand/70" />
              位置、路线与时间来自高德实时接口。某个人的位置不对，可在左侧「方案细节」里改。
            </div>

            {rerouting && (
              <div className="absolute inset-0 z-[600] flex items-center justify-center bg-white/55 backdrop-blur-[1px]">
                <span className="flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-[10.5px] text-fg-muted shadow-lg">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
                  按新位置重新检索地点并重算路程…
                </span>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function MapTool({
  icon,
  label,
  onClick,
  active,
}: {
  icon: "zoom-in" | "zoom-out" | "target" | "users" | "info";
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[10px] transition-colors ${
        active
          ? "border-brand/30 bg-brand-soft text-brand"
          : "border-line bg-white text-fg-muted hover:border-[#cfdff9] hover:text-brand"
      }`}
    >
      <Icon name={icon} size={11} />
      {label}
    </button>
  );
}

function NoKeyCard() {
  return (
    <div className="rounded-[14px] border border-brand/25 bg-brand-soft/60 p-3">
      <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-brand">
        <Icon name="key" size={13} />
        需要先配一个 AI Key
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-fg-muted">
        这一版不用任何预设数据：每个人的条件、地点、路程全部实时算。
        填上你自己的 Key 就行，Key 只存在你这台浏览器里。
      </p>
      <button
        type="button"
        onClick={openSettings}
        className="mm-btn-primary mt-2.5 h-8 px-3.5 text-[11px]"
      >
        去配置 Key
      </button>
    </div>
  );
}

function LoadingCard({ text }: { text: string }) {
  return (
    <div className="rounded-[14px] border border-line bg-white p-3">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
        <span className="text-[11.5px] text-fg-muted">{text}</span>
      </div>
      <div className="mt-2.5 space-y-1.5">
        <div className="h-2.5 w-4/5 animate-pulse rounded bg-[#eef3fc]" />
        <div className="h-2.5 w-3/5 animate-pulse rounded bg-[#eef3fc]" />
        <div className="h-2.5 w-2/3 animate-pulse rounded bg-[#eef3fc]" />
      </div>
      <p className="mt-2 text-[10px] text-fg-dim">
        成员越多，要算的路程越多，通常 10–20 秒。
      </p>
    </div>
  );
}

function ErrorCard({ err, onRetry }: { err: ApiError | null; onRetry: () => void }) {
  const needsKey = err?.code === "NO_KEY" || err?.code === "AUTH";
  return (
    <div className="rounded-[14px] border border-amber-200 bg-amber-50/70 p-3">
      <p className="text-[12.5px] font-semibold text-amber-700">
        {err?.error ?? "分析失败"}
      </p>
      {err?.detail && (
        <p className="mt-1.5 break-words rounded-lg bg-white/70 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-fg-muted">
          {err.detail}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <button type="button" onClick={onRetry} className="mm-btn-ghost h-7 px-2.5 text-[10.5px]">
          重试
        </button>
        {needsKey && (
          <button
            type="button"
            onClick={openSettings}
            className="mm-btn-primary h-7 px-3 text-[10.5px]"
          >
            去检查 Key
          </button>
        )}
      </div>
    </div>
  );
}

function PlaceCard({ plan, onLocate }: { plan: PlanResult; onLocate: () => void }) {
  if (!plan.pick) return null;
  const p = plan.pick;
  const sc = p.score;
  return (
    <div className="mm-in overflow-hidden rounded-[15px] border border-line bg-white shadow-[0_12px_28px_-24px_rgba(15,23,42,0.7)]">
      <div className="flex gap-2.5 p-2.5">
        <div className="h-[72px] w-[82px] shrink-0 overflow-hidden rounded-[10px]">
          <ActivityArt scene={plan.activityId} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1.5">
            <p className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-tight">
              {p.name}
            </p>
            <button
              type="button"
              onClick={onLocate}
              className="mm-btn-ghost h-[22px] shrink-0 px-2 text-[9.5px]"
            >
              <Icon name="pin" size={9} />
              查看地图
            </button>
          </div>
          <p className="mt-1 flex items-center gap-1 text-[10px] text-fg-muted">
            <Icon name="pin" size={9} className="shrink-0 text-fg-dim" />
            <span className="truncate">{p.address || p.type || "地址未提供"}</span>
          </p>
          <p className="mt-0.5 flex items-center gap-1 text-[10px] text-fg-muted">
            <Icon name="wallet" size={9} className="shrink-0 text-fg-dim" />
            人均：{p.cost || "未标注"}
            {p.rating ? ` · 评分 ${p.rating}` : ""}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {sc && (
              <span className="rounded bg-emerald-50 px-1.5 py-[1px] text-[9.5px] text-emerald-600">
                综合 {sc.score} 分
              </span>
            )}
            <span className="rounded bg-brand-soft px-1.5 py-[1px] text-[9.5px] text-brand">
              资料完整 {sc?.clarity ?? 100}%
            </span>
            {p.openTime && (
              <span className="truncate text-[9.5px] text-fg-dim">营业 {p.openTime}</span>
            )}
          </div>
        </div>
      </div>

      <div className="mx-2.5 rounded-[11px] bg-[#f6faff] p-2">
        <p className="flex items-center gap-1 text-[9.5px] font-medium text-brand">
          <Icon name="sparkles" size={10} />
          推荐理由
        </p>
        <p className="mt-1 text-[10.5px] leading-relaxed text-fg-muted">{p.reason}</p>
        {plan.trace.decisionFallback && (
          <p className="mt-1 text-[9.5px] leading-relaxed text-fg-dim">
            线上函数限时 10 秒，这一版省掉了 AI 综合判断，结论由评分排序直接给出。
          </p>
        )}
        {p.cautions.slice(0, 2).map((c) => (
          <p key={c} className="mt-1 text-[10px] leading-relaxed text-amber-600">
            注意：{c}
          </p>
        ))}
        {p.cautions.length > 2 && (
          <p className="mt-1 text-[10px] text-fg-dim">
            还有 {p.cautions.length - 2} 条提醒，展开「方案细节」可看
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[9.5px] text-fg-dim">
        {p.tel && (
          <span className="flex items-center gap-1">
            <Icon name="phone" size={9} />
            {p.tel.split(";")[0]}
          </span>
        )}
        {p.perMember.some((l) => l.durationS != null) && (
          <span className="flex items-center gap-1">
            <Icon name="clock" size={9} />
            最远{" "}
            {Math.max(
              1,
              Math.round(Math.max(...p.perMember.map((l) => l.durationS ?? 0)) / 60)
            )}{" "}
            分钟
          </span>
        )}
        <span className="ml-auto min-w-0 max-w-[62%] truncate text-right">
          {p.address || `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`}
        </span>
      </div>
    </div>
  );
}

const VERDICT_STYLE: Record<
  NeedCheck["verdict"],
  { label: string; cls: string; dot: string }
> = {
  pass: { label: "满足", cls: "text-emerald-600", dot: "bg-emerald-500" },
  conflict: { label: "违背", cls: "text-red-500", dot: "bg-red-400" },
  unknown: { label: "待确认", cls: "text-fg-dim", dot: "bg-slate-300" },
};

function RequirementCard({ plan }: { plan: PlanResult }) {
  return (
    <div className="mm-card-flat p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] text-fg-dim">
          从群聊读出的条件 · {plan.activityLabel}
        </p>
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[9px] text-fg-dim">
          {plan.trace.model}
        </span>
      </div>
      <ul className="mt-1.5 space-y-1">
        {plan.requirements.map((r) => (
          <li key={r.label} className="flex gap-1.5 text-[11px] leading-relaxed">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-brand/50" />
            <span>
              <span className="text-fg-dim">{r.label}：</span>
              {r.value}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-1.5 flex flex-wrap gap-1">
        {plan.budget != null && (
          <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-600">
            人均上限 ¥{plan.budget}
          </span>
        )}
        {plan.maxTravelMin != null && (
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-muted">
            单程上限 {plan.maxTravelMin} 分钟
          </span>
        )}
      </div>

      {(plan.hardConstraints.length > 0 || plan.softWishes.length > 0) && (
        <div className="mt-2 space-y-1 border-t border-line pt-1.5">
          {plan.hardConstraints.length > 0 && (
            <p className="text-[10px] leading-relaxed">
              <span className="text-amber-600">全体硬性条件</span>
              <span className="text-fg-muted">：{plan.hardConstraints.join(" · ")}</span>
            </p>
          )}
          {plan.softWishes.length > 0 && (
            <p className="text-[10px] leading-relaxed">
              <span className="text-fg-dim">全体期望</span>
              <span className="text-fg-muted">：{plan.softWishes.join(" · ")}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function NeedPanel({ plan }: { plan: PlanResult }) {
  const needs = plan.needs ?? [];
  if (!needs.length) {
    return (
      <div className="mm-card-flat p-2.5">
        <p className="text-[10px] text-fg-dim">逐条核对</p>
        <p className="mt-1 text-[10px] leading-relaxed text-fg-muted">
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
    <div className="mm-card-flat p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] text-fg-dim">逐条核对 · 谁的要求更重</p>
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[9px] text-fg-dim">
          {needs.length} 条要求
        </span>
      </div>

      <div className="mt-1.5 space-y-1">
        {pressure
          .filter((p) => p.weight > 0)
          .map((p) => (
            <div key={p.name} className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: p.color }} />
              <span className="w-8 shrink-0 truncate text-[10px] text-fg-muted">{p.name}</span>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#eef3fc]">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${Math.max(6, (p.weight / maxWeight) * 100)}%`,
                    background: p.color,
                  }}
                />
              </span>
              <span className="shrink-0 text-[9px] text-fg-dim">
                {p.top.slice(0, 2).map((t) => t.category).join("·")}
                {p.hardCount > 0 ? ` · 硬 ${p.hardCount}` : ""}
              </span>
            </div>
          ))}
      </div>

      {plan.pick && (
        <p className="mt-2 border-t border-line pt-1.5 text-[9.5px] leading-relaxed text-fg-dim">
          以下是每条要求对着「{plan.pick.name}」的核对结果：满足 {counts.pass} · 违背{" "}
          {counts.conflict} · 数据判断不了 {counts.unknown}
        </p>
      )}

      <div className="mt-1.5 space-y-2">
        {groups.map((g) => (
          <div key={g.name}>
            <p className="text-[10px] text-fg-muted">
              <span
                className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
                style={{ background: g.color }}
              />
              {g.name}
            </p>
            <ul className="mt-1 space-y-1">
              {g.items.map((c) => (
                <li key={c.needId} className="rounded-lg border border-line px-1.5 py-1">
                  <div className="flex items-start gap-1.5">
                    <span
                      className={`mt-[1px] shrink-0 rounded px-1 text-[9px] ${
                        c.strength === "hard"
                          ? "bg-amber-50 text-amber-600"
                          : c.strength === "strong"
                            ? "bg-surface-2 text-fg-muted"
                            : "bg-surface-2 text-fg-dim"
                      }`}
                    >
                      {NEED_STRENGTH_LABEL[c.strength]}
                    </span>
                    <span className="min-w-0 flex-1 text-[10px] leading-relaxed text-fg">
                      {c.text}
                    </span>
                    <span className={`shrink-0 text-[9px] ${VERDICT_STYLE[c.verdict].cls}`}>
                      {VERDICT_STYLE[c.verdict].label}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[9px] leading-relaxed text-fg-dim">
                    原话「{c.quote}」
                  </p>
                  <p className="mt-0.5 flex items-start gap-1 text-[9px] leading-relaxed text-fg-muted">
                    <span
                      className={`mt-[3px] h-1 w-1 shrink-0 rounded-full ${
                        VERDICT_STYLE[c.verdict].dot
                      }`}
                    />
                    <span>
                      {c.evidence}
                      {c.source === "ai" && <span className="ml-1 text-fg-dim">（AI 判断）</span>}
                    </span>
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ))}

        {globalItems.length > 0 && (
          <div>
            <p className="text-[10px] text-fg-muted">全体</p>
            <ul className="mt-1 space-y-1">
              {globalItems.map((c) => (
                <li key={c.needId} className="rounded-lg border border-line px-1.5 py-1">
                  <div className="flex items-start gap-1.5">
                    <span className="mt-[1px] shrink-0 rounded bg-surface-2 px-1 text-[9px] text-fg-muted">
                      {NEED_STRENGTH_LABEL[c.strength]}
                    </span>
                    <span className="min-w-0 flex-1 text-[10px] leading-relaxed text-fg">
                      {c.text}
                    </span>
                    <span className={`shrink-0 text-[9px] ${VERDICT_STYLE[c.verdict].cls}`}>
                      {VERDICT_STYLE[c.verdict].label}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[9px] leading-relaxed text-fg-dim">
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
        <p className="mt-1.5 border-t border-line pt-1.5 text-[9px] leading-relaxed text-fg-dim">
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
    <div className="mm-card-flat p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] text-fg-dim">参与的人 · 每人各有自己的位置和要求</p>
        <span
          className={`rounded px-1.5 py-0.5 text-[9px] ${
            plan.members.every((m) => m.resolved)
              ? "bg-surface-2 text-fg-dim"
              : "bg-amber-50 text-amber-600"
          }`}
        >
          {plan.members.length} 人 · 已定位 {plan.members.filter((m) => m.resolved).length}
        </span>
      </div>

      {unresolved.length > 0 && (
        <div className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50/70 px-2 py-1.5">
          <p className="text-[9.5px] leading-relaxed text-amber-700">
            {unresolved.map((m) => m.name).join("、")} 的话里没读出出发地，这几个人
            {unresolved.length === plan.members.length
              ? "全部没有位置，检索暂时以城市中心为基准"
              : "不计入位置分布"}
            。点下面的「改位置」填一下，路程和推荐会立刻重算。
          </p>
        </div>
      )}

      <ul className="mt-2 space-y-1.5">
        {plan.members.map((m) => {
          const leg = plan.pick?.perMember.find((l) => l.name === m.name);
          const route = plan.routes.find((r) => r.name === m.name);
          const mode = route?.mode ?? leg?.mode ?? null;
          const durationS = route?.durationS ?? leg?.durationS ?? null;
          const fare = route?.fareYuan ?? leg?.fareYuan ?? null;
          const detail = route?.detail ?? leg?.detail ?? "";

          return (
            <li key={m.name} className="rounded-lg border border-line bg-[#fbfdff] p-2">
              <div className="flex items-start gap-1.5">
                <span
                  className="mt-[5px] h-2 w-2 shrink-0 rounded-full ring-2 ring-white"
                  style={{ background: m.color, boxShadow: `0 0 0 1px ${m.color}55` }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <span className="text-[11.5px] font-medium">{m.name}</span>
                    <span className="text-[10px] text-fg-dim">
                      {m.resolved ? `从${m.originName}出发` : "出发地未识别"}
                    </span>
                    {!m.resolved && (
                      <span className="rounded bg-amber-50 px-1 py-0.5 text-[9px] text-amber-600">
                        位置待确认
                      </span>
                    )}
                    {durationS != null && mode && (
                      <span className="rounded bg-emerald-50 px-1 py-0.5 text-[9px] text-emerald-600">
                        {TRAVEL_LABEL[mode]} {fmtMin(durationS)}
                        {fare != null && ` · ${fmtFare(fare)}`}
                      </span>
                    )}
                  </div>

                  {detail && (
                    <p className="mt-0.5 text-[9px] leading-relaxed text-fg-dim">
                      {detail}
                      {leg?.alt && (
                        <span>
                          {" "}
                          ｜另一种：{TRAVEL_LABEL[leg.alt.mode]} {fmtMin(leg.alt.durationS)} ·{" "}
                          {fmtFare(leg.alt.fareYuan)}
                        </span>
                      )}
                    </p>
                  )}

                  {(m.constraints.length > 0 || m.wishes.length > 0) && (
                    <p className="mt-0.5 text-[10px] leading-relaxed text-fg-muted">
                      {m.constraints.length > 0 && (
                        <span className="text-amber-600/90">{m.constraints.join("、")}</span>
                      )}
                      {m.constraints.length > 0 && m.wishes.length > 0 && "；"}
                      {m.wishes.length > 0 && <span>想{m.wishes.join("、")}</span>}
                    </p>
                  )}

                  <p className="mt-0.5 text-[9px] leading-relaxed text-fg-dim">
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
                    <p className="mt-0.5 truncate text-[9px] leading-relaxed text-fg-dim/85">
                      定位到 {m.originAddress}
                      <span className="text-fg-dim/65"> · 不对就点「改位置」</span>
                    </p>
                  )}

                  <button
                    type="button"
                    onClick={() => onEdit(m.name)}
                    className="mt-0.5 text-[9px] text-brand/80 underline underline-offset-2 transition-colors hover:text-brand"
                  >
                    {editing === m.name ? "收起" : "改位置"}
                  </button>

                  {editing === m.name && (
                    <div className="mt-1.5 space-y-1.5 rounded-lg border border-line bg-white p-1.5">
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
                          className="mm-input h-7 min-w-0 flex-1 px-2 text-[10px]"
                        />
                        <button
                          type="button"
                          disabled={placeBusy || rerouting}
                          onClick={() => onSearch(m.name)}
                          className="shrink-0 rounded-md border border-line px-2 py-1 text-[9px] text-fg-muted transition-colors hover:text-brand disabled:opacity-40"
                        >
                          {placeBusy ? "解析中" : "搜索"}
                        </button>
                      </div>
                      {placeErr && <p className="text-[9px] text-amber-600">{placeErr}</p>}

                      {placeOptions.length > 0 && (
                        <div className="space-y-1">
                          <p className="text-[9px] text-fg-dim">
                            高德搜到这些，点一个就是他的出发地：
                          </p>
                          {placeOptions.map((o, idx) => (
                            <button
                              key={`${o.name}-${idx}`}
                              type="button"
                              disabled={rerouting}
                              onClick={() => onPick(m.name, o)}
                              className="block w-full rounded-md border border-line bg-[#fbfdff] px-2 py-1 text-left transition-colors hover:border-brand/40 disabled:opacity-40"
                            >
                              <span className="block truncate text-[10px] text-fg">{o.name}</span>
                              <span className="block truncate text-[9px] text-fg-dim">
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

      <p className="mt-1.5 text-[9px] leading-relaxed text-fg-dim">
        改了位置会围绕新位置重新检索地点，并重算每人的打车/地铁时间与车费，不会重新读群聊。
      </p>
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
      className={`rounded-lg border px-2 py-1.5 ${
        current ? "border-emerald-200 bg-emerald-50/60" : "border-line"
      }`}
    >
      <div className="flex items-center gap-1.5">
        {index != null && (
          <span className="w-3 shrink-0 text-[9px] tabular-nums text-fg-dim">{index}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-[11px]">{r.name}</span>
        {r.clear === false && !r.rejected && !current && (
          <span className="shrink-0 rounded border border-amber-200 px-1 py-[1px] text-[8.5px] text-amber-600">
            备选 · 资料不全
          </span>
        )}
        <span
          className={`shrink-0 text-[10px] tabular-nums ${
            current ? "text-emerald-600" : "text-fg-muted"
          }`}
        >
          {r.score} 分
        </span>
      </div>
      <p className="mt-0.5 pl-4 text-[9px] leading-relaxed text-fg-dim">
        最远 {r.worstName} {r.worstMin ?? "?"} 分钟 · 平均 {r.avgMin ?? "?"} 分钟
        {r.perCapita != null ? ` · 人均 ${r.perCapita} 元` : " · 人均未标注"}
        {r.metroCount ? ` · ${r.metroCount} 人坐地铁` : ""} · 资料完整 {r.clarity}%
      </p>
      {r.clear === false && !r.rejected && r.clearNote && (
        <p className="mt-0.5 pl-4 text-[9px] leading-relaxed text-amber-600/90">{r.clearNote}</p>
      )}
      {r.rejected && (
        <p className="mt-0.5 pl-4 text-[9px] leading-relaxed text-amber-600">已排后：{r.rejected}</p>
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
    <details className="mm-card-flat p-2.5">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[10px] text-fg-muted">
        首选 + 备选 · 共 {all.length} 家（资料查得清的排前面）
        <Icon name="chevron-down" size={11} className="text-fg-dim" />
      </summary>

      <ul className="mt-2 space-y-1.5">{chosen && <RankRow r={chosen} current />}</ul>

      {clearAlts.length > 0 && (
        <>
          <p className="mt-2 text-[9px] text-fg-dim">备选 · 要求都核对过，换个条件可以顶上</p>
          <ul className="mt-1 space-y-1.5">
            {clearAlts.map((r, i) => (
              <RankRow key={r.id} r={r} index={i + 1} />
            ))}
          </ul>
        </>
      )}

      {blurred.length > 0 && (
        <>
          <p className="mt-2 text-[9px] text-fg-dim">
            备选 · 资料没说清，选之前得先确认（不参与首选比较）
          </p>
          <ul className="mt-1 space-y-1.5">
            {blurred.map((r, i) => (
              <RankRow key={r.id} r={r} index={i + 1} />
            ))}
          </ul>
        </>
      )}

      {rejected.length > 0 && (
        <>
          <p className="mt-2 text-[9px] text-fg-dim">已排除</p>
          <ul className="mt-1 space-y-1.5">
            {rejected.map((r, i) => (
              <RankRow key={r.id} r={r} index={i + 1} />
            ))}
          </ul>
        </>
      )}

      <p className="mt-2 text-[9px] leading-relaxed text-fg-dim">
        检索词 {plan.keywords.join("、")} · 半径 {plan.trace.radius / 1000} km · 围绕
        {plan.trace.anchors.map((a) => a.name).join(" + ")} 检索 ·{" "}
        {plan.trace.transitQueries} 次地铁/公交查询 · 耗时{" "}
        {(plan.trace.elapsedMs / 1000).toFixed(1)} s
      </p>
    </details>
  );
}
