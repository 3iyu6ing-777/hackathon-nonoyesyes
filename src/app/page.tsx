"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/site-header";
import { Icon } from "@/components/icons";
import { CalendarArt, FriendsArt, HeroMapArt } from "@/components/illustrations";
import { createRoomId, parseRoomId, saveRoom } from "@/lib/meetmate";

export default function Home() {
  const router = useRouter();
  const [link, setLink] = useState("");
  const [error, setError] = useState("");

  function handleCreate() {
    const id = createRoomId();
    saveRoom({ id, createdAt: Date.now(), title: "周末出去玩" });
    router.push(`/room/${id}/activity`);
  }

  function handleJoin() {
    const id = parseRoomId(link);
    if (!id) {
      setError("链接里应该有 MM20261120-1234 这样的房间号，检查一下再试。");
      return;
    }
    setError("");
    router.push(`/room/${id}`);
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
      <SiteHeader active="home" />

      <main className="mm-scroll mx-auto flex w-full max-w-[1200px] min-h-0 flex-1 flex-col overflow-y-auto px-5 py-5">
        <div className="my-auto w-full">
        <section className="mm-in grid items-center gap-4 lg:grid-cols-[1fr_auto]">
          <div>
            <h1 className="text-[46px] font-bold leading-[1.02] tracking-[-0.03em] text-fg sm:text-[62px]">
              MeetMate
            </h1>
            <p className="mt-3 text-[22px] font-semibold tracking-tight text-fg sm:text-[27px]">
              让每一次聚会，都不再犹豫。
            </p>
            <p className="mt-3 text-[13px] text-fg-dim">AI 聚会组局助手</p>
          </div>
          <HeroMapArt className="hidden h-[250px] w-[420px] shrink-0 lg:block" />
        </section>

        <section className="mt-6 grid gap-4 lg:grid-cols-2">
          <div className="mm-card mm-in relative flex min-h-[212px] flex-col justify-center overflow-hidden p-6">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-soft text-brand">
                  <Icon name="plus" size={20} strokeWidth={2} />
                </span>
                <h2 className="mt-3.5 text-[21px] font-semibold tracking-tight">创建一个房间</h2>
                <p className="mt-1.5 text-[13.5px] text-fg-muted">发起聚会，邀请朋友一起规划。</p>
                <button
                  type="button"
                  onClick={handleCreate}
                  className="mm-btn-primary mt-5 h-11 px-6 text-[13.5px]"
                >
                  创建房间
                  <Icon name="arrow-right" size={15} />
                </button>
              </div>
              <CalendarArt className="hidden h-[176px] w-[186px] shrink-0 sm:block" />
            </div>
          </div>

          <div className="mm-card mm-in relative flex min-h-[212px] flex-col justify-center overflow-hidden p-6">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-soft text-brand">
                  <Icon name="users" size={19} strokeWidth={1.9} />
                </span>
                <h2 className="mt-3.5 text-[21px] font-semibold tracking-tight">加入好友房间</h2>
                <p className="mt-1.5 text-[13.5px] text-fg-muted">输入朋友分享的链接，加入聚会。</p>

                <div className="mt-5 flex items-center gap-2">
                  <div
                    className={`flex h-11 min-w-0 flex-1 items-center gap-2 rounded-[13px] border px-3 transition-colors ${
                      error
                        ? "border-red-300 bg-red-50/70"
                        : "border-line bg-surface-2 focus-within:border-[#b9cffb]"
                    }`}
                  >
                    <Icon name="link" size={14} className="shrink-0 text-fg-dim" />
                    <input
                      value={link}
                      onChange={(e) => {
                        setLink(e.target.value);
                        setError("");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) handleJoin();
                      }}
                      placeholder="粘贴房间链接…"
                      aria-invalid={Boolean(error)}
                      className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleJoin}
                    className="mm-btn-primary h-11 shrink-0 rounded-[13px] px-5 text-[13.5px]"
                  >
                    加入房间
                  </button>
                </div>
                {error ? (
                  <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-red-500">
                    <Icon name="info" size={12} className="mt-[1px] shrink-0" />
                    {error}
                  </p>
                ) : (
                  <p className="mt-2 text-[11px] text-fg-dim">
                    没有链接？先创建一个房间，再把生成的链接发到群里。
                  </p>
                )}
              </div>
              <FriendsArt className="hidden h-[160px] w-[170px] shrink-0 sm:block" />
            </div>
          </div>
        </section>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-fg-dim">
          <span>MeetMate · ZJUT HACK 2026 学生作品</span>
          <span className="hidden sm:inline">演示数据均为虚构，不含任何真实个人信息</span>
        </div>
        </div>
      </main>
    </div>
  );
}
