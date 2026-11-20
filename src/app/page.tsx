"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { createRoomId, parseRoomId, saveRoom } from "@/lib/meetmate";

export default function Home() {
  const router = useRouter();
  const [link, setLink] = useState("");
  const [error, setError] = useState("");

  function handleCreate() {
    const id = createRoomId();
    saveRoom({ id, createdAt: Date.now() });
    router.push(`/room/${id}/activity`);
  }

  function handleJoin() {
    const id = parseRoomId(link);
    if (!id) {
      setError("没找到有效的房间号，链接里应该包含 MM20261120-1234 这样的编号。");
      return;
    }
    setError("");
    router.push(`/room/${id}`);
  }

  return (
    <div className="flex flex-1 justify-center px-5 py-14">
      <main className="w-full max-w-2xl">
        <header className="text-center">
          <h1 className="text-5xl font-semibold tracking-tight">MeetMate</h1>
          <p className="mt-4 text-base text-fg-muted">让每一次聚会，都有一个好处处</p>
        </header>

        <section className="mt-10 rounded-2xl border border-line bg-surface p-6">
          <Icon name="plus" size={26} className="text-fg-muted" />
          <h2 className="mt-4 text-xl font-semibold">创建一个房间</h2>
          <p className="mt-1 text-sm text-fg-muted">发起聚会，邀请朋友一起规划</p>
          <button
            type="button"
            onClick={handleCreate}
            className="mt-5 h-12 w-full rounded-xl bg-surface-2 text-base font-medium text-fg transition-colors hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-green/40"
          >
            创建房间
          </button>
        </section>

        <section className="mt-4 rounded-2xl border border-line bg-surface p-6">
          <Icon name="users" size={26} className="text-fg-muted" />
          <h2 className="mt-4 text-xl font-semibold">加入好友房间</h2>
          <input
            value={link}
            onChange={(e) => {
              setLink(e.target.value);
              setError("");
            }}
            placeholder="粘贴好友分享的房间链接"
            className="mt-4 h-12 w-full rounded-xl border border-line bg-transparent px-4 text-base text-fg outline-none focus:border-white/30"
          />
          {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
          <button
            type="button"
            onClick={handleJoin}
            className="mt-3 h-12 w-full rounded-xl bg-surface-2 text-base font-medium text-fg transition-colors hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-green/40"
          >
            加入房间
          </button>
        </section>

        <p className="mt-10 text-center text-xs leading-relaxed text-fg-dim">
          MeetMate · ZJUT HACK 2026 学生作品
          <br />
          演示数据均为虚构，不含任何真实个人信息
        </p>
      </main>
    </div>
  );
}
