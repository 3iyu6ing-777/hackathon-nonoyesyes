"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/icons";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  KEY_EVENT,
  OPEN_EVENT,
  clearApiConfig,
  loadApiConfig,
  maskKey,
  saveApiConfig,
} from "@/lib/api-key";

type Diag = {
  ok: boolean;
  code?: string;
  error?: string;
  hint?: string;
  detail?: string | null;
  warnings?: string[];
  endpoint?: string;
  latencyMs?: number;
  model?: string;
  sample?: string;
  count?: number;
};

type Busy = "none" | "ai" | "map";

export default function SettingsPanel() {
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [key, setKey] = useState("");
  const [amapKey, setAmapKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [reveal, setReveal] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState<Busy>("none");
  const [aiDiag, setAiDiag] = useState<Diag | null>(null);
  const [mapDiag, setMapDiag] = useState<Diag | null>(null);
  const [saveNote, setSaveNote] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  // 房间页底部左右两侧是输入框和地图图例，浮层会压住内容；
  // 那一页的入口放在顶栏「配置 Key」，这里就不再固定一个按钮。
  const pathname = usePathname();
  const hideLauncher = Boolean(pathname?.startsWith("/room/"));

  // Key 存在浏览器 localStorage，挂载后读一次填进表单
  useEffect(() => {
    const cfg = loadApiConfig();
    setKey(cfg.key);
    setAmapKey(cfg.amapKey);
    setBaseUrl(cfg.baseUrl);
    setModel(cfg.model);
    setConfigured(Boolean(cfg.key));

    const sync = () => setConfigured(Boolean(loadApiConfig().key));
    const openIt = () => {
      setOpen(true);
      setSaveNote("");
    };
    if (window.location.hash === "#settings") openIt();

    window.addEventListener(KEY_EVENT, sync);
    window.addEventListener(OPEN_EVENT, openIt);
    return () => {
      window.removeEventListener(KEY_EVENT, sync);
      window.removeEventListener(OPEN_EVENT, openIt);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      const el = e.target as Node;
      if (panelRef.current && !panelRef.current.contains(el)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const trimmed = key.trim();

  function save() {
    saveApiConfig({ key: trimmed, baseUrl, model, amapKey });
    setConfigured(Boolean(trimmed));
    setSaveNote(
      trimmed
        ? amapKey.trim()
          ? "已保存，AI 与地图都就绪"
          : "AI Key 已保存；还缺高德 Key，无法检索真实地点"
        : "已保存；没有 AI Key 时不会生成方案"
    );
  }

  async function testAi() {
    if (!trimmed) {
      setAiDiag({ ok: false, code: "NO_KEY", error: "先填入 AI Key" });
      return;
    }
    setBusy("ai");
    setAiDiag(null);
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { key: trimmed, baseUrl, model } }),
      });
      const data = (await res.json()) as Diag;
      setAiDiag({ ...data, ok: res.ok && data.ok });
    } catch {
      setAiDiag({ ok: false, error: "网络异常，没能连上本站接口" });
    } finally {
      setBusy("none");
    }
  }

  async function testMap() {
    if (!amapKey.trim()) {
      setMapDiag({ ok: false, code: "NO_AMAP_KEY", error: "先填入高德 Key" });
      return;
    }
    setBusy("map");
    setMapDiag(null);
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ probe: "amap", amapKey: amapKey.trim() }),
      });
      const data = (await res.json()) as Diag;
      setMapDiag({ ...data, ok: res.ok && data.ok });
    } catch {
      setMapDiag({ ok: false, error: "网络异常，没能连上本站接口" });
    } finally {
      setBusy("none");
    }
  }

  function remove() {
    clearApiConfig();
    setKey("");
    setAmapKey("");
    setBaseUrl(DEFAULT_BASE_URL);
    setModel(DEFAULT_MODEL);
    setConfigured(false);
    setAiDiag(null);
    setMapDiag(null);
    setSaveNote("已清除全部 Key");
  }

  return (
    <>
      <div
        className={`fixed bottom-4 left-4 z-[900] flex-col items-start gap-2 ${
          hideLauncher ? "hidden" : "flex"
        }`}
      >
        {!open && !configured && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="ml-1 flex items-center gap-1.5 rounded-full border border-brand/25 bg-white/95 px-3 py-1.5 text-[11px] text-brand shadow-[0_10px_24px_-14px_rgba(37,99,235,0.7)] backdrop-blur transition-colors hover:bg-brand-soft"
          >
            <Icon name="sparkles" size={12} />
            点这里配置 AI Key
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            setSaveNote("");
          }}
          aria-label="AI 设置"
          className="relative flex h-9 w-9 items-center justify-center rounded-full border border-line bg-white/95 text-fg-muted shadow-[0_10px_24px_-16px_rgba(15,23,42,0.6)] backdrop-blur transition-colors hover:text-brand"
        >
          <Icon name="gear" size={16} />
          {!configured && (
            <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand/60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand" />
            </span>
          )}
          {configured && (
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-white" />
          )}
        </button>
      </div>

      {open && (
        <div
          ref={panelRef}
          className="mm-scroll fixed bottom-16 left-4 z-[901] max-h-[min(78vh,640px)] w-[min(390px,calc(100vw-2rem))] overflow-y-auto rounded-[20px] border border-line bg-white p-4 shadow-[0_24px_60px_-24px_rgba(15,23,42,0.45)]"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-1.5 text-[13.5px] font-semibold">
                <Icon name="key" size={14} className="text-brand" />
                配置
              </h3>
              <p className="mt-1 text-[10.5px] leading-relaxed text-fg-dim">
                两个 Key 都只保存在你自己的浏览器里，请求时随请求体发给本站转发，服务端不存储、不落日志。
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="关闭"
              className="rounded-md p-1 text-fg-dim transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <Icon name="close" size={14} />
            </button>
          </div>

          <div className="mt-3.5 rounded-[14px] border border-line bg-[#fbfdff] p-2.5">
            <label className="block text-[10.5px] font-medium text-fg-muted">
              <span className="flex items-center justify-between">
                AI Key（必需）
                <span className="text-[9.5px] font-normal text-fg-dim">DeepSeek 默认</span>
              </span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type={reveal ? "text" : "password"}
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    setAiDiag(null);
                  }}
                  placeholder="sk-..."
                  spellCheck={false}
                  autoComplete="off"
                  className="mm-input w-full px-2.5 py-1.5 font-mono text-[11px]"
                />
                <button
                  type="button"
                  onClick={() => setReveal((v) => !v)}
                  className="shrink-0 rounded-md px-1.5 py-1 text-[10px] text-fg-dim transition-colors hover:text-brand"
                >
                  {reveal ? "隐藏" : "显示"}
                </button>
              </div>
            </label>

            {configured && trimmed && (
              <p className="mt-1.5 text-[10px] text-emerald-600">已配置：{maskKey(trimmed)}</p>
            )}

            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                onClick={() => void testAi()}
                disabled={busy !== "none"}
                className="mm-btn-ghost h-7 px-2.5 text-[10px]"
              >
                {busy === "ai" ? "检测中…" : "测试 AI"}
              </button>
              <button
                type="button"
                onClick={() => setAdvanced((v) => !v)}
                className="mm-btn-ghost h-7 px-2.5 text-[10px]"
              >
                {advanced ? "收起高级" : "高级"}
              </button>
            </div>

            {advanced && (
              <div className="mt-2 space-y-2 rounded-lg border border-line bg-white p-2.5">
                <label className="block text-[10px] text-fg-muted">
                  接口地址
                  <input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    spellCheck={false}
                    className="mm-input mt-1 w-full px-2 py-1.5 font-mono text-[10px]"
                  />
                </label>
                <label className="block text-[10px] text-fg-muted">
                  模型名
                  <input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    spellCheck={false}
                    className="mm-input mt-1 w-full px-2 py-1.5 font-mono text-[10px]"
                  />
                </label>
                <p className="text-[9px] leading-relaxed text-fg-dim">
                  DeepSeek 填 https://api.deepseek.com 即可，路径会自动补全。可用模型：
                  deepseek-flash、deepseek-v4-pro。换成其它 OpenAI 兼容服务时填到域名就行。
                </p>
              </div>
            )}

            {aiDiag && <DiagBox diag={aiDiag} />}
          </div>

          <div className="mt-2.5 rounded-[14px] border border-line bg-[#fbfdff] p-2.5">
            <label className="block text-[10.5px] font-medium text-fg-muted">
              <span className="flex items-center justify-between">
                高德 Web 服务 Key（必需）
                <span className="text-[9.5px] font-normal text-fg-dim">console.amap.com</span>
              </span>
              <input
                type="password"
                value={amapKey}
                onChange={(e) => {
                  setAmapKey(e.target.value);
                  setMapDiag(null);
                }}
                placeholder="32 位十六进制"
                spellCheck={false}
                autoComplete="off"
                className="mm-input mt-1 w-full px-2.5 py-1.5 font-mono text-[11px]"
              />
            </label>
            <p className="mt-1.5 text-[9px] leading-relaxed text-fg-dim">
              必须是「Web 服务」类型的 Key。推荐地点、坐标、人均、营业时间都靠它实时查，
              没有它就只能停在配置页，不会生成任何猜测结果。
            </p>
            <button
              type="button"
              onClick={() => void testMap()}
              disabled={busy !== "none"}
              className="mm-btn-ghost mt-2 h-7 px-2.5 text-[10px]"
            >
              {busy === "map" ? "检测中…" : "测试地图"}
            </button>
            {mapDiag && <DiagBox diag={mapDiag} compact />}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button type="button" onClick={save} className="mm-btn-primary h-9 flex-1 text-[11.5px]">
              保存
            </button>
            <button
              type="button"
              onClick={remove}
              className="mm-btn-ghost h-9 px-3 text-[11px] hover:border-red-200 hover:text-red-500"
            >
              清除
            </button>
          </div>

          {saveNote && <p className="mt-2 text-[10px] text-emerald-600">{saveNote}</p>}

          <p className="mt-2.5 border-t border-line pt-2 text-[9px] leading-relaxed text-fg-dim">
            这一版没有预设兜底：不填 Key 就不会生成方案，避免出现看着像结论的假数据。
          </p>
        </div>
      )}
    </>
  );
}

