"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/site-header";
import { Icon } from "@/components/icons";
import { HeroChatArt } from "@/components/illustrations";
import {
  ACTIVITIES,
  type ActivityId,
  loadRoom,
  saveRoom,
  SAMPLE_CHAT,
} from "@/lib/meetmate";

export default function ChatClient({ roomId }: { roomId: string }) {
  const router = useRouter();
  const [chat, setChat] = useState("");
  const [activity, setActivity] = useState<ActivityId | undefined>();
  const [customActivity, setCustomActivity] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // 群聊内容在 localStorage 里，挂载后才读得到
  useEffect(() => {
    const room = loadRoom(roomId);
    setChat(room.chat ?? "");
    setActivity(room.activityId);
    setCustomActivity(room.customActivity ?? "");
  }, [roomId]);

  const activityName =
    activity === "other"
      ? customActivity.trim() || "其他"
      : ACTIVITIES.find((a) => a.id === activity)?.name;

  function start() {
    if (chat.trim().length < 10) {
      setError("聊天内容太短，先把群里的讨论粘贴进来（或点「填入示例」）。");
      return;
    }
    setError("");
    saveRoom({ ...loadRoom(roomId), id: roomId, activityId: activity, chat });
    router.push(`/room/${roomId}`);
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
      <SiteHeader active="home" />

      <div className="mm-scroll mx-auto flex w-full max-w-[1120px] min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 sm:px-6">
        <div className="flex min-h-0 flex-1 flex-col">
        <div className="mm-in flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h1 className="text-[26px] font-bold leading-tight tracking-tight text-fg sm:text-[32px]">
              让 AI 了解你们的聚会计划
            </h1>
            <p className="mt-2 max-w-[520px] text-[12.5px] leading-relaxed text-fg-muted">
              把群聊中讨论的内容交给 MeetMate，AI 将自动提取每个人的需求。
            </p>
            <span className="mm-chip mt-2.5">
              <Icon name="sparkles" size={11} />
              {activityName ? `${activityName} · ${roomId}` : "AI 聚会组局助手"}
            </span>
          </div>
          <HeroChatArt className="mt-1 hidden h-[118px] w-[182px] shrink-0 md:block" />
        </div>

        <div className="mt-4 grid min-h-0 flex-1 gap-3.5 lg:grid-cols-2 lg:grid-rows-1">
          {/* ① 群聊记录 */}
          <section className="mm-card flex min-h-0 flex-col p-4">
            <div className="flex shrink-0 items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-brand">
                1
              </span>
              <h2 className="text-[15px] font-semibold">粘贴群聊记录</h2>
              <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[10.5px] text-brand">
                必填
              </span>
              <button
                type="button"
                onClick={() => {
                  setChat(SAMPLE_CHAT);
                  setError("");
                }}
                className="ml-auto flex items-center gap-1 text-[11.5px] text-fg-dim transition-colors hover:text-brand"
              >
                <Icon name="spark" size={12} />
                填入示例
              </button>
              <button
                type="button"
                onClick={() => {
                  setChat("");
                  setError("");
                }}
                className="flex items-center gap-1 text-[11.5px] text-fg-dim transition-colors hover:text-red-500"
              >
                <Icon name="close" size={12} />
                清空
              </button>
            </div>

            <textarea
              value={chat}
              onChange={(e) => {
                setChat(e.target.value);
                setError("");
              }}
              placeholder={"例如：\n【周三 20:14】小王：周六下午大家都有空吗？想一起出来吃个火锅\n【周三 20:16】小李：我可以！不过我五点前得回学校\n【周三 20:25】小王：我预算大概 100 元左右"}
              className="mm-scroll mm-input mt-3 min-h-[150px] w-full flex-1 resize-none overflow-y-auto p-3 text-[12.5px] leading-[1.75] placeholder:text-fg-dim"
            />

            <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px]">
              {error ? (
                <span className="flex items-start gap-1 leading-relaxed text-red-500">
                  <Icon name="info" size={11} className="mt-[1px] shrink-0" />
                  {error}
                </span>
              ) : (
                <span className="text-fg-dim">内容只在本地处理，不会公开</span>
              )}
              <span className="shrink-0 font-mono text-fg-dim">{chat.length} 字</span>
            </div>
          </section>

          {/* ② 补充文件 */}
          <section className="mm-card flex min-h-0 flex-col p-4">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full border border-line-strong text-[11px] font-semibold text-fg-muted">
                2
              </span>
              <h2 className="text-[15px] font-semibold">上传补充文件</h2>
              <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-fg-dim">
                选填
              </span>
            </div>

            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="mt-3 flex min-h-[132px] w-full flex-1 flex-col items-center justify-center gap-1.5 rounded-[14px] border border-dashed border-[#cfdff9] bg-[#fafcff] transition-colors hover:border-brand/50 hover:bg-brand-soft/40"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-brand shadow-[0_6px_16px_-10px_rgba(37,99,235,0.6)]">
                <Icon name="upload" size={17} />
              </span>
              <span className="text-[13px] font-semibold text-brand">点击上传文件</span>
              <span className="text-[11px] text-fg-dim">
                支持聊天截图、图片及其他补充资料
              </span>
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,.txt,.md"
              className="hidden"
              onChange={(e) => {
                const names = Array.from(e.target.files ?? []).map((f) => f.name);
                setFiles((prev) => [...prev, ...names]);
              }}
            />

            <ul className="mm-scroll mt-2.5 max-h-[86px] space-y-1.5 overflow-y-auto">
              {files.map((name, i) => (
                <li
                  key={`${name}-${i}`}
                  className="flex items-center gap-2 rounded-[11px] border border-line bg-surface-2/70 px-2.5 py-1.5"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white text-brand">
                    <Icon name="image" size={13} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg">{name}</span>
                  <button
                    type="button"
                    onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                    aria-label={`移除 ${name}`}
                    className="shrink-0 rounded p-0.5 text-fg-dim transition-colors hover:text-red-500"
                  >
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ul>

            <p className="shrink-0 pt-2 text-[10.5px] leading-relaxed text-fg-dim">
              提示：图片内容识别尚未开启，当前版本只记录文件名；关键信息请直接粘在左侧。
            </p>
          </section>
        </div>
        </div>
      </div>

      <div className="shrink-0 px-4 pb-4 pt-1 sm:px-6">
        <div className="mx-auto flex w-full max-w-[1120px] flex-col items-center">
          <button
            type="button"
            onClick={start}
            className="mm-btn-primary h-11 w-full max-w-[300px] text-[14px]"
          >
            <Icon name="sparkles" size={15} />
            开始分析需求
            <Icon name="arrow-right" size={15} />
          </button>
          <p className="mt-1.5 text-[10.5px] text-fg-dim">
            地点、路程、票价全部实时查，不会用预设数据糊弄
          </p>
        </div>
      </div>
    </div>
  );
}
