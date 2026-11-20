"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ActivityArt, Icon } from "@/components/icons";
import {
  ACTIVITIES,
  type ActivityId,
  loadRoom,
  saveRoom,
} from "@/lib/meetmate";

export default function ActivityClient({ roomId }: { roomId: string }) {
  const router = useRouter();
  const [selected, setSelected] = useState<ActivityId | null>(null);
  const [shareLink, setShareLink] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setSelected(loadRoom(roomId).activityId ?? null);
    setShareLink(`${window.location.origin}/room/${roomId}`);
  }, [roomId]);

  function copyLink() {
    if (!shareLink) return;
    navigator.clipboard?.writeText(shareLink);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  function next() {
    if (!selected) return;
    saveRoom({ ...loadRoom(roomId), id: roomId, activityId: selected });
    router.push(`/room/${roomId}/chat`);
  }

  return (
    <div className="flex flex-1 justify-center px-5 py-10">
      <main className="w-full max-w-4xl pb-24">
        <div className="rounded-2xl border border-line bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-fg-muted">房间信息</p>
              <p className="mt-1 font-mono text-base tracking-wide">{roomId}</p>
            </div>
            <span className="rounded-full bg-green/12 px-3 py-1 text-xs text-green">
              房间进行中
            </span>
          </div>
          <div className="mt-4 flex gap-2">
            <div className="flex h-11 flex-1 items-center overflow-hidden rounded-xl border border-line px-3">
              <span className="truncate text-sm text-fg-muted">
                {shareLink || "正在生成链接…"}
              </span>
            </div>
            <button
              type="button"
              onClick={copyLink}
              className="flex h-11 items-center gap-2 rounded-xl bg-surface-2 px-4 text-sm text-fg transition-colors hover:bg-white/10"
            >
              <Icon name={copied ? "check" : "copy"} size={16} />
              {copied ? "已复制" : "复制"}
            </button>
          </div>
        </div>

        <h1 className="mt-9 text-2xl font-semibold tracking-tight">
          今天想和朋友去做什么？
        </h1>
        <p className="mt-2 text-sm text-fg-muted">
          选择你们已经商量好的活动，MeetMate 帮你们找到合适的地点。
        </p>

        <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {ACTIVITIES.map((a) => {
            const active = selected === a.id;
            return (
              <button
                key={a.id}
                type="button"
                disabled={!a.supported}
                onClick={() => setSelected(a.id)}
                className={[
                  "group relative flex flex-col overflow-hidden rounded-2xl border bg-surface text-left transition-all",
                  active
                    ? "border-green shadow-[0_0_0_1px_rgba(74,222,128,0.5)]"
                    : "border-line",
                  a.supported ? "hover:border-white/25" : "cursor-not-allowed",
                ].join(" ")}
              >
                <div className="h-36 w-full shrink-0">
                  <ActivityArt icon={a.icon} tint={a.tint} dim={!a.supported} />
                </div>
                <div className="flex flex-1 flex-col p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-base font-medium">{a.name}</span>
                    {active && (
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-green/15 text-green">
                        <Icon name="check" size={13} />
                      </span>
                    )}
                  </div>
                  <p className="mt-1 truncate text-xs text-fg-dim">{a.desc}</p>
                  <span
                    className={[
                      "mt-3 inline-block w-fit rounded-md px-2 py-0.5 text-[11px]",
                      a.supported
                        ? "bg-green/12 text-green"
                        : "bg-white/6 text-fg-dim",
                    ].join(" ")}
                  >
                    {a.supported ? "已支持" : "即将开放"}
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        <div className="fixed inset-x-0 bottom-0 border-t border-line bg-bg/90 px-5 py-4 backdrop-blur">
          <div className="mx-auto flex max-w-4xl items-center gap-4">
            <p className="hidden flex-1 text-sm text-fg-muted sm:block">
              {selected
                ? `已选：${ACTIVITIES.find((a) => a.id === selected)?.name}`
                : "先选一个活动"}
            </p>
            <button
              type="button"
              onClick={next}
              disabled={!selected}
              className="h-12 w-full rounded-xl bg-surface-2 text-base font-medium text-fg transition-colors enabled:hover:bg-white/10 disabled:cursor-not-allowed disabled:text-fg-dim sm:w-56"
            >
              下一步：粘贴群聊
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
