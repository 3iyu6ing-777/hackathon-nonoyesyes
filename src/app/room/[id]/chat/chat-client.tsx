"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
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
  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const room = loadRoom(roomId);
    setChat(room.chat ?? "");
    setActivity(room.activityId);
  }, [roomId]);

  const activityName = ACTIVITIES.find((a) => a.id === activity)?.name;

  function start() {
    if (chat.trim().length < 10) {
      setError("聊天内容太短，先把群里的讨论粘贴进来（或点「填入示例」）。");
      return;
    }
    setError("");
    saveRoom({ id: roomId, createdAt: Date.now(), activityId: activity, chat });
    router.push(`/room/${roomId}`);
  }

  return (
    <div className="flex flex-1 justify-center px-5 py-10">
      <main className="w-full max-w-2xl">
        <span className="inline-flex items-center gap-2 rounded-full bg-white/6 px-3 py-1 text-xs text-fg-muted">
          {activityName ?? "未选活动"}
          <span className="text-fg-dim">·</span>
          <span className="font-mono">{roomId}</span>
        </span>

        <h1 className="mt-4 text-2xl font-semibold tracking-tight">
          让 AI 了解你们的聚会计划
        </h1>
        <p className="mt-2 text-sm text-fg-muted">
          把群聊中讨论的内容交给 MeetMate，AI 将自动提取每个人的需求。
        </p>

        <section className="mt-8">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full border border-line text-[11px] text-fg-muted">
              1
            </span>
            <h2 className="text-base font-medium">粘贴群聊记录</h2>
            <span className="rounded-md bg-green/12 px-2 py-0.5 text-[11px] text-green">
              建议填写
            </span>
            <button
              type="button"
              onClick={() => {
                setChat(SAMPLE_CHAT);
                setError("");
              }}
              className="ml-auto text-xs text-fg-muted underline underline-offset-4 hover:text-fg"
            >
              填入示例
            </button>
          </div>

          <textarea
            value={chat}
            onChange={(e) => {
              setChat(e.target.value);
              setError("");
            }}
            placeholder="例如：周六下午大家都有空，想找个地方吃火锅。小王预算 100 元，小李从学校出发……"
            className="mt-3 h-52 w-full resize-y rounded-xl border border-line bg-surface p-4 text-base leading-relaxed text-fg outline-none placeholder:text-fg-dim focus:border-white/25"
          />
          <div className="mt-1 flex justify-between text-xs text-fg-dim">
            <span>
              {error ? (
                <span className="text-red-400">{error}</span>
              ) : (
                "内容只在本地处理，不会公开"
              )}
            </span>
            <span className="font-mono">{chat.length} 字</span>
          </div>
        </section>

        <section className="mt-8">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full border border-line text-[11px] text-fg-muted">
              2
            </span>
            <h2 className="text-base font-medium">上传补充文件</h2>
            <span className="rounded-md bg-white/6 px-2 py-0.5 text-[11px] text-fg-dim">
              选填
            </span>
          </div>

          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="mt-3 flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 bg-surface/60 py-10 transition-colors hover:border-white/30"
          >
            <Icon name="upload" size={26} className="text-fg-muted" />
            <span className="text-sm font-medium">点击上传文件</span>
            <span className="text-xs text-fg-dim">
              支持聊天截图、图片及其他补充资料
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const names = Array.from(e.target.files ?? []).map((f) => f.name);
              setFiles((prev) => [...prev, ...names]);
            }}
          />
          {files.length > 0 && (
            <ul className="mt-3 space-y-2">
              {files.map((name, i) => (
                <li
                  key={`${name}-${i}`}
                  className="flex items-center justify-between rounded-lg border border-line bg-surface px-3 py-2 text-sm"
                >
                  <span className="truncate text-fg-muted">{name}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setFiles((prev) => prev.filter((_, idx) => idx !== i))
                    }
                    className="ml-3 text-xs text-fg-dim hover:text-fg"
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-fg-dim">
            提示：图片内容识别尚未开启，当前版本仅记录文件名。
          </p>
        </section>

        <button
          type="button"
          onClick={start}
          className="mt-8 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-surface-2 text-base font-medium transition-colors hover:bg-white/10"
        >
          开始分析需求
          <Icon name="arrow-down" size={18} className="text-fg-muted" />
        </button>
      </main>
    </div>
  );
}
