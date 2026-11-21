import { DEFAULT_BASE_URL, DEFAULT_MODEL, type ApiConfig } from "./api-key";

/**
 * 服务端 AI 调用封装。只被 route handler 使用。
 *
 * 设计要点：
 * - 不在任何地方缓存 Key，用完即弃。
 * - 错误必须携带「可诊断信息」：HTTP 状态码 + 上游原始返回片段，
 *   这样用户填错 Key、模型名不存在、余额不足时能直接看到原因，
 *   而不是只得到一句「无效」。
 */

export const AI_TIMEOUT_MS = 45_000;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export class AiError extends Error {
  code: string;
  status?: number;
  detail?: string;

  constructor(
    code: string,
    message: string,
    extra?: { status?: number; detail?: string }
  ) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.status = extra?.status;
    this.detail = extra?.detail;
  }
}

/** 只允许 https 公网地址，挡掉内网与回环，避免被当成 SSRF 跳板 */
export function assertSafeBase(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw || DEFAULT_BASE_URL);
  } catch {
    throw new AiError("BAD_BASE_URL", "接口地址格式不正确");
  }
  if (url.protocol !== "https:") {
    throw new AiError("BAD_BASE_URL", "接口地址必须是 https:// 开头");
  }
  const host = url.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked) throw new AiError("BAD_BASE_URL", "接口地址不允许指向内网");
  return url;
}

/** 用户可能填到域名、/v1、或完整 endpoint，这里统一补齐 */
export function endpointOf(base: URL): URL {
  const full = base.toString().replace(/\/+$/, "");
  if (full.endsWith("/chat/completions")) return new URL(full);
  return new URL(`${full}/chat/completions`);
}

function redact(text: string, key: string) {
  if (!key) return text;
  return text.split(key).join("****");
}

/** 上游返回的错误体里通常有可直接读懂的 message，抽出来 */
function upstreamMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; code?: string };
      message?: string;
    };
    return (
      parsed.error?.message ??
      parsed.message ??
      body.slice(0, 200)
    );
  } catch {
    return body.slice(0, 200);
  }
}

export async function callChat(
  cfg: ApiConfig,
  messages: ChatMessage[],
  opts: {
    json?: boolean;
    maxTokens?: number;
    thinking?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<{ text: string; model: string }> {
  const key = (cfg.key ?? "").trim();
  if (!key) throw new AiError("NO_KEY", "没有填写 API Key");

  const base = assertSafeBase(cfg.baseUrl || DEFAULT_BASE_URL);
  const model = (cfg.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const url = endpointOf(base);

  const payload: Record<string, unknown> = {
    model,
    messages,
    max_tokens: opts.maxTokens ?? 1600,
    stream: false,
  };

  // DeepSeek 思考模式默认开启，抽取类任务关掉更快更省；非 DeepSeek 服务不传
  if (opts.thinking === false && base.hostname.includes("deepseek")) {
    payload.thinking = { type: "disabled" };
  }
  if (opts.json) {
    payload.response_format = { type: "json_object" };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? AI_TIMEOUT_MS
  );

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!res.ok) {
      const body = redact(await res.text().catch(() => ""), key);
      const msg = upstreamMessage(body);

      if (res.status === 401) {
        throw new AiError(
          "AUTH",
          "Key 认证失败（401）",
          { status: 401, detail: msg }
        );
      }
      if (res.status === 402) {
        throw new AiError("BALANCE", "账户余额不足（402）", {
          status: 402,
          detail: msg,
        });
      }
      if (res.status === 429) {
        throw new AiError("RATE", "请求太频繁或超出并发上限（429）", {
          status: 429,
          detail: msg,
        });
      }
      if (
        res.status === 404 ||
        (/model/i.test(msg) && /not\s*(exist|found)/i.test(msg))
      ) {
        throw new AiError(
          "MODEL",
          `模型「${model}」不可用`,
          { status: res.status, detail: msg }
        );
      }
      throw new AiError("UPSTREAM", `AI 接口返回 ${res.status}`, {
        status: res.status,
        detail: msg,
      });
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) {
      throw new AiError("EMPTY", "模型返回了空内容，请重试");
    }
    return { text, model };
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw new AiError("TIMEOUT", "AI 响应超时，请重试");
    }
    throw new AiError(
      "NETWORK",
      e instanceof Error ? `连接 AI 服务失败：${e.message}` : "连接 AI 服务失败"
    );
  } finally {
    clearTimeout(timer);
  }
}

/** 模型偶尔会把 JSON 包在 ```json 里，或者前后加解释文字 */
export function parseJsonLoose(text: string): Record<string, unknown> | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
        return parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 把 AiError 转成统一的 API 响应体 */
export function aiErrorBody(e: unknown) {
  if (e instanceof AiError) {
    return {
      status: e.code === "NO_KEY" ? 400 : e.status ?? 502,
      body: {
        ok: false as const,
        code: e.code,
        error: e.message,
        detail: e.detail ?? null,
      },
    };
  }
  return {
    status: 500,
    body: {
      ok: false as const,
      code: "INTERNAL",
      error: e instanceof Error ? e.message : "服务端异常",
      detail: null,
    },
  };
}

/** 从请求体里取出用户配置 */
export function readConfig(raw: unknown): ApiConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  return {
    key: String(cfg.key ?? process.env.DEEPSEEK_API_KEY ?? "").trim(),
    baseUrl: String(cfg.baseUrl ?? DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL,
    model: String(cfg.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    amapKey: (String(cfg.amapKey ?? "").trim() || process.env.AMAP_WEB_KEY || "").trim(),
  };
}
