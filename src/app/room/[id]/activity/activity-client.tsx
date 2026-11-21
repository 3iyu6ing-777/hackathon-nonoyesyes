"use client";

import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/site-header";
import { ActivityArt, Icon } from "@/components/icons";
import { FriendsArt } from "@/components/illustrations";
import {
  ACTIVITIES,
  type ActivityId,
  loadRoom,
  saveRoom,
} from "@/lib/meetmate";

export default function ActivityClient({ roomId }: { roomId: string }) {
  const router = useRouter();
  const [selected, setSelected] = useState<ActivityId | null>(null);
  const [customText, setCustomText] = useState("");
  const [shareLink, setShareLink] = useState("");
  const [copied, setCopied] = useState(false);

  // 房间数据存在 localStorage，只能在挂载后读，否则首屏 SSR 与 CSR 对不上
  useEffect(() => {
    const room = loadRoom(roomId);
    setSelected(room.activityId ?? null);
    setCustomText(room.customActivity ?? "");
    setShareLink(`${window.location.origin}/room/${roomId}`);
  }, [roomId]);

  function copyLink() {
    if (!shareLink) return;
    navigator.clipboard?.writeText(shareLink);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function next() {
    if (!selected) return;
    saveRoom({
      ...loadRoom(roomId),
      id: roomId,
      activityId: selected,
      // 只有「其他」需要保留补充说明，其他分类一律清掉，避免旧值串台
      customActivity: selected === "other" ? customText.trim().slice(0, 30) : "",
    });
    router.push(`/room/${roomId}/chat`);
  }

  const chosen = ACTIVITIES.find((a) => a.id === selected);
  const chosenLabel =
    selected === "other"
      ? customText.trim() || "其他"
      : chosen?.name ?? "";

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
      <SiteHeader active="home" />

      {copied && (
        <div className="pointer-events-none fixed inset-x-0 top-20 z-[700] flex justify-center">
          <span className="mm-in flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3.5 py-1.5 text-[12px] text-emerald-600 shadow-[0_10px_24px_-14px_rgba(16,185,129,0.7)]">
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white">
              <Icon name="check" size={10} strokeWidth={3} />
            </span>
            复制成功
            <button
              type="button"
              onClick={() => setCopied(false)}
              className="pointer-events-auto ml-1 text-emerald-400 hover:text-emerald-600"
              aria-label="关闭提示"
            >
              <Icon name="close" size={11} />
            </button>
          </span>
        </div>
      )}

      <main className="mm-scroll mx-auto flex w-full max-w-[1180px] min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 sm:px-6">
        <div className="my-auto w-full">
        {/* 房间信息条 */}
        <section className="mm-card mm-in flex items-center gap-3 p-4 sm:gap-5">
          <div className="hidden h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-soft sm:flex">
            <Icon name="pin" size={26} className="text-brand" strokeWidth={1.7} />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[21px] font-semibold tracking-tight">周末出去玩</h1>
              <span className="rounded-md bg-brand-soft px-1.5 py-0.5 font-mono text-[11px] text-brand">
                #{roomId}
              </span>
            </div>

            <div className="mt-2 flex items-center gap-2">
              <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[12px] border border-line bg-surface-2 px-3">
                <Icon name="link" size={13} className="shrink-0 text-fg-dim" />
                <span className="truncate text-[12px] text-fg-muted">
                  {shareLink || "正在生成链接…"}
                </span>
              </div>
              <button
                type="button"
                onClick={copyLink}
                className="mm-btn-ghost h-9 shrink-0 px-3.5 text-[12px]"
              >
                <Icon name={copied ? "check" : "copy"} size={13} />
                {copied ? "已复制" : "复制链接"}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-fg-dim">邀请好友加入，一起规划这次聚会</p>
          </div>

          <FriendsArt className="hidden h-[86px] w-[104px] shrink-0 lg:block" />
        </section>

        {/* 选择活动 */}
        <div className="mt-5 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-[24px] font-bold tracking-tight text-fg sm:text-[27px]">
              今天想和朋友去做什么？
            </h2>
            <p className="mt-1.5 text-[12px] text-fg-muted">
              选择你们已经商量好的活动，MeetMate 帮你们找到合适的地点。
            </p>
          </div>
          <span className="hidden shrink-0 text-[11px] text-fg-dim sm:block">
            共 {ACTIVITIES.length} 类
          </span>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {ACTIVITIES.map((a) => {
            const active = selected === a.id;

            // 「其他」外观和别的卡完全一致，只是卡里还要放一个选填输入框；
            // <button> 不能嵌 input，所以这一张换成 div + 键盘支持。
            if (a.id === "other") {
              return (
                <Fragment key={a.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-pressed={active}
                    onClick={() => setSelected("other")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected("other");
                      }
                    }}
                    className={`${cardClass(active, true)} cursor-pointer`}
                  >
                    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-[12px]">
                      <ActivityArt scene="other" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-semibold text-fg">{a.name}</p>
                      <p className="mt-0.5 truncate text-[11px] text-fg-muted">{a.desc}</p>
                      <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-fg-dim">
                        <Icon name="sparkles" size={11} />
                        选填 · 可留空
                      </span>
                    </div>
                    <CheckCircle active={active} />
                  </div>

                  {/* 同一行的补充说明：宽屏占满剩下的三格，窄屏落到卡片下面 */}
                  <div className="flex min-h-[84px] flex-col justify-center gap-1.5 rounded-[16px] border border-dashed border-[#cfdff9] bg-[#fafcff] p-2.5 sm:col-span-2 lg:col-span-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] font-medium text-fg-muted">补充说明</span>
                      <span className="text-[10px] text-fg-dim">选填，空着也行</span>
                    </div>
                    <input
                      value={customText}
                      maxLength={30}
                      onChange={(e) => {
                        setCustomText(e.target.value);
                        setSelected("other");
                      }}
                      placeholder="比如：看展、露营、唱 K、City walk"
                      className="mm-input h-9 w-full px-3 text-[12.5px] placeholder:text-fg-dim"
                    />
                  </div>
                </Fragment>
              );
            }

            return (
              <button
                key={a.id}
                type="button"
                disabled={!a.supported}
                aria-pressed={active}
                onClick={() => setSelected(a.id)}
                className={cardClass(active, a.supported)}
              >
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-[12px]">
                  <ActivityArt scene={a.id} dim={!a.supported} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold text-fg">{a.name}</p>
                  <p className="mt-0.5 truncate text-[11px] text-fg-muted">{a.desc}</p>
                  <span
                    className={`mt-1.5 inline-flex items-center gap-1 text-[11px] ${
                      a.supported ? "text-emerald-500" : "text-fg-dim"
                    }`}
                  >
                    <Icon name={a.supported ? "check" : "clock"} size={11} strokeWidth={2.2} />
                    {a.supported ? "已支持" : "即将开放"}
                  </span>
                </div>

                <CheckCircle active={active} />
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex flex-col items-center gap-2 pb-1">
          <button
            type="button"
            onClick={next}
            disabled={!selected}
            className="mm-btn-primary h-11 w-full max-w-[286px] text-[14px]"
          >
            下一步
            <Icon name="arrow-right" size={16} />
          </button>
          <p className="flex items-center gap-1.5 text-[11.5px]">
            {chosen ? (
              <>
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white">
                  <Icon name="check" size={9} strokeWidth={3.4} />
                </span>
                <span className="text-fg-muted">
                  已选择：<span className="font-medium text-fg">{chosenLabel}</span>
                </span>
              </>
            ) : (
              <span className="text-fg-dim">先选一个活动，再进入下一步</span>
            )}
          </p>
        </div>
        </div>
      </main>
    </div>
  );
}

/** 活动卡片的公共外观，九张卡（含「其他」）共用同一套 */
function cardClass(active: boolean, supported: boolean) {
  return [
    "group relative flex items-center gap-3 rounded-[16px] border bg-white p-2.5 text-left transition-all",
    active
      ? "border-brand shadow-[0_10px_24px_-16px_rgba(37,99,235,0.8)] ring-2 ring-brand/12"
      : "border-line hover:-translate-y-0.5 hover:border-[#cfdff9] hover:shadow-[0_12px_24px_-20px_rgba(30,64,175,0.45)]",
    supported ? "" : "cursor-not-allowed opacity-70",
  ].join(" ");
}

function CheckCircle({ active }: { active: boolean }) {
  return (
    <span
      className={`absolute right-2.5 top-2.5 flex h-[17px] w-[17px] items-center justify-center rounded-full border transition-colors ${
        active
          ? "border-brand bg-brand text-white"
          : "border-line-strong bg-white text-transparent"
      }`}
    >
      <Icon name="check" size={10} strokeWidth={3.2} />
    </span>
  );
}
