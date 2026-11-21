import { NextResponse } from "next/server";
import { aiErrorBody, readConfig } from "@/lib/ai";
import type { ActivityId, Origin } from "@/lib/meetmate";
import { buildPlan, PlannerError } from "@/lib/planner";

const ACT_IDS = [
  "hiking",
  "food",
  "boardgame",
  "cafe",
  "escape",
  "sports",
  "shopping",
  "movie",
  "other",
];

/**
 * 用户自己的出发点，可选。
 * 没传或坐标不合法就返回 null —— 不再回退到任何预设校区，
 * 位置只能来自用户输入或群聊原话。
 */
function pickOrigin(raw: unknown): Origin | null {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const lat = Number(rec.lat);
  const lng = Number(rec.lng);
  const valid =
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0);
  if (!valid) return null;
  return {
    name: String(rec.name ?? "我的位置").slice(0, 20) || "我的位置",
    lat,
    lng,
  };
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
  if (!config.key) {
    return NextResponse.json(
      {
        ok: false,
        code: "NO_KEY",
        error: "还没有配置 AI Key",
        detail:
          "点左下角齿轮填入你自己的 API Key；如果是线上部署，也可以在环境变量里配 DEEPSEEK_API_KEY 后重新 deploy",
      },
      { status: 400 }
    );
  }

  const amapKey = String(
    (String(body.amapKey ?? "").trim() || process.env.AMAP_WEB_KEY || "")
  ).trim();
  if (!amapKey) {
    return NextResponse.json(
      {
        ok: false,
        code: "NO_AMAP_KEY",
        error: "缺少高德 Web 服务 Key",
        detail:
          "在设置面板填入高德 Key，或在服务端配置环境变量 AMAP_WEB_KEY（类型选「Web 服务」，改完需重新 deploy）。没有它就无法拿到真实地点。",
      },
      { status: 400 }
    );
  }

  const rawAct = String(body.activityId ?? "").trim();
  const activityId = (ACT_IDS.includes(rawAct) ? rawAct : "food") as ActivityId;
  // 选「其他」时用户自己补的那句话，选填；没有就让 AI 从群聊里判断
  const customActivity =
    activityId === "other"
      ? String(body.customActivity ?? "").trim().slice(0, 30)
      : "";

  const memberOverrides = Array.isArray(body.memberOverrides)
    ? (body.memberOverrides as unknown[])
        .map((x) => {
          const r = (x ?? {}) as Record<string, unknown>;
          return {
            name: String(r.name ?? "").slice(0, 12),
            originName: String(r.originName ?? "").slice(0, 20),
            lat: Number(r.lat),
            lng: Number(r.lng),
          };
        })
        .filter(
          (o) =>
            o.name && Number.isFinite(o.lat) && Number.isFinite(o.lng)
        )
        .slice(0, 8)
    : [];

  try {
    const plan = await buildPlan({
      chat: String(body.chat ?? ""),
      defaultActivityId: activityId,
      customActivity,
      origin: pickOrigin(body.origin),
      config,
      amapKey,
      extraConstraints: Array.isArray(body.extraConstraints)
        ? body.extraConstraints.map((x) => String(x)).slice(0, 5)
        : [],
      city: typeof body.city === "string" ? body.city : undefined,
      memberOverrides,
    });

    return NextResponse.json({ ok: true, plan });
  } catch (e) {
    if (e instanceof PlannerError) {
      return NextResponse.json(
        { ok: false, code: e.code, error: e.message, detail: e.detail ?? null },
        { status: 400 }
      );
    }
    const { status, body: errBody } = aiErrorBody(e);
    return NextResponse.json(errBody, { status });
  }
}
