import { NextResponse } from "next/server";
import { aiErrorBody, callChat, parseJsonLoose, readConfig } from "@/lib/ai";
import type { ActivityId, PlanResult } from "@/lib/meetmate";
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
];

type Turn = { role: "user" | "assistant"; text: string };

function summaryOf(plan: PlanResult | null) {
  if (!plan) return "还没有方案。";
  const lines = [
    `活动：${plan.activityLabel}`,
    `条件：${plan.requirements.map((r) => `${r.label}=${r.value}`).join("；")}`,
    plan.hardConstraints.length
      ? `硬性条件：${plan.hardConstraints.join("；")}`
      : "硬性条件：无",
    `参与的人：${plan.members
      .map((m) => {
        const bits = [
          m.resolved ? `从${m.originName}出发` : "出发地未明",
          m.constraints.length ? `限制:${m.constraints.join("、")}` : "",
          m.wishes.length ? `期望:${m.wishes.join("、")}` : "",
        ].filter(Boolean);
        return `${m.name}(${bits.join("，")})`;
      })
      .join("；")}`,
    `人均预算：${plan.budget ? `${plan.budget} 元` : "未提"}；单程可接受：${
      plan.maxTravelMin ? `${plan.maxTravelMin} 分钟` : "未提"
    }`,
    plan.pick
      ? `当前推荐：${plan.pick.name}（${plan.pick.cost ? `人均 ${plan.pick.cost}` : "人均未知"}，评分 ${
          plan.pick.rating || "未知"
        }）`
      : "当前推荐：无",
  ];
  if (plan.pick?.perMember.length) {
    lines.push(
      `各人怎么去：${plan.pick.perMember
        .map(
          (l) =>
            `${l.name} ${
              l.durationS == null ? "未知" : Math.round(l.durationS / 60) + " 分钟"
            }${l.detail ? `（${l.detail}）` : ""}`
        )
        .join("，")}`
    );
  }
  if (plan.needs?.length) {
    lines.push(
      `逐条要求（谁/方面/强度/方向/内容）：${plan.needs
        .map(
          (n) =>
            `${n.who || "全体"}/${n.category}/${n.strength}/${
              n.polarity === "avoid" ? "不要" : "想要"
            }:${n.text}`
        )
        .join("；")}`
    );
  }
  if (plan.pick?.checks?.length) {
    const bad = plan.pick.checks.filter((c) => c.verdict !== "pass");
    if (bad.length) {
      lines.push(
        `当前推荐没满足或判断不了的：${bad
          .map(
            (c) =>
              `${c.who || "全体"}「${c.text}」=${c.verdict === "conflict" ? "违背" : "待确认"}`
          )
          .join("；")}`
      );
    }
  }
  const others = (plan.ranking ?? [])
    .filter((r) => r.id !== plan.pick?.id)
    .slice(0, 3)
    .map(
      (r) =>
        `${r.name}(综合 ${r.score} 分，最远 ${r.worstMin ?? "?"} 分钟，人均 ${
          r.perCapita ?? "?"
        })`
    )
    .join("、");
  if (others) lines.push(`榜单后面：${others}`);
  return lines.join("\n");
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
        detail: "点左下角齿轮填入你自己的 API Key 后再试",
      },
      { status: 400 }
    );
  }

  const message = String(body.message ?? "").trim().slice(0, 500);
  if (!message) {
    return NextResponse.json(
      { ok: false, code: "EMPTY", error: "消息为空" },
      { status: 400 }
    );
  }

  const plan = (body.plan ?? null) as PlanResult | null;
  const history = Array.isArray(body.history)
    ? (body.history as Turn[])
        .filter((t) => t && typeof t.text === "string")
        .slice(-8)
    : [];

  const system = `你是 MeetMate 的组局助理。用户正在看一份已经算好的聚会方案，现在提出新的要求。

只输出 JSON，不要任何解释文字：
{"reply":"给用户看的中文回复","needReplan":true,"wantDifferent":false,"addedConstraints":["人均降到50"]}

规则：
1. reply 直接回应他的要求，60 字以内，口语一点，不要复述条件清单，不要列 1234。
2. needReplan：如果新要求会改变「去哪」或「搜什么」，返回 true；如果只是确认、闲聊、表达情绪，返回 false。
3. wantDifferent：用户明确表示不想去现在这家、想换一家时返回 true（例如"换一家""这家不行""太远了换一个""不想去这里"）；只是补充条件时为 false。
4. addedConstraints：需要并入方案的硬性条件，一条一句，最多 3 条；不需要就空数组。
5. 不要把用户没说过的话塞进 addedConstraints。
6. 严格输出 JSON。`;

  const historyBlock = history.length
    ? `\n\n之前聊过：\n${history
        .map((t) => `${t.role === "user" ? "用户" : "你"}：${t.text}`)
        .join("\n")}`
    : "";

  const user = `当前方案：\n${summaryOf(plan)}${historyBlock}\n\n用户刚说：${message}`;

  try {
    const { text } = await callChat(
      config,
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { json: true, thinking: false, maxTokens: 700 }
    );

    const parsed = parseJsonLoose(text);
    const reply =
      String(parsed?.reply ?? "").trim() ||
      "收到，我先按原方案保留，你说想调整哪一块我再改。";
    const needReplan = parsed?.needReplan === true;
    const wantDifferent = parsed?.wantDifferent === true;
    const addedConstraints = Array.isArray(parsed?.addedConstraints)
      ? (parsed.addedConstraints as unknown[])
          .map((x) => String(x).trim())
          .filter(Boolean)
          .slice(0, 3)
      : [];

    if (!needReplan) {
      return NextResponse.json({ ok: true, reply, replanned: false });
    }

    const amapKey = String(
      body.amapKey ?? process.env.AMAP_WEB_KEY ?? ""
    ).trim();
    if (!amapKey) {
      return NextResponse.json({ ok: true, reply, replanned: false });
    }

    const rawAct = String(body.activityId ?? plan?.activityId ?? "food").trim();
    const activityId = (ACT_IDS.includes(rawAct) ? rawAct : "food") as ActivityId;
    const rawOrigin = (body.origin ?? {}) as Record<string, unknown>;
    const oLat = Number(rawOrigin.lat);
    const oLng = Number(rawOrigin.lng);
    // 用户自己的出发点可选；不合法就是 null，不落回任何预设地点
    const origin =
      Number.isFinite(oLat) &&
      Number.isFinite(oLng) &&
      Math.abs(oLat) <= 90 &&
      Math.abs(oLng) <= 180 &&
      !(oLat === 0 && oLng === 0)
        ? {
            name: String(rawOrigin.name ?? "我的位置").slice(0, 20) || "我的位置",
            lat: oLat,
            lng: oLng,
          }
        : null;

    const chat = String(body.chat ?? "").trim();

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
            (o) => o.name && Number.isFinite(o.lat) && Number.isFinite(o.lng)
          )
          .slice(0, 8)
      : [];

    const next = await buildPlan({
      chat,
      defaultActivityId: activityId,
      origin,
      config,
      amapKey,
      memberOverrides,
      extraConstraints: [
        ...(Array.isArray(body.previousConstraints)
          ? (body.previousConstraints as unknown[]).map((x) => String(x))
          : []),
        ...addedConstraints,
        message,
      ].slice(-6),
      city: typeof body.city === "string" ? body.city : undefined,
      previousPickName: plan?.pick?.name ?? null,
      avoidPickId: wantDifferent ? plan?.pick?.id ?? null : null,
    });

    return NextResponse.json({ ok: true, reply, replanned: true, plan: next });
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
