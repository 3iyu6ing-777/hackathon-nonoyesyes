import { NextResponse } from "next/server";
import { headers } from "next/headers";

/**
 * 部署自检：只回答「服务端有没有读到该有的配置」，不回显任何 Key。
 * 线上点不动的时候，先打开 /api/health 看一眼，比猜快。
 */
export async function GET() {
  // 读一次请求头，强制这个路由走动态渲染：否则会被预渲染成构建时的快照，
  // 线上配好 Key 之后它还一直显示 false（cacheComponents 下 `dynamic` 配置不可用）
  await headers();

  const aiKey = String(process.env.DEEPSEEK_API_KEY ?? "").trim();
  const amapKey = String(process.env.AMAP_WEB_KEY ?? "").trim();

  return NextResponse.json({
    ok: Boolean(aiKey && amapKey),
    hasAIKey: Boolean(aiKey),
    hasAmapKey: Boolean(amapKey),
    keyLengths: { ai: aiKey.length, amap: amapKey.length },
    node: process.version,
    // 函数运行时拿不到 NETLIFY，但一定有 CONTEXT / AWS_LAMBDA_FUNCTION_NAME
    env:
      process.env.CONTEXT ||
      process.env.NETLIFY ||
      process.env.AWS_LAMBDA_FUNCTION_NAME
        ? "netlify"
        : process.env.VERCEL
          ? "vercel"
          : "local",
    // 单次规划的时间预算：线上按 8 秒算，到点就不再补地铁查询
    budgetMs: Number(process.env.MEETMATE_BUDGET_MS ?? "") || 14000,
    // 只报变量名，方便发现「名字写错了」（比如配成 AMAP_KEY）——不回显任何值
    keyVars: Object.keys(process.env)
      .filter((k) => /AMAP|DEEPSEEK|API_KEY|OPENAI/i.test(k))
      .sort(),
    commit:
      process.env.COMMIT_REF?.slice(0, 7) ??
      process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
      null,
    hint: !aiKey
      ? "缺少 DEEPSEEK_API_KEY：在 Netlify 环境变量里配置并重新 deploy"
      : !amapKey
        ? "缺少 AMAP_WEB_KEY：类型必须是「Web 服务」Key，配置后重新 deploy"
        : "服务端配置齐全",
  });
}
