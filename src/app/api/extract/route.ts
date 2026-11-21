import { NextResponse } from "next/server";
import {
  AiError,
  aiErrorBody,
  callChat,
  endpointOf,
  assertSafeBase,
  readConfig,
} from "@/lib/ai";
import { geocode, searchPois } from "@/lib/amap";

/**
 * 配置体检接口。
 * 目的不是"能用/不能用"，而是把**上游原始原因**摊开给用户看：
 * 到底是 Key 错了、余额空了、模型名不对，还是地址填错了。
 */

export async function GET() {
  return NextResponse.json(
    {
      hasServerKey: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
      hasAmapKey: Boolean(process.env.AMAP_WEB_KEY?.trim()),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

function localChecks(key: string): string[] {
  const warnings: string[] = [];
  if (/[\s\u3000]/.test(key)) {
    warnings.push("Key 里含有空格或换行，真实 Key 不会包含空白字符");
  }
  if (/[^\x20-\x7E]/.test(key)) {
    warnings.push("Key 里含有中文标点或全角字符，多半是复制时带进来的");
  }
  if (/^Bearer\s/i.test(key)) {
    warnings.push("Key 里带了「Bearer 」前缀，只需要填 sk- 开头那一串");
  }
  if (/^["'`]|["'`]$/.test(key)) {
    warnings.push("Key 首尾带有引号，请去掉");
  }
  if (!/^sk-/i.test(key)) {
    warnings.push("Key 不以 sk- 开头，请确认填的是 AI 平台的 Key，而不是高德等其他平台的");
  }
  if (key.length < 20) {
    warnings.push(`Key 长度只有 ${key.length} 位，看起来没有复制完整`);
  }
  return warnings;
}

function hintFor(e: AiError): string {
  switch (e.code) {
    case "AUTH":
      return "服务端明确拒绝了这把 Key。到 platform.deepseek.com 的「API keys」页面重新生成一个再填，注意复制完整、不要带空格。";
    case "BALANCE":
      return "Key 本身有效，但账户余额为 0。充值后即可调用。";
    case "MODEL":
      return "Key 有效但模型名不对。DeepSeek 当前可用模型只有 deepseek-flash 和 deepseek-v4-pro。";
    case "BAD_BASE_URL":
      return "接口地址填错了。DeepSeek 填 https://api.deepseek.com 即可，不用加 /v1 或 /chat/completions。";
    case "RATE":
      return "触发了并发或频率限制，等几十秒再试。";
    case "TIMEOUT":
      return "请求超时。可能是网络问题，或接口地址指向了访问不了的服务器。";
    case "NO_KEY":
      return "还没填 Key。";
    default:
      return "把下面的原始返回发给我，我按它来判断。";
  }
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", error: "请求体不是合法 JSON" },
      { status: 400 }
    );
  }

  const config = readConfig(body.config);

  if (body.probe === "amap") {
    const amapKey = String(
      (String(body.amapKey ?? "").trim() || process.env.AMAP_WEB_KEY || "")
    ).trim();
    if (!amapKey) {
      return NextResponse.json(
        {
          ok: false,
          code: "NO_AMAP_KEY",
          error: "还没有填写高德 Key",
          hint: "到 console.amap.com 创建「Web 服务」类型的 Key，不是 JS API 那个。",
          warnings: [],
          detail: null,
        },
        { status: 400 }
      );
    }
    const startedAt = Date.now();
    try {
      // 探测点不预设任何具体地点：先把城市名解析成坐标，再由它向外搜
      const center = await geocode(amapKey, "杭州", "杭州");
      const { pois, mode } = await searchPois(amapKey, {
        keywords: ["咖啡馆"],
        origin: center ?? { lat: 30.2741, lng: 120.1551 },
        radius: 3000,
        perKeyword: 3,
      });
      return NextResponse.json({
        ok: true,
        count: pois.length,
        mode,
        latencyMs: Date.now() - startedAt,
        sample: pois[0]?.name ?? "",
        hint:
          pois.length > 0
            ? "高德 Key 可用，能检索到真实商户。"
            : "Key 有效，但这一带没搜到结果，换个位置再试。",
        warnings: [],
        detail: null,
      });
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          code: "AMAP",
          error: e instanceof Error ? e.message : "高德接口调用失败",
          hint: "确认 Key 的类型是「Web 服务」，并检查是否设置了域名白名单。",
          warnings: [],
          detail: null,
        },
        { status: 400 }
      );
    }
  }

  if (!config.key) {
    return NextResponse.json(
      {
        ok: false,
        code: "NO_KEY",
        error: "还没有填写 API Key",
        hint: "在下面的输入框里填入平台生成的 Key，格式形如 sk-xxxxxxxx",
        warnings: [],
        detail: null,
      },
      { status: 400 }
    );
  }

  const warnings = localChecks(config.key);

  let endpoint = "";
  try {
    endpoint = endpointOf(assertSafeBase(config.baseUrl)).toString();
  } catch {
    endpoint = config.baseUrl;
  }

  const started = Date.now();

  try {
    const { text, model } = await callChat(
      config,
      [{ role: "user", content: "回复两个字：可用" }],
      { maxTokens: 32, thinking: false, timeoutMs: 30_000 }
    );

    return NextResponse.json({
      ok: true,
      model,
      endpoint,
      latencyMs: Date.now() - started,
      sample: text.trim().slice(0, 40),
      warnings,
      hint: warnings.length
        ? "能连上，但上面的警告建议一并处理，避免以后偶发失败。"
        : "Key 有效，模型可正常返回内容。",
    });
  } catch (e) {
    const { status, body: errBody } = aiErrorBody(e);
    return NextResponse.json(
      {
        ...errBody,
        endpoint,
        latencyMs: Date.now() - started,
        warnings,
        hint: e instanceof AiError ? hintFor(e) : "服务端异常，稍后重试。",
      },
      { status }
    );
  }
}
