"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { Logo } from "@/components/illustrations";
import { openSettings } from "@/lib/api-key";

export default function SiteHeader({ active = "home" }: { active?: "home" | "room" }) {
  const [help, setHelp] = useState(false);

  return (
    <>
      <header className="relative z-40 shrink-0 border-b border-white/70 bg-white/70 backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-full max-w-[1200px] items-center gap-3 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <Logo size={22} />
            <span className="text-[15px] font-semibold tracking-tight text-fg">MeetMate</span>
          </Link>
          <span className="hidden rounded-full bg-brand-soft px-2.5 py-1 text-[11px] font-medium text-brand sm:inline">
            AI 聚会组局助手
          </span>

          <nav className="ml-auto flex items-center gap-1">
            <Link
              href="/"
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] transition-colors ${
                active === "home"
                  ? "bg-white text-brand shadow-[0_2px_8px_-2px_rgba(37,99,235,0.25)]"
                  : "text-fg-muted hover:text-fg"
              }`}
            >
              <Icon name="home" size={14} />
              首页
            </Link>
            <button
              type="button"
              onClick={() => setHelp(true)}
              className="rounded-full px-3 py-1.5 text-[13px] text-fg-muted transition-colors hover:text-fg"
            >
              使用说明
            </button>
            <button
              type="button"
              onClick={openSettings}
              className="rounded-full px-3 py-1.5 text-[13px] text-fg-muted transition-colors hover:text-fg"
            >
              配置 Key
            </button>
            <button
              type="button"
              onClick={openSettings}
              aria-label="账号与设置"
              className="ml-1 flex h-7 w-7 items-center justify-center rounded-full border border-line bg-white text-fg-dim transition-colors hover:text-brand"
            >
              <Icon name="users" size={14} />
            </button>
          </nav>
        </div>
      </header>

      {help && (
        <div
          className="fixed inset-0 z-[800] flex items-center justify-center bg-slate-900/25 p-4 backdrop-blur-[2px]"
          onClick={() => setHelp(false)}
        >
          <div
            className="w-full max-w-md rounded-[22px] bg-white p-5 shadow-2xl shadow-slate-900/20"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-base font-semibold">三步组一次局</h2>
              <button
                type="button"
                onClick={() => setHelp(false)}
                aria-label="关闭"
                className="rounded-lg p-1 text-fg-dim transition-colors hover:bg-surface-2 hover:text-fg"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            <ol className="mt-4 space-y-3">
              {[
                ["选一个活动", "先定这顿是吃饭、桌游还是随便逛逛，后面找地方会按它来检索。"],
                ["粘贴群聊记录", "把群里讨论的原话贴进来，AI 从中读每个人的出发地、预算和忌讳。"],
                ["看方案、改位置", "地点、路程、地铁票价、打车费全部来自高德实时接口，位置读错了当场就能改。"],
              ].map(([title, desc], i) => (
                <li key={title} className="flex gap-3">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-brand">
                    {i + 1}
                  </span>
                  <div>
                    <p className="text-[13px] font-medium text-fg">{title}</p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">{desc}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-4 rounded-xl bg-surface-2 px-3 py-2 text-[11px] leading-relaxed text-fg-muted">
              需要自带两个 Key：一个 AI Key（默认 DeepSeek），一个高德「Web 服务」Key。
              两个 Key 都只存在你自己的浏览器里。
            </p>
            <button
              type="button"
              onClick={() => {
                setHelp(false);
                openSettings();
              }}
              className="mm-btn-primary mt-4 h-10 w-full text-[13px]"
            >
              去配置 Key
            </button>
          </div>
        </div>
      )}
    </>
  );
}
