import { NextResponse } from "next/server";
import { aiErrorBody, readConfig } from "@/lib/ai";
import type { PlanResult } from "@/lib/meetmate";
import { PlannerError, reroutePlan, type MemberOverride } from "@/lib/planner";

/**
 * 改成员位置时走这条路：不重新读群聊、不重新定关键词，
 * 但会按新位置重新检索候选池，再重算每人路程（含地铁）、重新排序推荐。
 * 只重算、不重读，几秒内出结果。
 */
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
      { ok: false, code: "NO_KEY", error: "还没有配置 AI Key" },
      { status: 400 }
    );
  }

  const amapKey = String(
    (String(body.amapKey ?? "").trim() || process.env.AMAP_WEB_KEY || "")
  ).trim();
  if (!amapKey) {
    return NextResponse.json(
      { ok: false, code: "NO_AMAP_KEY", error: "缺少高德 Web 服务 Key" },
      { status: 400 }
    );
  }

  const plan = body.plan as PlanResult | null;
  if (!plan || !Array.isArray(plan.candidates) || !Array.isArray(plan.members)) {
    return NextResponse.json(
      {
        ok: false,
        code: "BAD_PLAN",
        error: "缺少上一版方案，无法重算",
        detail: "刷新页面重新生成一次方案即可",
      },
      { status: 400 }
    );
  }

  const memberOverrides: MemberOverride[] = Array.isArray(body.memberOverrides)
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
          (o) => o.name && Number.isFinite(o.lat) && Number.isFinite(o.lng)
        )
        .slice(0, 8)
    : [];

  try {
    const next = await reroutePlan({
      plan,
      memberOverrides,
      config,
      amapKey,
      city: typeof body.city === "string" ? body.city : undefined,
    });
    return NextResponse.json({ ok: true, plan: next });
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