function DiagBox({ diag, compact }: { diag: Diag; compact?: boolean }) {
  const tone = diag.ok
    ? "border-emerald-200 bg-emerald-50/70"
    : "border-amber-200 bg-amber-50/70";

  return (
    <div className={`mt-2 rounded-lg border p-2.5 ${tone}`}>
      <p
        className={`text-[10px] font-medium ${
          diag.ok ? "text-emerald-600" : "text-amber-700"
        }`}
      >
        {diag.ok
          ? compact
            ? `连接成功 · 检索到 ${diag.count ?? 0} 个地点${diag.latencyMs ? ` · ${diag.latencyMs}ms` : ""}`
            : `连接成功 · ${diag.model ?? ""}${diag.latencyMs ? ` · ${diag.latencyMs}ms` : ""}`
          : `${diag.error ?? "失败"}${diag.code ? `（${diag.code}）` : ""}`}
      </p>

      {diag.ok && diag.sample && (
        <p className="mt-1 text-[9px] leading-relaxed text-fg-dim">
          {compact ? `样例：${diag.sample}` : `返回：${diag.sample}`}
        </p>
      )}

      {!diag.ok && diag.detail && (
        <p className="mt-1 break-words rounded bg-white/80 px-2 py-1.5 font-mono text-[9px] leading-relaxed text-fg-muted">
          {diag.detail}
        </p>
      )}

      {diag.hint && <p className="mt-1 text-[9px] leading-relaxed text-fg-muted">{diag.hint}</p>}

      {Boolean(diag.warnings?.length) && (
        <ul className="mt-1.5 space-y-0.5">
          {diag.warnings!.map((w) => (
            <li key={w} className="text-[9px] leading-relaxed text-amber-600">
              · {w}
            </li>
          ))}
        </ul>
      )}

      {diag.endpoint && (
        <p className="mt-1.5 break-all font-mono text-[8.5px] leading-relaxed text-fg-dim">
          请求：{diag.endpoint}
        </p>
      )}
    </div>
  );
}
