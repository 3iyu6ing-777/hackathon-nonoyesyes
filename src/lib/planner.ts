import type { ApiConfig } from "./api-key";
import { callChat, parseJsonLoose } from "./ai";
import {
  geocode,
  haversineM,
  measureDistance,
  planRoute,
  planTransit,
  searchPois,
  taxiFare,
  TIME_VALUE_PER_MIN,
  type AmapPoi,
  type TransitResult,
} from "./amap";
import { locatePlace } from "./place";
import {
  ACTIVITIES,
  type ActivityId,
  type CandidateScore,
  memberColor,
  type Member,
  type MemberLeg,
  type MemberPressure,
  type MemberRoute,
  type Need,
  type NeedCategory,
  type NeedCheck,
  type NeedCheckability,
  NEED_CATEGORIES,
  type NeedStrength,
  type NeedVerdict,
  type Origin,
  type PlanResult,
  REQUIREMENT_LABELS,
  type Requirement,
  TRAVEL_LABEL,
  type TravelOption,
} from "./meetmate";

/**
 * 实时规划器（多人 · 含地铁版）。
 *
 *   1) AI 读群聊 → 全体条件 + 每个人的说法 + 预算/可接受通勤时长
 *   2) 成员位置落点：AI 读到的出发地 + 从原话确定性抓取的出发地，都交给高德地理编码
 *      —— 不再有任何内置的校区坐标表，读不到就老实标「位置待确认」
 *   3) 以「成员几何中心 + 离中心最远的那位」各搜一遍真实商户
 *      —— 只搜一个人附近，另一头的人就会被忽略，这也是以前换位置不换池子的根因
 *   4) 每人每条候选算两种走法：打车 / 公交地铁，按「时间折钱 + 车费」择优
 *   5) 用确定性公式打分排序（最远通勤、均衡度、预算、评分），AI 只在头部挑选并写理由
 */

export class PlannerError extends Error {
  code: string;
  detail?: string;

  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = "PlannerError";
    this.code = code;
    this.detail = detail;
  }
}

const MAX_CHAT = 12_000;
const MAX_MEMBERS = 6;
/** 最多拿多少个候选去测路程 */
const MAX_MEASURED = 10;
/** 前几名再补一次地铁/公交查询（这个接口只能单人单目的地，费配额） */
const PRELIM_FOR_TRANSIT = 10;
/** 单次规划最多发多少个公交查询，防止一个请求打爆配额（人均一条即可，留点余量） */
const MAX_TRANSIT_PER_MEMBER = 12;

/**
 * 单次规划的「软截止」。
 * 国内直连高德是几百毫秒，海外节点（Netlify 走美东）单次就要 2-3 秒，
 * 实测一次完整规划在线上约 12-16 秒。到点就先不再补地铁，剩下的候选退回打车估算，
 * 宁可精度降一点，也别整个请求被平台掐断。
 * 本地默认不限（预算 0），需要的话用 MEETMATE_BUDGET_MS 手动指定。
 */
function planBudgetMs(): number {
  const raw = Number(process.env.MEETMATE_BUDGET_MS ?? "");
  if (Number.isFinite(raw) && raw > 0) return raw;
  // 注意：NETLIFY 只在构建阶段有值，函数运行时是空的；
  // 函数里能认出 Netlify 的是 CONTEXT / AWS_LAMBDA_FUNCTION_NAME 这些。
  const onNetlify = Boolean(
    process.env.CONTEXT ||
      process.env.NETLIFY ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.LAMBDA_TASK_ROOT
  );
  // 实测线上：预算 8 秒时 14.7 秒返回（地铁没来得及补），预算 18 秒会顶到
  // 平台 ~26 秒上限直接 504。14 秒是「能补一部分地铁、又留足收尾」的位置。
  return onNetlify ? 14000 : 0;
}
/** 步行可达距离，超过就没必要比打车了 */
const WALK_LIMIT_M = 1800;
const ACT_IDS = ACTIVITIES.map((a) => a.id);

/** 仅当 AI 没给出关键词时的兜底检索词，只影响「搜什么」，不影响结论 */
const FALLBACK_KEYWORDS: Record<ActivityId, string[]> = {
  hiking: ["公园"],
  food: ["餐厅"],
  boardgame: ["桌游"],
  cafe: ["咖啡馆"],
  escape: ["密室逃脱"],
  sports: ["体育馆"],
  shopping: ["商场"],
  movie: ["电影院"],
  other: ["聚会"],
};

function strList(v: unknown, max: number, len: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, max)
    .map((s) => s.slice(0, len));
}

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

/** 群聊里没写城市名时，用常见商圈/地标兜一下，避免把成都的局算到杭州去 */
const CITY_HINTS: { city: string; words: string[] }[] = [
  { city: "成都", words: ["成都", "春熙路", "太古里", "天府广场", "高新区", "华西", "武侯", "锦里", "宽窄巷子", "犀浦", "双流", "郫县", "龙泉驿", "建设路", "玉林"] },
  { city: "重庆", words: ["重庆", "解放碑", "观音桥", "洪崖洞", "沙坪坝", "渝中", "南坪", "大学城", "江北机场", "北碚"] },
  { city: "北京", words: ["北京", "国贸", "中关村", "望京", "五道口", "三里屯", "西单", "朝阳门", "回龙观", "亦庄"] },
  { city: "上海", words: ["上海", "陆家嘴", "静安寺", "徐家汇", "人民广场", "五角场", "张江", "虹桥", "七宝", "莘庄"] },
  { city: "深圳", words: ["深圳", "南山", "福田", "罗湖", "宝安", "龙华", "科技园", "车公庙", "海岸城"] },
  { city: "广州", words: ["广州", "天河", "珠江新城", "体育西", "越秀", "番禺", "客村", "岗顶"] },
  { city: "南京", words: ["南京", "新街口", "鼓楼", "河西", "仙林", "江宁", "夫子庙"] },
  { city: "武汉", words: ["武汉", "光谷", "江汉路", "街道口", "武昌", "汉阳", "楚河汉街"] },
  { city: "西安", words: ["西安", "钟楼", "大雁塔", "小寨", "高新", "曲江", "回民街"] },
  { city: "长沙", words: ["长沙", "五一广场", "黄兴路", "岳麓", "梅溪湖", "解放西"] },
  { city: "苏州", words: ["苏州", "观前街", "园区", "平江路", "石路", "独墅湖"] },
  { city: "杭州", words: ["杭州", "西湖", "滨江", "西溪", "三墩", "文三路", "钱江新城", "武林", "武林门", "城西", "下沙", "转塘", "古荡", "滨江区", "余杭", "萧山"] },
];

/** 只认「城市」这个量级：去掉省/市后缀，2-8 个字的中文地名 */
function sanitizeCity(v: unknown): string {
  const s = String(v ?? "")
    .trim()
    .replace(/[省市]$/g, "")
    .replace(/\s+/g, "");
  if (!/^[\u4e00-\u9fa5]{2,8}$/.test(s)) return "";
  return s;
}

/** AI 没给出城市时的确定性兜底：先看群聊里有没有直接点名，再看地标 */
function cityFromChat(chat: string): string {
  const scored = CITY_HINTS.map(({ city, words }) => {
    let score = 0;
    for (const w of words) {
      if (!chat.includes(w)) continue;
      // 直接写了城市名，权重远高于只提到商圈
      score += w === city ? 10 : 1;
    }
    return { city, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.city ?? "";
}

/** 剧本杀和密室在 AI 眼里经常互换；群聊原话里到底提的是哪个，以原话为准 */
function refineActivity(id: ActivityId, chat: string): ActivityId {
  const hasScript = /剧本杀|剧本|开本|欢乐本|情感本|推理本|硬核本/.test(chat);
  const hasEscape = /密室/.test(chat);
  if (hasScript && !hasEscape) return "boardgame";
  if (hasEscape && !hasScript) return "escape";
  return id;
}

function normalizeActivity(v: unknown, fallback: ActivityId): ActivityId {
  const s = String(v ?? "").trim();
  return (ACT_IDS as string[]).includes(s) ? (s as ActivityId) : fallback;
}

function sanitizeRequirements(v: unknown, activityLabel: string): Requirement[] {
  const out: Requirement[] = [];
  const seen = new Set<string>();
  if (Array.isArray(v)) {
    for (const item of v) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const label = String(rec.label ?? "").trim();
      const value = String(rec.value ?? "").trim();
      if (!(REQUIREMENT_LABELS as readonly string[]).includes(label)) continue;
      if (!value || seen.has(label)) continue;
      seen.add(label);
      out.push({ label, value: value.slice(0, 40) });
    }
  }
  if (!seen.has("活动")) out.unshift({ label: "活动", value: activityLabel });
  return out;
}

type RawMember = {
  name: string;
  originHint: string;
  /** AI 摘出来的原话，用来核对出发地是不是它自己说的 */
  originQuote: string;
};

/** 模型偶尔会把出发地写成别的字段名，这里都认 */
const ORIGIN_FIELDS = [
  "originHint",
  "origin",
  "from",
  "departure",
  "startFrom",
  "startPoint",
  "location",
];

function sanitizeMembers(v: unknown): RawMember[] {
  const out: RawMember[] = [];
  const seen = new Set<string>();
  if (Array.isArray(v)) {
    for (const item of v) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const name = String(rec.name ?? "").trim().slice(0, 12);
      if (!name || seen.has(name)) continue;
      seen.add(name);

      let hint = "";
      for (const f of ORIGIN_FIELDS) {
        const got = String(rec[f] ?? "").trim();
        if (got) {
          hint = got.slice(0, 30);
          break;
        }
      }

      out.push({
        name,
        originHint: hint,
        originQuote: String(rec.originQuote ?? "").trim().slice(0, 60),
      });
      if (out.length >= MAX_MEMBERS) break;
    }
  }
  return out;
}

/*
 * 出发地的确定性兜底抽取。
 *
 * 为什么需要它：AI 只要在成员表里漏填一次 originHint，整份方案就会退化成
 * 「所有人同一个位置」，而这件事从界面上看不出来。所以这里直接按行读原话，
 * 不经过模型，抓到就一定用得上（坐标仍由高德地理编码确认）。
 */

/** 表示「不是具体地点」的词，抓到也不要 */
const NOT_A_PLACE = new Set([
  "这",
  "那",
  "这儿",
  "这儿边",
  "这里",
  "那里",
  "这边",
  "那边",
  "这块",
  "那块",
  "附近",
  "周边",
  "一带",
  "家",
  "家里",
  "宿舍",
  "学校",
  "公司",
  "单位",
  "外面",
  "路上",
  "车上",
  "地铁",
  "公交",
  "加班",
  "上班",
  "下班",
  "开会",
  "吃饭",
  "睡觉",
  "上课",
  "实习",
  "出差",
  "医院",
  "健身房",
  "地铁站",
  "车站",
  "门口",
]);

/**
 * 按优先级排：越靠前的说法越明确，越不像「顺手提了一句」。
 * 一个人常常在一段话里提到好几个词（「我在公司加班，从文三路过去」），
 * 所以这里只负责**收集候选**，具体用哪个由后面的定位结果决定。
 */
const PLACE_PATTERNS = [
  /从\s*([^\s，,。.；;！!？?、的]{2,12}?)\s*(?:出发|过去|过来|走|赶|坐车|骑车|打车)/,
  // 「我住西溪那边」「我家在转塘」「搬到良渚」
  /(?:我|我们)?(?:住|住在|家在|搬到)\s*([^\s，,。.；;！!？?、的]{2,12})/,
  /(?:我|人|住|呆|待在)?在\s*([^\s，,。.；;！!？?、的]{2,12}?)\s*(?:这边|那边|附近|一带|实习|上班|上学|上课|出差)/,
  // 「文三路站下来」「在滨江站等」
  /(?:在|到|去)\s*([^\s，,。.；;！!？?、的]{2,10}?(?:站|地铁站))(?:下来|下车|附近|等)?/,
  /([^\s，,。.；;！!？?、的]{2,12}?)\s*(?:这边|那边)/,
  /([^\s，,。.；;！!？?、的]{2,12}?)\s*(?:附近|周边|一带)/,
  /(?:从|在)\s*([^\s，,。.；;！!？?、的]{2,12}?)\s*$/,
];

/**
 * 人说地名时后面常跟一串废话：「我在城西银泰等你们」「从古荡走的话」。
 * 这些尾巴必须切掉，否则整串会被当成地名拿去搜，搜不到人就白丢了。
 */
const NOISE_TAIL =
  /(?:等你们|等我们|等大家|等我|等一下|等|集合|碰头|会合|见|一起|的话|好了|就行|都可以|附近|那边|这边).*$/;

function cleanHint(raw: string): string {
  const s = raw
    .replace(/^(?:我|我们|本人)?(?:从|在|住|待在)?/, "")
    .replace(NOISE_TAIL, "")
    .replace(
      /(?:这边|那边|附近|周边|一带|出发|过去|过来|下车|下来|走|实习|上班|上学|上课|出差)$/g,
      ""
    )
    .replace(/\s/g, "")
    .trim();
  if (s.length < 2 || s.length > 12) return "";
  if (NOT_A_PLACE.has(s)) return "";
  // 「十几分钟」「半小时」「3号线」这类不是地点
  if (/\d|分钟|小时|地铁|公交|打车|几点/.test(s)) return "";
  return s;
}

/** 行首时间戳：[19:23] / 【19:23】 / (19:23) / 19:23 / 下午 7:23 / 19:23:45 */
const TIME_LEAD =
  /^[\[【(（]?\s*(?:上午|下午|晚上|中午|凌晨|早上)?\s*\d{1,2}[:：]\d{2}(?:[:：]\d{2})?\s*[\]】)）]?[\s]*/;
/** 行首日期（后面可以不带时间，也可以带）：2026-11-20 / 2026年11月20日 19:23:45 */
const DATE_LEAD =
  /^\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?(?:\s*(?:上午|下午|晚上|中午|凌晨|早上)?\s*\d{1,2}[:：]\d{2}(?:[:：]\d{2})?)?[\s]*/;

/**
 * 昵称统一：全角转半角、去 @、去「说/回复」尾巴、去括号后缀、去掉表情和符号。
 * 少了最后一步，微信昵称里的 emoji（「小A🌰」）会让这个人永远匹配不上 ——
 * 人就这么凭空消失了。
 */
function cleanName(raw: string) {
  return raw
    .normalize("NFKC")
    .replace(/[（(【\[].*?[)）】\]]/g, "")
    .replace(/^@/, "")
    .replace(/(?:说|说道|发言|回复|的消息)$/, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .slice(0, 12);
}

/** 一句话的开头不像人名：这些字一出现，多半是把半句话当成了发言人 */
const SENTENCE_HEAD =
  /[我你他她它们这那哪什么的了是吗呢吧啊呀哦嗯就都也还不没要想能会去来说有个]/;
/** 时间词更不可能是昵称：「今天下午」「这周六」 */
const TIME_WORD =
  /今天|明天|后天|昨天|前天|周末|周[一二三四五六日天]|上午|下午|晚上|中午|凌晨|早上|点|分钟/;

/** 像不像一个昵称。宁可漏，也别把半句话当成新成员 */
function looksLikeName(s: string) {
  const n = s.trim();
  if (n.length < 1 || n.length > 8) return false;
  if (/^\d+$/.test(n)) return false;
  return !SENTENCE_HEAD.test(n) && !TIME_WORD.test(n);
}

/**
 * 把群聊拆成「谁说了什么」。
 *
 * 这里以前栽过：`[19:23] 小A` 单独一行时，正则把 `[19` 当成发言人，
 * 于是这个人的所有话都被判给了不存在的人 —— 表现就是「有人压根没上图」。
 * 所以先用两种「名字+冒号」的正则，再按行首时间戳剥离后重试。
 */
export function chatLines(
  chat: string,
  known: string[] = []
): { who: string; body: string }[] {
  const out: { who: string; body: string }[] = [];
  const lines = chat.split(/\r?\n/);
  /** 给了成员名单时，宽松规则必须以名单为准，避免把半句话当成新成员 */
  const matchers = known.map((n) => nameMatcher(n));
  const looksKnown = (who: string) =>
    matchers.length === 0 || matchers.some((m) => m(who));

  const push = (who: string, body: string) => {
    const n = cleanName(who);
    if (n) out.push({ who: n, body: body ?? "" });
  };

  /** 下一行若只有时间，就再往下取一行 */
  const bodyAfter = (i: number) => {
    const next = (lines[i + 1] ?? "").trim();
    if (!next) return "";
    const rest = next.replace(DATE_LEAD, "").replace(TIME_LEAD, "").trim();
    return rest || (lines[i + 2] ?? "");
  };

  /** 上一行是「只有时间」的那种行，这一行就是发言人 */
  let expectName = false;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].replace(/\u00a0/g, " ").trimEnd();
    if (!raw.trim()) continue;

    // 行首日期/时间戳必须先剥掉。否则 `[19:23] 小A` 里 `19` 会被当成名字，
    // 这个人的话就整段归到一个不存在的人头上 —— 人自然就「没显示」了。
    const target = raw.replace(DATE_LEAD, "").replace(TIME_LEAD, "").trim();
    const hadLead = target !== raw.trim();

    // 0. 整行只有时间：下一行是「谁说的」，再下一行才是内容
    if (hadLead && !target) {
      expectName = true;
      continue;
    }

    // A. 「小A：内容」「小A(19:23)：内容」「小A 说：内容」
    const a = target.match(
      /^\s*([^\s:：]{1,12})\s*(?:[\[【(（]\s*\d{1,2}[:：]\d{2}(?:[:：]\d{2})?\s*[\]】)）])?\s*(?:说|说道|发言)?\s*[：:]\s*(.*)$/
    );
    if (a) {
      const body = (a[2] ?? "").trim() || bodyAfter(i);
      push(a[1], body);
      expectName = false;
      continue;
    }

    // B. 剥掉时间后只剩名字：「[19:23] 小A」「19:23 小A」，内容在下一行
    const onlyName = target.match(/^([^\s:：，,。.!！?？]{1,12})$/);
    if (onlyName && (hadLead || expectName) && looksLikeName(onlyName[1])) {
      push(onlyName[1], bodyAfter(i));
      expectName = false;
      continue;
    }
    expectName = false;

    // C. 名字 + 行内时间，内容在下一行：「小A 19:23」「小A(19:23)」
    const b = target.match(
      /^\s*([^\s:：]{1,12})\s*(?:[\[【(（]\s*)?\d{1,2}[:：]\d{2}(?:[:：]\d{2})?\s*[\]】)）]?\s*$/
    );
    if (b) {
      push(b[1], bodyAfter(i));
      continue;
    }

    // D. 微信里常见的「@小A 我住西溪那边」
    const at = target.match(/^\s*@\s*([^\s:：]{1,12})\s+(.*)$/);
    if (at) {
      push(at[1], at[2]);
      continue;
    }

    // E. 手打格式「小A 我住西溪那边」。
    // 必须挡住「我从三墩出发 大概半小时」这种：前半段像半句话就不算名字，
    // 否则会把一句普通的话当成新发言人，真正的地名反而丢了。
    const e = target.match(/^([^\s:：]{1,8})\s+(\S.{2,})$/);
    if (e && looksLikeName(e[1]) && looksKnown(e[1])) {
      push(e[1], e[2]);
    }
  }
  return out;
}

/** 昵称对得上即可，容忍「小A（发起人）」这类后缀与个别错字 */
function nameMatcher(name: string) {
  const target = cleanName(name);
  const aliases = [target, name.normalize("NFKC").replace(/\s/g, "")].filter(
    Boolean
  );
  return (raw: string) => {
    const who = cleanName(raw);
    if (!who) return false;
    return aliases.some(
      (t) =>
        who === t ||
        (Math.abs(who.length - t.length) <= 2 &&
          (who.endsWith(t) || t.endsWith(who)))
    );
  };
}

/**
 * 从群聊原话里找某个人的出发地。
 *
 * 返回**一串候选**（按可信度排序），而不是一个：一个人一段话里可能出现
 * 「公司」「文三路」「这边」好几个词，挑哪个取决于谁能被高德真正定位。
 * 只看这个人自己说的那几行，不会拿别人的话凑。
 */
export function hintFromChat(
  chat: string,
  name: string,
  others: string[] = []
): { hint: string; hints: string[]; quote: string } {
  if (!name.trim()) return { hint: "", hints: [], quote: "" };
  const same = nameMatcher(name);
  const mine = cleanName(name);
  const found: { hint: string; quote: string }[] = [];

  // 「阿May」和「May」都能匹配同一句话时，只归名字更贴合的那个，
  // 否则两个人会拿到同一个坐标 —— 地图上看着就像「地点显示错了」。
  const rivals = others
    .map((o) => ({ name: cleanName(o), match: nameMatcher(o) }))
    .filter((r) => r.name && r.name !== mine);
  const claimedByRival = (who: string) => {
    // 和我同名的那句话一定是我的
    if (who === mine) return false;
    for (const r of rivals) {
      if (!r.match(who)) continue;
      // 对方精确命中这个词，或者名字更长更贴合，就归对方
      if (r.name === who || r.name.length > mine.length) return true;
    }
    return false;
  };

  for (const { who, body } of chatLines(chat)) {
    if (!same(who)) continue;
    if (claimedByRival(who)) continue;
    for (const re of PLACE_PATTERNS) {
      const re2 = new RegExp(
        re.source,
        re.flags.includes("g") ? re.flags : `${re.flags}g`
      );
      for (const hit of body.matchAll(re2)) {
        const hint = cleanHint(hit[1] ?? "");
        if (!hint) continue;
        if (found.some((f) => f.hint === hint)) continue;
        // 原话必须是**真正说出这个地点的那一句**，不能是这个人随便说的第一句
        found.push({ hint, quote: body.trim().slice(0, 60) });
        if (found.length >= 6) break;
      }
      if (found.length >= 6) break;
    }
    if (found.length >= 6) break;
  }

  return {
    hint: found[0]?.hint ?? "",
    hints: found.map((f) => f.hint),
    quote: found[0]?.quote ?? "",
  };
}

/** 这些「昵称」不是人 */
const NOT_PEOPLE = new Set(["群聊", "系统", "我", "大家", "所有人", "全员"]);

/**
 * AI 偶尔会漏人。这里把「原话里说过出发地、但不在成员表里」的人补进来，
 * 否则他们说过的位置就白说了。
 */
export function missingSpeakers(
  chat: string,
  known: string[]
): { name: string; quote: string }[] {
  const matchers = known.map((k) => nameMatcher(k));
  const out: { name: string; quote: string }[] = [];
  const seen = new Set<string>();
  for (const { who } of chatLines(chat)) {
    if (!who || who.length > 8) continue;
    // 半句话被当成「人」时，会多出一个不存在、也定位不到的成员
    if (!looksLikeName(who)) continue;
    if (NOT_PEOPLE.has(who)) continue;
    // 名字对得上就算同一个人：「小A」和「小A（发起人）」不能补成两个
    if (matchers.some((m) => m(who))) continue;
    if (seen.has(who)) continue;
    seen.add(who);
    const hit = hintFromChat(chat, who);
    if (hit.hint) out.push({ name: who, quote: hit.quote });
  }
  return out;
}

const STRENGTHS: NeedStrength[] = ["hard", "strong", "soft"];

/** 要求强度的权重。硬性一条顶得上三条「随便说说」 */
function strengthWeight(s: NeedStrength) {
  return s === "hard" ? 1 : s === "strong" ? 0.65 : 0.3;
}

function normCategory(v: unknown): NeedCategory {
  const s = String(v ?? "").trim();
  return (NEED_CATEGORIES as readonly string[]).includes(s)
    ? (s as NeedCategory)
    : "其他";
}

function normStrength(v: unknown): NeedStrength {
  const s = String(v ?? "").trim() as NeedStrength;
  return STRENGTHS.includes(s) ? s : "strong";
}

/** 「半小时」「一小时」「80 元以内」这类说法折成数字，折不出来就返回 null */
/**
 * 从「晚上 7 点前要回家」「19:00 前得走」里读出当天的时间点（分钟数）。
 * 只认「点 / :」这种明确说法，读不到就返回 null，不要瞎猜。
 */
function deadlineOf(text: string): number | null {
  const s = text.replace(/[：]/g, ":");
  const pm = /下午|晚上|傍晚|夜/.test(s);
  const hit =
    s.match(/(\d{1,2})\s*[:点]\s*(\d{1,2})?\s*分?/) ?? null;
  if (hit) {
    let h = Number(hit[1]);
    const m = hit[2] ? Number(hit[2]) : 0;
    if (!Number.isFinite(h) || h < 0 || h > 24) return null;
    if (pm && h < 12) h += 12;
    return h * 60 + m;
  }
  return null;
}

function numericValue(text: string, quote: string, category: NeedCategory) {
  const s = `${text} ${quote}`;
  if (category === "预算") {
    const m = s.match(/(\d{2,4})\s*(?:元|块|以内|以下|左右|封顶)?/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (category === "时间" || category === "距离" || category === "交通") {
    const h = s.match(/(\d+(?:\.\d+)?)\s*(?:个)?小时/);
    if (h) return Math.round(Number(h[1]) * 60);
    if (/半小时/.test(s)) return 30;
    if (/一个多小时|一小时多/.test(s)) return 90;
    const m = s.match(/(\d{1,3})\s*(?:分钟|分)/);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * 用户后来追加的要求，凡是带「降 / 最多 / 以内」这种收紧语气的预算或时长，
 * 直接在代码里落到 budget / maxTravelMin 上，不指望 AI 一定写进 needs。
 * 现实是它更常写进 hardConstraints，而那份清单只出现在选点提示词里、
 * 不参与打分 —— 于是「把预算降到 50」说完，榜单纹丝不动。
 */
const TIGHTEN_WORDS = /降|压|减|控制|改成|改到|最多|不超过|别超|以内|以下|便宜|省|近点|近一点/;
const BUDGET_WORDS = /人均|每位|每人|预算|花销|花费|消费|价格|价位|贵/;

function tightenNumber(t: string, kind: "budget" | "travel") {
  const unit = kind === "budget" ? "(?:元|块|块钱)?" : "(?:分钟|分|min)?";
  // 数字跟在「最多 / 不超过 / 降到」后面
  const lead = [
    ...t.matchAll(
      new RegExp(
        `(?:不超过|别超过|别超|最多|降到|压到|减到|控制在|改成|改到|只要)\\s*(\\d{1,4})\\s*${unit}`,
        "g"
      )
    ),
  ];
  if (lead.length) return Math.min(...lead.map((m) => Number(m[1])));
  // 数字在前，「以内 / 以下 / 封顶」
  const tail = [
    ...t.matchAll(new RegExp(`(\\d{1,4})\\s*${unit}\\s*(?:以内|以下|封顶)`, "g")),
  ];
  if (tail.length) return Math.min(...tail.map((m) => Number(m[1])));
  return numericValue(t, "", kind === "budget" ? "预算" : "交通");
}

const CLAUSE_SPLIT = /[，,。；;、\n]/;

function parseTighten(texts: string[]): {
  budget: number | null;
  maxTravelMin: number | null;
  /** 触发收紧的那句原话，用来替换 needs 里的 quote */
  budgetText: string | null;
  travelText: string | null;
  notes: string[];
} {
  let budget: number | null = null;
  let maxTravelMin: number | null = null;
  let budgetText: string | null = null;
  let travelText: string | null = null;
  for (const raw of texts) {
    const t = String(raw ?? "").trim().slice(0, 80);
    if (!t) continue;
    // 「人均降到50，路上别超过40分钟」这种一句话两个约束，必须按子句拆开算，
    // 否则会拿第一个数字（50）去当通勤时长。
    for (const clause of t.split(CLAUSE_SPLIT)) {
      const c = clause.trim();
      if (!c || !TIGHTEN_WORDS.test(c)) continue;

      const looksTravel = /分钟|min|小时/i.test(c);
      const looksBudget =
        BUDGET_WORDS.test(c) ||
        (/以内|以下|封顶/.test(c) &&
          !/(人|个|公里|km|米|分钟|小时)/i.test(c));

      if (looksBudget && !looksTravel) {
        const n = tightenNumber(c, "budget");
        if (n != null && n >= 10 && n <= 2000) {
          if (budget == null || n < budget) {
            budget = n;
            budgetText = c;
          }
        }
      }
      // 「别超过 30 分钟」这种不带「车程」二字的说法很常见，只要有分钟数就按通勤收
      if (looksTravel) {
        const n = tightenNumber(c, "travel");
        if (n != null && n >= 3 && n <= 180) {
          if (maxTravelMin == null || n < maxTravelMin) {
            maxTravelMin = n;
            travelText = c;
          }
        }
      }
    }
  }
  const notes: string[] = [];
  if (budget != null) notes.push(`人均不超过 ${budget} 元`);
  if (maxTravelMin != null) notes.push(`单程不超过 ${maxTravelMin} 分钟`);
  return { budget, maxTravelMin, budgetText, travelText, notes };
}

/**
 * 「小B 40 分钟那事可以放宽到 60」「人均放宽到 80 就行」。
 * 收紧有人做，放宽没人做的话，用户只能干看着一条不现实的硬线把方案锁死。
 */
const RELAX_WORDS = /放宽|放松|可以到|能接受|提高到|加到|不介意/;

function parseRelax(texts: string[]): {
  budget: number | null;
  travel: number | null;
  who: string;
} {
  let budget: number | null = null;
  let travel: number | null = null;
  let who = "";
  for (const raw of texts) {
    const t = String(raw ?? "").trim().slice(0, 60);
    if (!t || !RELAX_WORDS.test(t)) continue;
    // 点名放宽谁的就只动谁；没点名就当成全体
    const named = t.match(/^\s*([^\s，,。]{1,6})\s*(?:说|的话|那边|的)?/);
    const isTravel = /分钟|min|小时/i.test(t);
    // 「放宽到 70」里的 70 才是新的上限，别让前面的旧数字（40）抢了先
    const after = t.match(
      /(?:放宽|放松|可以到|能接受|提高到|加到|不介意)[^\d]{0,8}(\d{1,4})/
    );
    const n = after
      ? Number(after[1])
      : isTravel
        ? tightenNumber(t, "travel")
        : tightenNumber(t, "budget");
    if (n == null) continue;
    if (isTravel && n >= 5 && n <= 180) travel = Math.max(travel ?? 0, n);
    else if (!isTravel && n >= 10 && n <= 2000) budget = Math.max(budget ?? 0, n);
    if (named && membersMaybe(named[1])) who = named[1];
  }
  return { budget, travel, who };
}

/** 名字长得像人名才当归属，避免把「人均」当成谁的名字 */
function membersMaybe(w: string) {
  return /^[\u4e00-\u9fa5A-Za-z]{1,4}$/.test(w) && !/人均|预算|路上|时间|大家|全体/.test(w);
}

/**
 * 哪些要求能直接用高德字段验证。
 * 只有三类：预算（人均）、通勤（耗时）、场所类型（室内外 / 爬山 / 密室…）。
 * 其余（辣不辣、吵不吵、好不好拍照）商户数据里根本没有，只能交 AI 判断或标「判断不了」。
 */
const TYPE_HINTS: { test: RegExp; any: string[] }[] = [
  { test: /爬山|登山|徒步|山里|露营/, any: ["登山", "山", "公园", "风景", "景点", "露营地"] },
  { test: /密室/, any: ["密室"] },
  { test: /剧本杀|剧本|推理馆/, any: ["剧本", "推理"] },
  { test: /桌游|棋牌/, any: ["桌游", "棋牌"] },
  { test: /火锅/, any: ["火锅"] },
  { test: /烧烤|烤肉/, any: ["烧烤", "烤肉"] },
  { test: /咖啡|书店/, any: ["咖啡", "书店", "书吧"] },
  { test: /电影|观影|演出|livehouse/i, any: ["电影", "影", "剧场", "演出"] },
  { test: /ktv|唱歌/i, any: ["KTV", "歌"] },
  { test: /酒吧|酒馆/, any: ["酒吧", "酒馆"] },
  { test: /商场|逛街|购物/, any: ["商场", "购物", "购物中心", "商业街"] },
  { test: /羽毛球|篮球|游泳|攀岩|健身|运动/, any: ["体育", "运动", "球", "健身", "游泳"] },
];

const INDOOR_WORDS = ["公园", "风景", "景点", "广场", "山", "户外", "运动场", "露营"];

function hintsOf(text: string) {
  return TYPE_HINTS.filter((h) => h.test.test(text));
}

function checkabilityOf(
  category: NeedCategory,
  text: string,
  quote: string
): { checkable: NeedCheckability; value: number | null } {
  const value = numericValue(text, quote, category);
  if (category === "预算" && value != null) return { checkable: "cost", value };
  if (
    (category === "距离" || category === "交通" || category === "时间") &&
    value != null
  ) {
    return { checkable: "travel", value };
  }
  if (hintsOf(`${text} ${quote}`).length > 0) return { checkable: "type", value: null };
  if (/室内|户外|室外|露天|爬山|下山/.test(`${text} ${quote}`)) {
    return { checkable: "type", value: null };
  }
  return { checkable: "none", value: null };
}

/** 逐条要求：谁 + 哪个方面 + 多硬 + 要还是不要 + 原话 */
function sanitizeNeeds(v: unknown, memberNames: string[]): Need[] {
  const out: Need[] = [];
  const index = new Map<string, number>();
  if (!Array.isArray(v)) return out;

  // 名字里多一个空格、全半角括号都会让归属对不上，这里统一收一下
  const byName = new Map(
    memberNames.map((n) => [n.replace(/\s/g, "").toLowerCase(), n])
  );

  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const rawWho = String(rec.who ?? "").trim().slice(0, 12);
    const compact = rawWho.replace(/\s/g, "").toLowerCase();
    const who =
      rawWho === "" || rawWho === "全体" || rawWho === "大家"
        ? ""
        : memberNames.includes(rawWho)
          ? rawWho
          : (byName.get(compact) ?? "");
    const text = String(rec.text ?? "").trim().slice(0, 40);
    if (!text) continue;
    const category = normCategory(rec.category);
    const strength = normStrength(rec.strength);
    const polarity = String(rec.polarity ?? "").trim() === "want" ? "want" : "avoid";
    const quote = String(rec.quote ?? "").trim().slice(0, 60) || text;

    // 同一个人 + 同一个方面只留一条，且留更严格的那条：
    // 先说「密室也行」后说「密室有点怕」时，后者才是真实态度。
    const key = `${who}|${category}`;
    const existing = index.get(key);
    if (existing != null) {
      const prev = out[existing];
      if (
        prev.strength !== "hard" &&
        (strength === "hard" || (strength === "strong" && prev.strength === "soft"))
      ) {
        const { checkable, value } = checkabilityOf(category, text, quote);
        out[existing] = {
          id: prev.id,
          who,
          category,
          text,
          quote,
          strength,
          polarity: polarity as "avoid" | "want",
          checkable,
          value,
        };
      }
      continue;
    }

    const { checkable, value } = checkabilityOf(category, text, quote);
    index.set(key, out.length);
    out.push({
      id: `n${out.length + 1}`,
      who,
      category,
      text,
      quote,
      strength,
      polarity: polarity as "avoid" | "want",
      checkable,
      value,
    });
    if (out.length >= 24) break;
  }
  return out;
}

/**
 * 重排时把上一版还成立的要求接回来。
 * 同一份群聊每次重抽，AI 都可能少列一两条；少的那条不参与打分，
 * 用户看到的就是「提了新要求，结果一点没变」。
 * 只在 AI 这次完全没提到某个人时才补他的旧条目 —— 提了却删掉，视为有意修正。
 */
function mergeNeeds(fresh: Need[], previous: Need[]): Need[] {
  if (!previous.length) return fresh;
  const key = (n: Need) => `${n.who}|${n.category}`;
  const seenWho = new Set(fresh.map((n) => n.who));
  const seenKey = new Set(fresh.map(key));
  const kept = previous.filter(
    (n) => !seenWho.has(n.who) && !seenKey.has(key(n))
  );
  return kept.length ? [...fresh, ...kept] : fresh;
}

/**
 * 要求去重。重排时上一版的要求会被接回来，AI 又会重新抽一遍，
 * 同一条「单程不超过 30 分钟」可能攒成三条，核对表里就会重复三行。
 */
function dedupeNeeds(list: Need[]): Need[] {
  const seen = new Set<string>();
  const out: Need[] = [];
  for (const n of list) {
    const key = `${n.who}|${n.category}|${n.checkable}|${n.value ?? ""}|${n.text.replace(/\s/g, "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/**
 * 硬性条件去重。
 * AI 写「人均不超过80元」、代码补「人均不超过 80 元」，是同一条，不该在界面上并排两条。
 */
function dedupeNotes(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const t = String(raw ?? "").trim();
    if (!t) continue;
    const key = t.replace(/[\s，。；、,.;:：·]/g, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

type Extracted = {
  activityId: ActivityId;
  activityLabel: string;
  /** 群聊里看出来的城市，空串表示没判断出来 */
  city: string;
  requirements: Requirement[];
  keywords: string[];
  radius: number;
  hardConstraints: string[];
  softWishes: string[];
  members: MemberSeed[];
  needs: Need[];
  budget: number | null;
  maxTravelMin: number | null;
};

type MemberSeed = RawMember & { constraints: string[]; wishes: string[] };

/**
 * 同一段群聊的分析结果缓存。
 * 线上（Netlify 免费版）同步函数只有 10 秒，一次完整规划已经很贴线；
 * 用户点第二次、或两个人拿同一段群聊试的时候，不该再从零读一遍群聊。
 * 只存在当前函数实例内存里，10 分钟过期，最多 8 份，不写任何存储。
 */
const EXTRACT_TTL_MS = 10 * 60 * 1000;
const EXTRACT_CACHE_MAX = 8;
const extractCache = new Map<
  string,
  { at: number; data: Extracted; model: string }
>();

function extractKey(
  chat: string,
  activityId: ActivityId,
  custom: string,
  extra: string[] = []
) {
  // 不引 crypto：这里只求同一段文本落到同一个 key，不需要抗碰撞
  let h = 0;
  // 追加要求也要进 key：同一句追问重试时才算得中
  const src = `${activityId}|${custom}|${extra.join("\u0001")}|${chat}`;
  for (let i = 0; i < src.length; i++) {
    h = (h * 31 + src.charCodeAt(i)) | 0;
  }
  return `${src.length}:${h}`;
}

async function extract(
  chat: string,
  defaultActivityId: ActivityId,
  config: ApiConfig,
  extra: string[],
  customLabel = "",
  timeoutMs?: number
): Promise<{ data: Extracted; model: string }> {
  const key = extractKey(chat, defaultActivityId, customLabel, extra);
  const hit = extractCache.get(key);
  if (hit && Date.now() - hit.at < EXTRACT_TTL_MS) {
    return { data: hit.data, model: hit.model };
  }
  const res = await extractUncached(
    chat,
    defaultActivityId,
    config,
    extra,
    customLabel,
    timeoutMs
  );
  extractCache.delete(key);
  extractCache.set(key, { at: Date.now(), ...res });
  while (extractCache.size > EXTRACT_CACHE_MAX) {
    const first = extractCache.keys().next().value;
    if (first == null) break;
    extractCache.delete(first);
  }
  return res;
}

async function extractUncached(
  chat: string,
  defaultActivityId: ActivityId,
  config: ApiConfig,
  extra: string[],
  customLabel = "",
  timeoutMs?: number
): Promise<{ data: Extracted; model: string }> {
  const custom = customLabel.trim().slice(0, 30);
  // 用户在界面上选了「其他」，活动类型就不再由 AI 猜
  const forcedOther = defaultActivityId === "other";
  const defaultLabel = forcedOther
    ? custom || "其他"
    : ACTIVITIES.find((a) => a.id === defaultActivityId)?.name ?? "待确认";

  const system = `你是聚会需求分析器。任务：**咬文嚼字**地读完这段群聊，把每个人自己提的要求逐条拆出来，并判断他有多在意。

只输出 JSON，不要任何解释文字：
{"activityId":"boardgame","city":"杭州","requirements":[{"label":"时间","value":"周六下午"}],"searchKeywords":["密室逃脱","剧本杀"],"radius":5000,"budgetYuan":80,"maxTravelMin":40,"hardConstraints":["人均不超过80元"],"softWishes":["能拍照"],"members":[{"name":"小A","originHint":"西溪","originQuote":"我住西溪那边 骑车过去十几分钟"},{"name":"小D","originHint":"文三路","originQuote":"我在文三路实习 过去远吗"}],"needs":[{"who":"小B","category":"时间","text":"五点前必须回去","quote":"五点前得回来 晚上有事","strength":"hard","polarity":"avoid"},{"who":"小D","category":"交通","text":"晕车，别坐太久的车","quote":"我随便 别太远就行 晕车","strength":"hard","polarity":"avoid"}]}

规则：
1. activityId 只能取这 9 个之一：hiking(徒步登山)、food(聚餐美食)、boardgame(桌游剧本)、cafe(咖啡书店)、escape(密室逃脱)、sports(运动健身)、shopping(逛街购物)、movie(观影演出)、other(其他)。以群聊里明确说出的为准，没说就用默认值。${
    forcedOther
      ? `\n   **界面已指定**：用户把活动选成了「其他」${
          custom ? `，并写明「${custom}」` : "，但没有写具体是什么"
        }。activityId 必须返回 other；searchKeywords 必须给出 2-4 个能直接在高德地图搜到店的具体词${
          custom ? `，围绕「${custom}」展开（例如看展→["美术馆","展览馆","艺术中心"]）` : "，从群聊里推断出到底想干什么"
        }，**不要用「聚会」「活动」「好玩的地方」这种搜不出店的泛词**。`
      : ""
  }
1.1 city：这段群聊发生在哪个城市。**从地名、商圈、地标、地铁线路名判断**（"春熙路/天府广场/犀浦"→成都，"解放碑/观音桥"→重庆，"国贸/望京"→北京，"陆家嘴/徐家汇"→上海，"南山/车公庙"→深圳）。只写城市名两个字，不要带"市"；确实一点线索都没有才填"杭州"。
2. requirements 的 label 只能取：活动、时间、预算、成员、禁忌、偏好，每个最多一次。群聊没提到的写"待确认"，不要编造。预算写成"人均 80 元左右"这种形式。
3. budgetYuan：群里说的人均预算上限，纯数字；没提就填 null。**这是硬上限。**
4. maxTravelMin：单程路上最多能接受多少分钟，纯数字；有人说了"五点前得回去""别太远"，按语气估一个合理值；完全没提就 null。
5. members：**每一个在群里说过话的人都要单独列出来**，最多 6 人。
   - name 用群里的称呼原样照抄。
   - originHint 只填这个人自己说过的出发地，**去掉「从、在、住、出发、过去、这边」这些虚词，只留地名本身**：
     「我从古荡出发」→"古荡"；「钱江新城这边过去」→"钱江新城"；「我在文三路实习」→"文三路"；「我住西溪那边」→"西溪"；「下班从滨江走」→"滨江"。
   - originQuote 摘抄支撑这个出发地的那句原话，供核对。
   - **请逐个检查每个人说过的话再定 originHint。一个群聊里通常有 1-4 个人会说出发地，这四个字位置最容易被漏掉；宁可多找，也不要整列全空。** 只有确实一个字都没提，才留空字符串。
   - 不要把同一个人的出发地复制给别人；也不要写「学校」「公司」「宿舍」这种没有具体位置的说法。
6. needs 是最重要的部分，逐条拆，一条 = 一个人 + 一个方面 + 一个方向：
   - who：谁提的，必须是 members 里出现过的名字，原样照抄。即使这句话其实对全体都成立（例如"人均别超过80"），也写在提出者名下，不要写"全体"。
   - category 只能取：预算、时间、距离、交通、环境、饮食、体力、活动、氛围、其他。
     预算=花多少钱；时间=几点前/几点后/能待多久；距离=远近；交通=晕车、堵车、要不要坐地铁；环境=室内外、黑、吵、卫生；饮食=辣、忌口、想吃哪类；体力=累不累、爬不爬；活动=想玩什么/不想玩什么；氛围=安静、拍照、热闹。
   - polarity：不能接受 / 不想要 = avoid；想要 / 希望 = want。
   - strength 必须按原话语气判，**不许一律填 strong**：
     hard = 明确排斥或硬约束（"不能""不行""绝对""必须""一点都""受不了""怕""晕""忌口""别…""得回去"）
     strong = 有明确倾向但能让步（"最好""尽量""希望""想""比较想""要…"）
     soft = 可有可无（"都行""随便""无所谓""也可以""看你们"）
   - text：把这句话收敛成 12-20 字的要求，只写原话里有的意思，不要加戏。
   - quote：**原样摘抄**群聊里对应的那一句（可截断，但一个字都不能改）。找不到原句就不要输出这一条。
7. 合并与升级：同一个人同一个方面说了多次只输出一条，取**最严格**的那次。例如先说"密室也行"、后说"密室有点怕 黑的"，就输出 avoid + hard。前后矛盾时以更晚、更具体的那句为准。
8. **不许替任何人扩大或缩小要求**：小D 说"别太远"就只能记在小D名下；小A 说"人均别超过80"不等于小B 也接受 80；小C 说"那桌游也行"是在让步，记成 want + soft。
9. 有人说了"我随便""我都行"，就不要给他编要求；但他后面若又提了具体的，以具体的为准。
10. hardConstraints / softWishes 放全体层面的结论（预算、时间、活动类型、明显冲突项），最多 5 条，供整体筛选；细节留在 needs 里。
11. searchKeywords 是拿去高德搜真实商户的关键词，2-3 个，要具体能搜到店；避开群聊里已被否决的类型。**关键词要同时覆盖「必须满足的类型」和「有人明确想去的类型」**，否则候选池里根本不会有能满足那些要求的店（例如有人想安静坐着聊天，就要带上"咖啡馆""书店"）。
12. radius 是搜索半径，单位米，市区 3000-5000，偏远可到 10000。
13. 严格输出 JSON。`;

  const extraBlock = extra.length
    ? `\n\n用户后来又追加的要求（优先级最高，必须并入）：\n${extra
        .map((e, i) => `${i + 1}. ${e}`)
        .join("\n")}`
    : "";

  const user = `默认活动类型：${defaultLabel}\n\n群聊记录：\n"""\n${chat}\n"""${extraBlock}`;

  const { text, model } = await callChat(
    config,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    // 抽取任务要的是「照抄群聊」，温度高了会把没说的话编出来
    {
      json: true,
      thinking: false,
      maxTokens: 2800,
      temperature: 0.2,
      timeoutMs,
    }
  );

  const parsed = parseJsonLoose(text);
  if (!parsed) {
    throw new PlannerError(
      "BAD_JSON",
      "AI 返回的内容不是合法 JSON",
      text.slice(0, 200)
    );
  }

  // 界面选了「其他」时以用户的说法为准，别让 AI 又猜回某个固定分类
  const activityId: ActivityId = forcedOther
    ? "other"
    : refineActivity(
        normalizeActivity(parsed.activityId, defaultActivityId),
        chat
      );
  const activityLabel = forcedOther
    ? custom || "其他"
    : ACTIVITIES.find((a) => a.id === activityId)?.name ?? defaultLabel;

  const rawKeywords = strList(parsed.searchKeywords, 4, 12);
  let keywords = rawKeywords;
  if (!keywords.length) {
    if (activityId === "other") {
      // 自定义活动没有兜底词表，只能用用户那句话本身去搜
      keywords = custom
        ? custom.split(/[\s、,，/·]+/).filter(Boolean).slice(0, 3)
        : FALLBACK_KEYWORDS.other;
    } else {
      keywords = FALLBACK_KEYWORDS[activityId];
    }
  }

  const radiusRaw = Number(parsed.radius);
  const radius = Number.isFinite(radiusRaw)
    ? Math.min(Math.max(Math.round(radiusRaw), 1000), 15_000)
    : 5000;

  const requirements = sanitizeRequirements(parsed.requirements, activityLabel);
  const rawMembers = sanitizeMembers(parsed.members);
  const needs = sanitizeNeeds(
    parsed.needs,
    rawMembers.map((m) => m.name)
  );

  // 成员的「限制 / 期望」不再单独让 AI 写，直接从 needs 派生，
  // 保证界面上看到的每一条都能追溯到某条原话，不会出现两套互相打架的说法。
  const seeds: MemberSeed[] =
    rawMembers.length > 0
      ? rawMembers.map((m) => {
          const mine = needs.filter((n) => n.who === m.name);
          return {
            ...m,
            constraints: mine
              .filter((n) => n.polarity === "avoid")
              .map((n) => n.text)
              .slice(0, 4),
            wishes: mine
              .filter((n) => n.polarity === "want")
              .map((n) => n.text)
              .slice(0, 4),
          };
        })
      : [
          {
            name: "我",
            originHint: "",
            originQuote: "",
            constraints: needs
              .filter((n) => n.polarity === "avoid")
              .map((n) => n.text)
              .slice(0, 4),
            wishes: needs
              .filter((n) => n.polarity === "want")
              .map((n) => n.text)
              .slice(0, 4),
          },
        ];

  // AI 有时会漏掉话少但有位置信息的人，他们说过的出发地不能白丢
  for (const extra of missingSpeakers(chat, seeds.map((x) => x.name))) {
    if (seeds.length >= MAX_MEMBERS) break;
    seeds.push({
      name: extra.name,
      originHint: "",
      originQuote: extra.quote,
      constraints: [],
      wishes: [],
    });
  }

  const budgetRaw = Number(parsed.budgetYuan);
  const budget = Number.isFinite(budgetRaw) && budgetRaw > 0
    ? Math.min(Math.round(budgetRaw), 3000)
    : budgetFromText(requirements);
  const travelRaw = Number(parsed.maxTravelMin);
  const maxTravelMin =
    Number.isFinite(travelRaw) && travelRaw > 0
      ? Math.min(Math.round(travelRaw), 240)
      : null;

  return {
    data: {
      activityId,
      activityLabel,
      city: sanitizeCity(parsed.city),
      requirements,
      keywords,
      radius,
      hardConstraints: strList(parsed.hardConstraints, 5, 40),
      softWishes: strList(parsed.softWishes, 5, 40),
      members: seeds,
      needs,
      budget,
      maxTravelMin,
    },
    model,
  };
}

/** 兜底：从「人均 80 元左右」这类文字里抠出数字 */
function budgetFromText(requirements: Requirement[]): number | null {
  const hit = requirements.find((r) => r.label === "预算");
  if (!hit) return null;
  const m = hit.value.match(/(\d{2,4})/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

type MemberOverride = {
  name: string;
  originName: string;
  lat: number;
  lng: number;
};

export type { MemberOverride };

/**
 * 城市中心：当一个人都没读到出发地、用户也没设自己的位置时，
 * 用它当检索锚点。走地理编码得到，不写死任何具体地点。
 */
export async function cityCenter(
  amapKey: string,
  city: string
): Promise<Origin> {
  const geo = await geocode(amapKey, city, city);
  if (!geo) {
    throw new PlannerError(
      "NO_LOCATION",
      `没能定位到「${city}」`,
      "检查高德 Web 服务 Key 是否可用"
    );
  }
  return { name: city, lat: geo.lat, lng: geo.lng };
}

/** 把「西溪」「文三路」这类说法交给高德解析成坐标；解析不出来返回 null */
async function locate(
  amapKey: string,
  hint: string,
  city: string,
  near: { lat: number; lng: number }
): Promise<{ lat: number; lng: number; name: string; address: string } | null> {
  const h = hint.trim();
  if (h.length < 2) return null;
  const hit = await locatePlace(amapKey, h, city, near);
  return hit
    ? { lat: hit.lat, lng: hit.lng, name: hit.name, address: hit.address }
    : null;
}

async function resolveMembers(
  raw: MemberSeed[],
  chat: string,
  amapKey: string,
  city: string,
  fallback: Origin,
  overrides: MemberOverride[]
): Promise<Member[]> {
  const list: MemberSeed[] =
    raw.length > 0
      ? raw
      : [
          {
            name: "我",
            originHint: "",
            originQuote: "",
            constraints: [],
            wishes: [],
          },
        ];

  // 每人最多试 3 个说法。并发压到 3，配合 place.ts 里的闸门，避免被高德限流。
  return mapLimit(list, 3, async (m, i): Promise<Member> => {
      const base = {
        name: m.name,
        constraints: m.constraints,
        wishes: m.wishes,
        color: memberColor(i),
      };

      const override = overrides.find((o) => o.name === m.name);
      if (
        override &&
        Number.isFinite(override.lat) &&
        Number.isFinite(override.lng)
      ) {
        return {
          ...base,
          originName: override.originName || "自定义位置",
          lat: override.lat,
          lng: override.lng,
          resolved: true,
          originSource: "override",
          originQuote: "",
          originAddress: "",
        };
      }

      // 原话里抓到的优先：它是这个人自己那一行里的词，归属不会错；
      // AI 的 originHint 作为第二选择，用来兜住更绕的说法。
      const fromChat = hintFromChat(
        chat,
        m.name,
        list.map((x) => x.name)
      );
      const tried: string[] = [];
      const candidates: { hint: string; source: "chat" | "ai"; quote: string }[] =
        [];
      for (const h of fromChat.hints) {
        if (tried.includes(h)) continue;
        tried.push(h);
        candidates.push({ hint: h, source: "chat", quote: fromChat.quote });
      }
      const aiHint = m.originHint.trim();
      if (aiHint && !tried.includes(aiHint)) {
        tried.push(aiHint);
        candidates.push({
          hint: aiHint,
          source: "ai",
          quote: m.originQuote || "",
        });
      }

      // 候选按可信度逐个试：一个说法定位不到（「转塘」以前就是），
      // 就换下一个，而不是直接把人判成「位置未知」。最多试 3 个，别把响应拖长。
      for (const c of candidates.slice(0, 3)) {
        const pos = await locate(amapKey, c.hint, city, fallback);
        if (pos) {
          return {
            ...base,
            originName: c.hint,
            lat: pos.lat,
            lng: pos.lng,
            resolved: true,
            originSource: c.source,
            originQuote: c.quote,
            originAddress: pos.address,
          };
        }
      }

      // 一个都解析不出来：老实标「位置待确认」，坐标只用来占位，
      // 不参与锚点计算（anchorsOf 只看 resolved 的人）。
      return {
        ...base,
        originName: candidates.length
          ? `未识别：${candidates[0].hint}`
          : fallback.name,
        lat: fallback.lat,
        lng: fallback.lng,
        resolved: false,
        originSource: "unknown",
        originQuote: candidates[0]?.quote ?? "",
        originAddress: "",
        originTried: candidates.map((c) => c.hint).join("、"),
      };
  });
}

/**
 * 检索锚点：成员几何中心 + 每个成员的出发点。
 *
 * 只搜「中心点 + 最远的那一个人」是不够的：最远的人能搜到，但夹在中间的人
 * （比如城西 + 滨江 + 良渚 里的城西）永远落在半径之外，候选池里一个近的都没有，
 * 最后就会变成「谁家附近店多就往谁家开会」。
 * 所以 4 人以内每个人都当一个锚点；人更多时取中心点 + 离中心最远的 3 个人。
 * 只统计位置已确认的成员；一个都没有时退回 fallback（用户位置或城市中心）。
 */
export function anchorsOf(
  members: Member[],
  fallback: Origin
): { name: string; lat: number; lng: number }[] {
  const resolved = members.filter((m) => m.resolved);
  const pts: { name: string; lat: number; lng: number }[] = resolved.length
    ? resolved.map((m) => ({ name: m.name, lat: m.lat, lng: m.lng }))
    : [{ name: fallback.name, lat: fallback.lat, lng: fallback.lng }];
  const lat = pts.reduce((a, m) => a + m.lat, 0) / pts.length;
  const lng = pts.reduce((a, m) => a + m.lng, 0) / pts.length;
  const center = { name: "", lat, lng };

  const centerD = pts.map((m) => haversineM(center, m));
  const maxD = Math.max(...centerD);
  const label =
    maxD < 600
      ? pts.length === 1
        ? pts[0].name
        : `${pts.length} 人所在区域`
      : `${pts.length} 人中心`;

  const out = [{ name: label, lat, lng }];
  if (maxD < 600) return out;

  if (pts.length <= 4) {
    // 人少，人人都要被覆盖到
    return [...out, ...pts];
  }
  // 人多，取离中心最远的 3 个方向，避免全挤在市中心
  const spread = [...pts]
    .map((p, i) => ({ p, d: centerD[i] }))
    .sort((a, b) => b.d - a.d)
    .slice(0, 3)
    .map((x) => x.p);
  return [...out, ...spread];
}

function fmtKm(m: number | null) {
  if (m == null) return "未知";
  return m >= 1000 ? `${(m / 1000).toFixed(1)} 公里` : `${Math.round(m)} 米`;
}

function fmtMin(s: number | null) {
  if (s == null) return "";
  return `${Math.max(1, Math.round(s / 60))} 分钟`;
}

/** 把「时间 + 车费」折算成一个可比的钱数，越小越划算 */
function combined(durationS: number, fareYuan: number) {
  return (durationS / 60) * TIME_VALUE_PER_MIN + fareYuan;
}

/** 单人一段路的全部走法：步行 / 打车 / 公交地铁 */
function optionsFor(
  member: Member,
  poi: AmapPoi,
  drive: { distanceM: number | null; durationS: number | null } | undefined,
  transit: TransitResult | null | undefined
): TravelOption[] {
  const opts: TravelOption[] = [];
  const straight = haversineM(member, { lat: poi.lat, lng: poi.lng });
  const roadM = drive?.distanceM ?? null;

  if (straight <= WALK_LIMIT_M) {
    const walkM = Math.round(roadM ?? straight * 1.25);
    const walkS = Math.round(walkM / 1.15);
    opts.push({
      mode: "walking",
      durationS: walkS,
      distanceM: walkM,
      fareYuan: 0,
      detail: `步行 ${fmtKm(walkM)}`,
      combinedCost: combined(walkS, 0),
    });
  }

  const driveM = Math.round(roadM ?? straight * 1.35);
  const driveS =
    drive?.durationS ??
    Math.round((driveM / 1000 / 28) * 3600);
  const fare = taxiFare(driveM);
  opts.push({
    mode: "driving",
    durationS: driveS,
    distanceM: driveM,
    fareYuan: fare,
    detail: `打车约 ¥${fare}`,
    combinedCost: combined(driveS, fare),
  });

  if (transit) {
    opts.push({
      mode: "transit",
      durationS: transit.durationS,
      distanceM: transit.distanceM,
      fareYuan: transit.fareYuan,
      detail: transit.summary,
      combinedCost: combined(transit.durationS, transit.fareYuan),
    });
  }

  return opts;
}

function legOf(
  member: Member,
  poi: AmapPoi,
  drive: { distanceM: number | null; durationS: number | null } | undefined,
  transit: TransitResult | null | undefined
): MemberLeg {
  const opts = optionsFor(member, poi, drive, transit).sort(
    (a, b) => a.combinedCost - b.combinedCost
  );
  const best = opts[0];
  const other = opts[1] ?? null;

  return {
    name: member.name,
    color: member.color,
    distanceM: best.distanceM,
    durationS: best.durationS,
    mode: best.mode,
    fareYuan: best.fareYuan,
    combinedCost: Math.round(best.combinedCost),
    detail: best.detail,
    alt: other
      ? {
          mode: other.mode,
          durationS: other.durationS,
          fareYuan: other.fareYuan,
          detail: other.detail,
        }
      : null,
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

type ScoreCtx = {
  budget: number | null;
  maxTravelMin: number | null;
  needs?: Need[];
  /** 每人「距离/交通」类要求的总权重，越重的人通勤时间在打分里越算数 */
  travelPressure?: Map<string, number>;
  /** AI 对语义类要求的判定，key = `${candId}:${needId}` */
  aiChecks?: Map<string, { verdict: NeedVerdict; why: string }>;
  /** 出发地没读到的人：他们的坐标只是占位，任何基于距离的判断都要作废 */
  unresolved?: Set<string>;
};

/**
 * 谁在哪些方面要求更重。
 * 只统计到人身上的要求（全体共同要求算在整体条件里，不进个人权重），
 * 否则每个人都会被同一句话拉平，看不出差异。
 */
export function pressureOf(needs: Need[], members: Member[]): MemberPressure[] {
  return members
    .map((m) => {
      const mine = needs.filter((n) => n.who === m.name);
      const byCat = new Map<NeedCategory, { weight: number; count: number }>();
      for (const n of mine) {
        const cur = byCat.get(n.category) ?? { weight: 0, count: 0 };
        cur.weight += strengthWeight(n.strength);
        cur.count += 1;
        byCat.set(n.category, cur);
      }
      const top = [...byCat.entries()]
        .map(([category, v]) => ({
          category,
          weight: Math.round(v.weight * 10) / 10,
          count: v.count,
        }))
        .sort((a, b) => b.weight - a.weight);
      return {
        name: m.name,
        color: m.color,
        weight:
          Math.round(mine.reduce((a, n) => a + strengthWeight(n.strength), 0) * 10) /
          10,
        top,
        hardCount: mine.filter((n) => n.strength === "hard").length,
      };
    })
    .sort((a, b) => b.weight - a.weight || b.hardCount - a.hardCount);
}

function travelPressureOf(needs: Need[], members: Member[]) {
  const map = new Map<string, number>();
  for (const m of members) map.set(m.name, 0);
  for (const n of needs) {
    if (!n.who) continue;
    // 「9 点前得回良渚」本质是通勤敏感：他能不能来，取决于路上要多久。
    // 不把它算进压力，最远的那个人就一直被当成「反正他也没说不远」。
    const travelSensitive =
      n.category === "距离" ||
      n.category === "交通" ||
      (n.category === "时间" && /回|走|散|结束|到家|赶|离|前/.test(n.text));
    if (!travelSensitive) continue;
    map.set(n.who, (map.get(n.who) ?? 0) + strengthWeight(n.strength));
  }
  return map;
}

/**
 * 逐条核对：这个地点满足了谁的要求、违背了谁的、哪些判断不了。
 *
 * 能算的一律用高德真实字段算（人均、耗时、场所类型），算不出的标 unknown，
 * 只有拿到 AI 的语义判断才升级成 pass / conflict —— 不允许拿猜的当结论。
 */
function checksOf(poi: AmapPoi, legs: MemberLeg[], ctx: ScoreCtx): NeedCheck[] {
  const needs = ctx.needs ?? [];
  if (!needs.length) return [];

  const perCapita = Number(poi.cost) > 0 ? Number(poi.cost) : null;
  const mins = legs
    .filter((l) => l.durationS != null)
    .map((l) => ({ name: l.name, min: (l.durationS as number) / 60 }));
  const worst = mins.length
    ? mins.reduce((a, b) => (b.min > a.min ? b : a))
    : null;
  const hay = `${poi.name} ${poi.type}`;

  return needs.map((n) => {
    const base = {
      needId: n.id,
      who: n.who,
      category: n.category,
      text: n.text,
      quote: n.quote,
      strength: n.strength,
      polarity: n.polarity,
    };
    const ai = ctx.aiChecks?.get(`${poi.id}:${n.id}`);

    const judged = (verdict: NeedVerdict, evidence: string): NeedCheck =>
      ai
        ? { ...base, verdict: ai.verdict, evidence: ai.why || evidence, source: "ai" }
        : { ...base, verdict, evidence, source: "data" };

    if (n.checkable === "cost") {
      if (perCapita == null) return judged("unknown", "高德没标这家人均，判断不了");
      if (!n.value) return judged("unknown", "没读出具体预算数字");
      const over = perCapita - n.value;
      if (over <= 0) {
        return judged(
          "pass",
          `人均 ${perCapita} 元，在 ${n.value} 元以内`
        );
      }
      if (over <= n.value * 0.05) {
        return judged(
          "unknown",
          `人均 ${perCapita} 元，刚好卡在 ${n.value} 元边上`
        );
      }
      return judged(
        "conflict",
        `人均 ${perCapita} 元，超了 ${Math.round(over)} 元`
      );
    }

    if (n.checkable === "travel") {
      const target = n.who ? mins.find((m) => m.name === n.who) : worst;
      if (!target) {
        return judged(
          "unknown",
          n.who && ctx.unresolved?.has(n.who)
            ? `${n.who} 的出发地没读到，没法算他要多久`
            : "这段路程的时间没算出来"
        );
      }
      if (!n.value) return judged("unknown", "没读出具体时长要求");
      const label = n.who ? target.name : `${target.name}（最远的）`;
      if (target.min <= n.value) {
        return judged(
          "pass",
          `${label} 单程 ${Math.round(target.min)} 分钟，在 ${n.value} 分钟内`
        );
      }
      if (target.min <= n.value * 1.15) {
        return judged(
          "unknown",
          `${label} 单程 ${Math.round(target.min)} 分钟，略超 ${n.value} 分钟`
        );
      }
      return judged(
        "conflict",
        `${label} 单程 ${Math.round(target.min)} 分钟，超过 ${n.value} 分钟`
      );
    }

    if (n.checkable === "type") {
      const wantsIndoor = /室内/.test(n.text);
      const wantsOutdoor = /户外|室外|露天/.test(n.text);
      if (wantsIndoor || wantsOutdoor) {
        const isOutdoor = INDOOR_WORDS.some((w) => hay.includes(w));
        const matches = wantsIndoor ? !isOutdoor : isOutdoor;
        const ok = n.polarity === "want" ? matches : !matches;
        return judged(
          ok ? "pass" : "conflict",
          `${poi.type || "类型未标"}${isOutdoor ? "，属室外场地" : "，属室内场地"}`
        );
      }

      const hints = hintsOf(`${n.text} ${n.quote}`);
      let hit: string | null = null;
      for (const hint of hints) {
        for (const w of hint.any) {
          if (hay.includes(w)) {
            hit = w;
            break;
          }
        }
        if (hit) break;
      }
      if (hit) {
        return judged(
          n.polarity === "avoid" ? "conflict" : "pass",
          `类型「${poi.type || "未标"}」命中「${hit}」`
        );
      }
      // 「想吃火锅」而这家是面馆，这不是「资料查不到」，是明确不符 ——
      // 场所类型是高德最可靠的字段，不能因为 AI 客气一句就放过。
      if (hints.length) {
        return {
          ...base,
          verdict: n.polarity === "avoid" ? "pass" : "conflict",
          evidence: `类型「${poi.type || "未标"}」不是「${hints[0].any[0]}」类`,
          source: "data",
        };
      }
      return judged(
        n.polarity === "avoid" ? "pass" : "unknown",
        `类型「${poi.type || "未标"}」里没有「${n.text}」相关`
      );
    }

    // 时间类要求是行程约束：地点决定不了「几点前到家」，
    // 但它决定了「这个人到底来不来得及」，所以要用真实路程算一算。
    if (n.category === "时间" && n.checkable === "none") {
      const deadline = deadlineOf(`${n.text} ${n.quote}`);
      const target = n.who ? mins.find((m) => m.name === n.who) : null;
      if (deadline != null && target) {
        const leave = deadline - target.min;
        const hh = (v: number) =>
          `${String(Math.floor((v % 1440) / 60)).padStart(2, "0")}:${String(
            Math.round(v % 60)
          ).padStart(2, "0")}`;
        const travel = `${Math.round(target.min)} 分钟`;
        // 16 点前就得离店，等于这场聚会根本坐不下来
        if (leave < 16 * 60) {
          return {
            ...base,
            verdict: "conflict",
            evidence: `${hh(deadline)} 前要到家，单程 ${travel}，得 ${hh(
              leave
            )} 就离店，来不及`,
            source: "data",
          };
        }
        return {
          ...base,
          verdict: "unknown",
          evidence: `${hh(deadline)} 前到家，就得 ${hh(
            leave
          )} 离店（单程 ${travel}）`,
          source: "data",
        };
      }
      return judged("unknown", "行程约束，取决于路上时间和你们玩多久");
    }

    return judged("unknown", "商户资料里没有这项，只能你自己确认");
  });
}

/** 把逐条核对折算成 0-1 的匹配度：满足=1，判断不了=0.5，违背=0，再按强度加权 */
function needsScoreOf(checks: NeedCheck[]) {
  let sum = 0;
  let wsum = 0;
  let pass = 0;
  let conflict = 0;
  let unknown = 0;
  for (const c of checks) {
    const w = strengthWeight(c.strength);
    const v = c.verdict === "pass" ? 1 : c.verdict === "conflict" ? 0 : 0.5;
    sum += w * v;
    wsum += w;
    if (c.verdict === "pass") pass += 1;
    else if (c.verdict === "conflict") conflict += 1;
    else unknown += 1;
  }
  return { value: wsum ? sum / wsum : 0.6, pass, conflict, unknown };
}

function scoreOf(poi: AmapPoi, legs: MemberLeg[], ctx: ScoreCtx): CandidateScore {
  const mins = legs
    .filter((l) => l.durationS != null)
    .map((l) => ({ name: l.name, min: (l.durationS as number) / 60 }));

  // 越是在意距离/交通的人，他的通勤时间在打分里权重越高
  const pressure = ctx.travelPressure ?? new Map<string, number>();
  const weighted = mins.map((m) => ({
    ...m,
    w: m.min * (1 + 0.25 * (pressure.get(m.name) ?? 0)),
  }));
  const worstW = weighted.length
    ? weighted.reduce((a, b) => (b.w > a.w ? b : a))
    : null;
  const worst = mins.find((m) => m.name === worstW?.name) ?? null;
  const best = mins.length ? mins.reduce((a, b) => (b.min < a.min ? b : a)) : null;
  const avg = mins.length
    ? mins.reduce((a, b) => a + b.min, 0) / mins.length
    : null;
  const spread = worst && best ? worst.min - best.min : null;

  const perCapita = Number(poi.cost) > 0 ? Number(poi.cost) : null;
  const ratingNum = Number(poi.rating) > 0 ? Number(poi.rating) : null;

  // 曲线太陡会把「60 分钟」和「110 分钟」压成同一个 0 分，
  // 于是「谁都别太远」这件事在排序里彻底消失（实测：小A 76 分、小E 107 分的店
  // 和 19/37/22 分的店打平，最后靠 AI 随手挑）。这里放到 87 分钟才归零。
  const travel = worstW ? clamp01(1 - (worstW.w - 12) / 75) : 0.4;
  // 45 分钟归零太急：犀浦↔龙泉这种跨城组局，spread 永远 >45，均衡那 12% 直接失效
  const fairness = spread == null ? 0.5 : clamp01(1 - spread / 70);
  const costScore =
    perCapita == null
      ? 0.45
      : ctx.budget
        ? clamp01(1 - (perCapita - ctx.budget * 0.35) / (ctx.budget * 0.85))
        : clamp01(1 - perCapita / 220);
  const quality =
    ratingNum == null ? 0.55 : clamp01((ratingNum - 3.3) / 1.7);

  const checks = checksOf(poi, legs, ctx);
  const needSum = needsScoreOf(checks);
  const hardConflicts = checks.filter(
    (c) => c.strength === "hard" && c.verdict === "conflict"
  );
  const softConflicts = checks.filter(
    (c) => c.strength !== "hard" && c.verdict === "conflict"
  );

  let rejected: string | null = null;
  if (hardConflicts.length) {
    rejected = hardConflicts
      .map((c) => `${c.who || "全体"}「${c.text}」`)
      .join("；")
      .concat(" 没满足");
  } else if (!checks.length && ctx.budget && perCapita != null && perCapita > ctx.budget * 1.25) {
    rejected = `人均 ${perCapita} 元，超出预算 ${ctx.budget} 元`;
  } else if (
    !checks.length &&
    ctx.maxTravelMin &&
    worst &&
    worst.min > ctx.maxTravelMin * 1.3
  ) {
    rejected = `${worst.name} 单程要约 ${Math.round(worst.min)} 分钟，超过可接受的 ${
      ctx.maxTravelMin
    } 分钟`;
  }

  // 「资料清不清楚」：能下结论的要求占多大比重。
  // 「几点前得回来」这种是行程约束，不由这家店决定，不能算成「资料不足」。
  const needById = new Map((ctx.needs ?? []).map((n) => [n.id, n]));
  const judged = checks.filter((c) => {
    const n = needById.get(c.needId);
    return !(n && n.category === "时间");
  });
  const wsum = judged.reduce((a, c) => a + strengthWeight(c.strength), 0);
  const knownW = judged
    .filter((c) => c.verdict !== "unknown")
    .reduce((a, c) => a + strengthWeight(c.strength), 0);
  const clarity = wsum ? knownW / wsum : 1;
  const blind = judged.filter((c) => c.verdict === "unknown");
  const unknownHard = blind.filter((c) => c.strength === "hard").length;

  // 资料不全就不该跟「逐条核对过」的店平起平坐，
  // 分数乘一个 0.8~1 的系数，让它自然落到备选区，而不是靠运气不中。
  // 违背得有多狠：超时/超支按比例算，说不清的按 0.6 记。
  // 全城都满足不了的时候，靠这个挑「伤得最轻」的那家。
  // 「很想吃火锅却给挑了家面馆」也算伤 —— 否则一刀切地满足通勤，
  // 会把这场局变成「大家都不远，但不是来吃火锅的」。
  const strongMiss = softConflicts.filter(
    (c) => c.strength === "strong" && c.category !== "距离" && c.category !== "交通"
  ).length;
  const violation = strongMiss + hardConflicts.reduce((sum, c) => {
    const n = needById.get(c.needId);
    if (!n) return sum + 0.6;
    if (n.checkable === "travel" && n.value) {
      const m = n.who ? mins.find((x) => x.name === n.who) : worst;
      return sum + (m ? Math.max(0, (m.min - n.value) / n.value) : 0.6);
    }
    if (n.checkable === "cost" && n.value && perCapita != null) {
      return sum + Math.max(0, (perCapita - n.value) / n.value);
    }
    return sum + 0.6;
  }, 0);

  const clear = clarity >= 0.6 && unknownHard === 0;
  const clearNote = unknownHard
    ? `有 ${unknownHard} 条硬性要求（${blind
        .filter((c) => c.strength === "hard")
        .map((c) => `${c.who || "全体"}「${c.text}」`)
        .slice(0, 2)
        .join("、")}）在商户资料里查不到`
    : clarity < 0.6
      ? `${blind.length} 条要求（${blind
          .map((c) => c.text)
          .slice(0, 2)
          .join("、")}）在商户资料里查不到`
      : "";

  // 权重：需求匹配 36% + 通勤 28% + 均衡 12% + 花钱 12% + 口碑 12%
  // 「需求匹配」是逐条核对后加权算出来的，改条件或改人，这一项立刻变。
  // 均衡从 5% 提到 12%：一盘人散在城西、滨江、良渚时，让一个人跑 100 分钟
  // 换来的那点「需求更贴」不值这么多分。
  // 通勤上限不是「参考值」：最远的人超得越多，整体分就该被打下去。
  // 否则「便宜 + 评分高」的远店会把中心区的店挤掉——实测成都一组人散在
  // 犀浦/龙泉驿，郫都一家店有人要跑 106 分钟，仍然靠人均和评分排到第一。
  // 1.6 倍上限之内不罚（上限本来就是估的），3 倍以上罚到一半。
  const overCap =
    ctx.maxTravelMin && worst
      ? clamp01((worst.min / ctx.maxTravelMin - 1.6) / 1.4)
      : 0;

  const score =
    (needSum.value * 0.36 +
      travel * 0.28 +
      fairness * 0.12 +
      costScore * 0.12 +
      quality * 0.12) *
    100 *
    (0.8 + 0.2 * clarity) *
    (1 - 0.5 * overCap);

  const fares = legs
    .filter((l) => l.fareYuan != null)
    .map((l) => l.fareYuan as number);
  const avgFare = fares.length
    ? fares.reduce((a, b) => a + b, 0) / fares.length
    : 0;

  return {
    id: poi.id,
    name: poi.name,
    score: Math.round((rejected ? score * 0.45 : score) * 10) / 10,
    parts: {
      needs: Math.round(needSum.value * 100),
      travel: Math.round(travel * 100),
      fairness: Math.round(fairness * 100),
      cost: Math.round(costScore * 100),
      quality: Math.round(quality * 100),
    },
    needStats: {
      pass: needSum.pass,
      conflict: needSum.conflict,
      unknown: needSum.unknown,
    },
    clarity: Math.round(clarity * 100),
    unknownHard,
    clear,
    clearNote,
    conflicts: [...hardConflicts, ...softConflicts]
      .slice(0, 2)
      .map((c) => `${c.who || "全体"}·${c.text}`),
    worstMin: worst ? Math.round(worst.min) : null,
    worstName: worst?.name ?? "",
    avgMin: avg != null ? Math.round(avg) : null,
    spreadMin: spread != null ? Math.round(spread) : null,
    perCapita,
    totalPerPerson: perCapita != null ? Math.round(perCapita + avgFare * 2) : null,
    metroCount: legs.filter((l) => l.mode === "transit").length,
    rejected,
    violation: Math.round(violation * 100) / 100,
  };
}

/**
 * 从检索结果里挑出要实际测路程的候选。
 *
 * 只按「离最近锚点的距离」取前几名，会出现「谁家附近店多、榜单就整个倒向谁家」
 * （实测：城西 + 滨江 + 良渚 三人，最后 10 个候选全在滨江星光大道）。
 * 所以先按「离哪个锚点最近」分组，组内按距离排，再各组轮流取，
 * 保证每个人的区域都有代表进候选池，公平不公平交给真实路程去判。
 * 另外混入评分最高的几家，避免候选全是路边小店。
 */
export function pickCandidates(
  pois: AmapPoi[],
  limit: number,
  anchors: { lat: number; lng: number }[] = []
): AmapPoi[] {
  if (!pois.length) return [];
  const out = new Map<string, AmapPoi>();

  if (anchors.length >= 2) {
    const groups = new Map<number, { p: AmapPoi; d: number }[]>();
    for (const p of pois) {
      let bi = 0;
      let bd = Infinity;
      anchors.forEach((a, i) => {
        const d = haversineM(a, { lat: p.lat, lng: p.lng });
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      const g = groups.get(bi);
      if (g) g.push({ p, d: bd });
      else groups.set(bi, [{ p, d: bd }]);
    }
    // 组内要按「到本组那个锚点」的距离排，不能用全局最近距离：
    // 否则城西那组里排在前面的可能是离滨江更近的店，等于又偏回一个人。
    const lists = [...groups.values()].map((g) =>
      g.sort((a, b) => a.d - b.d).map((x) => x.p)
    );
    const quota = Math.max(1, Math.floor(limit / lists.length));
    for (let round = 0; round < quota; round++) {
      for (const list of lists) {
        const p = list[round];
        if (p && out.size < limit) out.set(p.id, p);
      }
    }
    // 有的区域店少，名额没填满就从剩下的按距离补齐
    for (const list of lists) {
      for (const p of list) {
        if (out.size < limit) out.set(p.id, p);
      }
    }
  } else {
    for (const p of pois.slice(0, Math.max(1, limit - 3))) out.set(p.id, p);
  }

  const byRating = [...pois]
    .filter((p) => Number(p.rating) > 0)
    .sort((a, b) => Number(b.rating) - Number(a.rating))
    .slice(0, 4);
  for (const p of byRating) if (out.size < limit) out.set(p.id, p);
  return [...out.values()];
}

/** 按综合分从高到低排序。推荐一定出自这张榜的头部 */
export function rankCandidates(
  candidates: AmapPoi[],
  legsMap: Map<string, MemberLeg[]>,
  ctx: ScoreCtx
): CandidateScore[] {
  return candidates
    .map((poi) => scoreOf(poi, legsMap.get(poi.id) ?? [], ctx))
    .sort((a, b) => b.score - a.score);
}

/**
 * 给每个候选算「每人怎么去、要多久、花多少钱」。
 *
 * 为了省配额分两步：先用车行耗时粗排出前几名，只给这几名补地铁/公交查询。
 */
export async function attachLegs(
  candidates: AmapPoi[],
  members: Member[],
  amapKey: string,
  city: string,
  ctx: ScoreCtx,
  deadline = 0
): Promise<{
  legsMap: Map<string, MemberLeg[]>;
  transitQueries: number;
}> {
  const targets = candidates.slice(0, MAX_MEASURED);
  // 出发地没读到的人，坐标只是城市中心的占位值，算出来的路程是假的，
  // 所以把他们的结果清空——宁可显示「算不出」，也不要拿假数字影响排序。
  const unknown = new Set(
    members.filter((m) => !m.resolved).map((m) => m.name)
  );
  const clean = (l: MemberLeg): MemberLeg =>
    unknown.has(l.name)
      ? {
          ...l,
          distanceM: null,
          durationS: null,
          mode: null,
          fareYuan: null,
          combinedCost: null,
          detail: "出发地没读到，暂时算不出这个人要多久",
          alt: null,
        }
      : l;
  const driveMap = new Map<
    string,
    { distanceM: number | null; durationS: number | null }[]
  >();

  await Promise.all(
    targets.map(async (poi) => {
      const rows = await measureDistance(
        amapKey,
        members.map((m) => ({ lat: m.lat, lng: m.lng })),
        { lat: poi.lat, lng: poi.lng },
        1
      );
      driveMap.set(poi.id, rows);
    })
  );

  // 先按「只有步行/打车」的粗评分选前几名，去补公交地铁
  const prelim = targets
    .map((poi) => {
      const legs = members.map((m, i) =>
        clean(legOf(m, poi, driveMap.get(poi.id)?.[i], null))
      );
      return { poi, legs, score: scoreOf(poi, legs, ctx).score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, PRELIM_FOR_TRANSIT);

  const transitMap = new Map<string, (TransitResult | null)[]>();
  // 每个人的地铁/公交方案都要算到。之前总量卡在 40 次，尾部的候选算不出地铁、
  // 只剩打车时长，于是「没被查到地铁」的店看起来比查过的近一大截
  // （小E 从良渚出发，同一家店打车 41 分钟、地铁 103 分钟）。
  // 海外节点上高德单次要 1-2 秒，60 次地铁查询能把整个请求拖到超时。
  // 有软截止（serverless）时只补最关键的十几个，保证「至少头部候选有真实地铁时长」。
  const transitCap = planBudgetMs()
    ? Math.max(members.length * 3, 12)
    : members.length * MAX_TRANSIT_PER_MEMBER;
  const transitBudget = Math.min(
    transitCap,
    members.length * targets.length
  );
  let budgetLeft = transitBudget;

  await mapLimit(prelim, 5, async ({ poi }) => {
    const rows: (TransitResult | null)[] = new Array(members.length).fill(null);
    const jobs: number[] = [];
    members.forEach((m, i) => {
      if (haversineM(m, { lat: poi.lat, lng: poi.lng }) <= WALK_LIMIT_M) return;
      jobs.push(i);
    });

    await mapLimit(jobs, 6, async (i) => {
      if (budgetLeft <= 0) return;
      if (deadline && Date.now() > deadline) return;
      budgetLeft -= 1;
      rows[i] = await planTransit(
        amapKey,
        { lat: members[i].lat, lng: members[i].lng },
        { lat: poi.lat, lng: poi.lng },
        city
      );
    });

    transitMap.set(poi.id, rows);
  });

  const legsMap = new Map<string, MemberLeg[]>();
  for (const poi of targets) {
    const legs = members.map((m, i) =>
      clean(
        legOf(m, poi, driveMap.get(poi.id)?.[i], transitMap.get(poi.id)?.[i])
      )
    );
    legsMap.set(poi.id, legs);
  }

  return {
    legsMap,
    transitQueries: transitBudget - budgetLeft,
  };
}

/** 给 AI 看的候选清单：真实字段 + 每人怎么去 + 综合分 */
function formatRanked(
  candidates: AmapPoi[],
  ranking: CandidateScore[],
  legsMap: Map<string, MemberLeg[]>
): string {
  return ranking
    .map((r, i) => {
      const poi = candidates.find((c) => c.id === r.id);
      if (!poi) return "";
      const head = [
        `id=${poi.id}`,
        poi.name,
        poi.type || "类型未知",
        r.perCapita != null ? `人均 ${r.perCapita} 元` : "人均未知",
        poi.rating ? `评分 ${poi.rating}` : "评分未知",
        poi.openTime ? `营业 ${poi.openTime}` : "营业时间未知",
        poi.address ? `地址 ${poi.address}` : "",
      ]
        .filter(Boolean)
        .join(" | ");

      const legs = legsMap.get(poi.id) ?? [];
      const legLine = legs.length
        ? `   每人怎么去：${legs
            .map(
              (l) =>
                `${l.name} ${l.mode ? TRAVEL_LABEL[l.mode] : ""} ${fmtMin(
                  l.durationS
                )}${l.fareYuan != null ? ` ¥${l.fareYuan}` : ""}${
                  l.detail ? `（${l.detail}）` : ""
                }`
            )
            .join("；")}`
        : "   每人怎么去：未知";

      const fair = `   综合分 ${r.score}｜需求 ${r.parts.needs} 通勤 ${r.parts.travel} 均衡 ${r.parts.fairness} 花钱 ${r.parts.cost} 口碑 ${r.parts.quality}｜最远 ${r.worstName} ${r.worstMin ?? "?"} 分钟，平均 ${r.avgMin ?? "?"} 分钟，人均总花 ${r.totalPerPerson ?? "?"} 元`;
      const total = r.needStats.pass + r.needStats.conflict + r.needStats.unknown;
      const needLine = total
        ? `   需求核对：满足 ${r.needStats.pass} 条，违背 ${r.needStats.conflict} 条${
            r.conflicts.length ? `（${r.conflicts.join("、")}）` : ""
          }，数据判断不了 ${r.needStats.unknown} 条`
        : "";
      const rej = r.rejected ? `   已被硬性要求排除：${r.rejected}` : "";
      // 让 AI 知道这家「资料够不够下结论」，别把查不到资料的店当成优等生
      const blur = r.clear
        ? "   资料完整度：能逐条核对"
        : `   资料完整度：不足（${r.clearNote || "多项查不到"}）`;

      return `${i + 1}. ${head}\n${legLine}\n${fair}${
        needLine ? `\n${needLine}` : ""
      }\n${blur}${rej}`;
    })
    .filter(Boolean)
    .join("\n");
}

type Decision = {
  pickId: string;
  reason: string;
  matchPoints: string[];
  cautions: string[];
  /** AI 对语义类要求的逐条判定，key = `${candId}:${needId}` */
  checks: Map<string, { verdict: NeedVerdict; why: string }>;
};

async function decide(
  offered: AmapPoi[],
  ranking: CandidateScore[],
  legsMap: Map<string, MemberLeg[]>,
  ctx: {
    activityLabel: string;
    hardConstraints: string[];
    softWishes: string[];
    requirements: Requirement[];
    members: Member[];
    needs: Need[];
    pressure: MemberPressure[];
    budget: number | null;
    maxTravelMin: number | null;
    previousPickName?: string | null;
    avoidPickName?: string | null;
  },
  config: ApiConfig,
  timeoutMs?: number
): Promise<{ decision: Decision | null; model: string }> {
  // 只让 AI 判断数据判断不了的语义要求，能算的已经算完了
  const semantic = ctx.needs
    .filter((n) => n.checkable === "none")
    .slice(0, 8);
  const offer = offered.slice(0, 4);

  const system = `你是聚会方案的决策者。下面是高德实时检索到的真实地点，以及从群聊里**逐条拆出来**的要求（带提出者、强度、原话）。

分两步：先把语义要求逐条对到候选上，再选一家。

只输出 JSON，不要任何解释文字：
{"pickId":"候选id","reason":"60字以内","matchPoints":["..."],"cautions":["..."],"checks":[{"candId":"候选id","pass":["n1","n4"],"unknown":["n2"],"fail":{"n3":"12字内依据"}}]}

规则：
1. pickId 必须是候选里出现过的 id，严禁编造。
2. checks 只判「需要你判断的要求」（下面给了 needId 清单），**每个候选一条记录**，
   把这条要求清单里的 id 分到三个桶里：
   - pass：从候选的名称 / 类型 / 地址 / 人均 / 营业时间能看出满足
   - fail：能看出违背，值里写 12 字内依据（例如"A 怕黑"遇到密室主题、"别太辣"遇到川菜馆）
   - unknown：现有资料看不出来。**信息不足时必须放进 unknown，绝对不许猜。**"卫生好不好""会不会吵"这类没有数据，就是 unknown。
   三个桶里的 id 只能来自上面的 needId 清单，不许自造；判断不了就放 unknown。
3. 判 conflict 要保守：只有名称或类型能明确指向时才判，不要因为"可能"就打叉。
   **口味类要求（不能吃辣 / 清淡 / 不要香菜 / 不吃内脏）属于菜单级，没有菜单数据一律 unknown**
   —— 烧烤店可以点不辣的，火锅店有鸳鸯锅，只有店名/类型强指向（"麻辣烫""重庆老火锅"遇到"一点辣都不能吃"）才判 conflict。
   同理「别太吵」「干不干净」没有数据依据，只能 unknown。
4. 选店顺序：**任何一条 hard 要求被判 conflict 的候选都不选**；「资料完整度：不足」的候选只能进备选——除非所有候选资料都不足；再比 hard 要求满足的条数；最后才比综合分。
5. 权重意识：说"随便/都行"的方面权重低，不要为了迁就这种"随便"去牺牲别人的硬要求；hard 条数多的人优先照顾。注意同一个人在不同方面强度不同，别把"想吃火锅"和"怕黑"当成同等份量。
6. reason 必须引用真实数字和具体的人（如"小C 地铁3号线 5 站 56 分钟 ¥4""人均 68 元，在小A 的 80 元以内"），不许写候选里没有的信息。
7. matchPoints 2-4 条，每条点明「谁 + 哪条要求 + 靠什么满足」。
8. cautions 写仍不满足或判断不了的地方，点出具体是谁、哪一条；全满足就空数组。
9. ${ctx.previousPickName ? `上一版推荐的是「${ctx.previousPickName}」。这次换了就在 reason 里用一句话说清为什么换；没换就说清新条件下为什么还是它。` : "说清这家为什么比榜单后面的更合适。"}
10. ${ctx.avoidPickName ? `用户明确表示不想再去「${ctx.avoidPickName}」，**不要选它**，从第二名开始考虑。` : "按上面第 4 条的优先级考虑。"}
11. 不确定的店不要当首选：一家店如果关键要求（尤其是 hard）查不到，「能说清满足」的店哪怕分数低三五分也应该排前面，把查不到的那家写进 cautions 当备选。
12. 严格输出 JSON。`;

  const membersBlock = ctx.members
    .map((m) => {
      const press = ctx.pressure.find((p) => p.name === m.name);
      const bits = [
        m.constraints.length ? `不能接受：${m.constraints.join("、")}` : "",
        m.wishes.length ? `希望：${m.wishes.join("、")}` : "",
        press && press.top.length
          ? `最在意：${press.top
              .slice(0, 2)
              .map((t) => t.category)
              .join("、")}（硬性 ${press.hardCount} 条）`
          : "",
      ].filter(Boolean);
      const from = m.resolved ? `从${m.originName}出发` : "出发地未知（不要猜）";
      return `- ${m.name}（${from}）${bits.length ? `｜${bits.join("；")}` : ""}`;
    })
    .join("\n");

  const needBlock = ctx.needs
    .map(
      (n) =>
        `${n.id}｜${n.who || "全体"}｜${n.category}｜${n.strength}｜${
          n.polarity === "avoid" ? "不要" : "想要"
        }｜${n.text}｜原话「${n.quote}」`
    )
    .join("\n");

  const reqLine = ctx.requirements
    .map((r) => `${r.label}：${r.value}`)
    .join("；");

  const user = `活动：${ctx.activityLabel}
群聊要点：${reqLine}
人均预算上限：${ctx.budget ? `${ctx.budget} 元` : "未提"}
单程可接受时长：${ctx.maxTravelMin ? `${ctx.maxTravelMin} 分钟` : "未提"}
全体硬性条件：${ctx.hardConstraints.length ? ctx.hardConstraints.join("；") : "无"}
全体期望：${ctx.softWishes.length ? ctx.softWishes.join("；") : "无"}

参与的人（按要求权重从高到低）：
${membersBlock}

从群聊逐条拆出的要求（强度 hard=不能让步 / strong=强烈希望 / soft=随便）：
${needBlock || "无"}

需要你判断的语义要求（这些用商户数据算不出来）：${
    semantic.length ? semantic.map((n) => n.id).join("、") : "无"
  }
候选 id 清单：${offer.map((p) => `${p.id}（${p.name}）`).join("、")}

候选地点（已按综合分从高到低）：
${formatRanked(offered, ranking, legsMap)}`;

  const { text, model } = await callChat(
    config,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    // checks 用「每个候选一个对象」的紧凑格式，把 32 条判定压成 4 条记录；
    // 上限留 2000 足够，超了也是被截断成半截 JSON，整段降级成代码文案
    {
      json: true,
      thinking: false,
      maxTokens: 2000,
      // 同一条群聊要给出同一个结论，温度压到 0.2
      temperature: 0.2,
      timeoutMs,
    }
  );

  const parsed = parseJsonLoose(text);
  if (!parsed) return { decision: null, model };

  const checks = new Map<string, { verdict: NeedVerdict; why: string }>();
  const rawChecks = Array.isArray(parsed.checks) ? parsed.checks : [];
  const isNeed = (id: string) => semantic.some((n) => n.id === id);
  for (const item of rawChecks) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const candId = String(rec.candId ?? "").trim();
    if (!offer.some((p) => p.id === candId)) continue;

    // 新格式：一个候选一条记录，pass / unknown 是 id 数组，fail 是 {id: 依据}
    if (Array.isArray(rec.pass) || Array.isArray(rec.unknown) || rec.fail) {
      for (const id of strList(rec.pass, 20, 8)) {
        if (isNeed(id)) checks.set(`${candId}:${id}`, { verdict: "pass", why: "" });
      }
      for (const id of strList(rec.unknown, 20, 8)) {
        if (isNeed(id))
          checks.set(`${candId}:${id}`, { verdict: "unknown", why: "" });
      }
      const fail =
        rec.fail && typeof rec.fail === "object"
          ? (rec.fail as Record<string, unknown>)
          : {};
      for (const [id, why] of Object.entries(fail)) {
        if (!isNeed(id)) continue;
        checks.set(`${candId}:${id}`, {
          verdict: "conflict",
          why: String(why ?? "").trim().slice(0, 40),
        });
      }
      continue;
    }

    // 旧格式（一条一个判定）继续认，免得换提示词那一刻整段判定全丢
    const needId = String(rec.needId ?? "").trim();
    const verdict = String(rec.verdict ?? "").trim();
    if (!isNeed(needId)) continue;
    if (verdict !== "pass" && verdict !== "conflict" && verdict !== "unknown") {
      continue;
    }
    checks.set(`${candId}:${needId}`, {
      verdict,
      why: String(rec.why ?? "").trim().slice(0, 40),
    });
  }

  return {
    decision: {
      pickId: String(parsed.pickId ?? "").trim(),
      reason: String(parsed.reason ?? "").trim().slice(0, 240),
      matchPoints: strList(parsed.matchPoints, 4, 80),
      cautions: strList(parsed.cautions, 4, 80),
      checks,
    },
    model,
  };
}

/** 逐人规划真实路线，拿折线画到地图上 */
export async function buildRoutes(
  pick: { lat: number; lng: number },
  members: Member[],
  legs: MemberLeg[],
  amapKey: string,
  city: string
): Promise<MemberRoute[]> {
  const results = await mixLimit(
    members.map((m) => async () => {
      // 位置没确认的人不画线：那是城市中心的占位点，画出来等于编造路线
      if (!m.resolved) return null;
      const leg = legs.find((l) => l.name === m.name);
      const mode = leg?.mode ?? "driving";
      const from = { lat: m.lat, lng: m.lng };

      if (mode === "transit") {
        const t = await planTransit(amapKey, from, pick, city, true);
        if (t) {
          return {
            name: m.name,
            color: m.color,
            mode: "transit" as const,
            distanceM: t.distanceM,
            durationS: t.durationS,
            fareYuan: t.fareYuan,
            detail: t.summary,
            points: thin(t.points, 420),
          } satisfies MemberRoute;
        }
      }

      const route = await planRoute(amapKey, from, pick, mode === "walking" ? "walking" : "driving");
      if (!route) return null;

      return {
        name: m.name,
        color: m.color,
        mode: mode === "walking" ? ("walking" as const) : ("driving" as const),
        distanceM: route.distanceM,
        durationS: route.durationS,
        fareYuan: mode === "walking" ? 0 : taxiFare(route.distanceM),
        detail:
          mode === "walking"
            ? `步行 ${fmtKm(route.distanceM)}`
            : `打车约 ¥${taxiFare(route.distanceM)}`,
        points: thin(route.points, 420),
      } satisfies MemberRoute;
    }),
    4
  );

  return results.filter((r): r is MemberRoute => Boolean(r));
}

/** 折线太密会让响应变大，抽稀到上限以内，首尾必留 */
function thin(points: [number, number][], max: number): [number, number][] {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out = points.filter((_, i) => i % step === 0);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** 按并发上限跑一组任务（每个元素是一个已包装好的 thunk） */
async function mixLimit<R>(
  thunks: (() => Promise<R | null>)[],
  limit: number
): Promise<(R | null)[]> {
  const out = new Array<R | null>(thunks.length).fill(null);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, thunks.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= thunks.length) return;
      out[i] = await thunks[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

export type BuildPlanInput = {
  chat: string;
  defaultActivityId: ActivityId;
  /** 选了「其他」时用户自己补的那句话，选填 */
  customActivity?: string;
  /** 用户自己的出发点（可选）。没填就靠群聊里读到的出发地。 */
  origin: Origin | null;
  config: ApiConfig;
  amapKey: string;
  extraConstraints?: string[];
  /**
   * 用户这次亲手打的那句话。只有它算「新指令」：
   * 历史条件拿来当数字参考可以，但不能据此把某个人的私人上限推广成全体。
   */
  userMessage?: string;
  city?: string;
  memberOverrides?: MemberOverride[];
  /** 上一版推荐的名字，让 AI 说清「换没换、为什么」 */
  previousPickName?: string | null;
  /** 用户点名不想再去的那家 */
  avoidPickId?: string | null;
  /**
   * 上一版已经成立的要求。追问重排时带上，AI 这次漏列的条目会被接回来，
   * 免得「说了一条新要求，反而把原来三条要求弄丢了」。
   */
  previousNeeds?: Need[];
  /** 快速模式：跳过 AI 综合判断，只用评分排序 + 代码文案（线上限时兜底） */
  skipDecision?: boolean;
};

/** 从「候选 + 路程 + 评分」走到最终方案，两处入口（首次规划 / 只改位置）共用 */
async function finalize(input: {
  activityId: ActivityId;
  activityLabel: string;
  requirements: Requirement[];
  keywords: string[];
  hardConstraints: string[];
  softWishes: string[];
  budget: number | null;
  maxTravelMin: number | null;
  members: Member[];
  /** 逐条要求，来自 AI 抽取，带提出者/强度/原话 */
  needs: Need[];
  candidates: AmapPoi[];
  config: ApiConfig;
  amapKey: string;
  city: string;
  started: number;
  searchMode: string;
  radius: number;
  anchors: { name: string; lat: number; lng: number }[];
  previousPickName?: string | null;
  /** 用户点名要换掉的那家，AI 被禁止再选它 */
  avoidPickId?: string | null;
  /** 快速模式：跳过 AI 综合判断，只用评分排序 + 代码文案（线上限时兜底） */
  skipDecision?: boolean;
  /** 调用方传进来的耗时桶，各阶段往里写毫秒数 */
  timing?: Record<string, number>;
}): Promise<PlanResult> {
  const {
    candidates,
    members,
    needs,
    budget,
    maxTravelMin,
    amapKey,
    city,
    config,
  } = input;

  const pressure = pressureOf(needs, members);
  const ctx: ScoreCtx = {
    budget,
    maxTravelMin,
    needs,
    travelPressure: travelPressureOf(needs, members),
    unresolved: new Set(
      members.filter((m) => !m.resolved).map((m) => m.name)
    ),
  };

  const timeBudget = planBudgetMs();
  const timing = input.timing ?? {};
  const legsStart = Date.now();
  const { legsMap, transitQueries } = await attachLegs(
    candidates,
    members,
    amapKey,
    city,
    ctx,
    timeBudget ? input.started + timeBudget : 0
  );

  timing.legs = Date.now() - legsStart;

  // 第一轮只叠真实数据（人均、耗时、场所类型），语义要求先记 unknown
  const prelim = rankCandidates(candidates, legsMap, ctx);

  const usable = prelim.filter((r) => !r.rejected);
  const topIds = (usable.length >= 3 ? usable : prelim)
    .slice(0, 5)
    .map((r) => r.id);
  const offered = topIds
    .map((id) => candidates.find((c) => c.id === id))
    .filter((c): c is AmapPoi => Boolean(c));
  const offeredRanking = prelim.filter((r) => topIds.includes(r.id));

  // AI 只负责两件事：把语义要求逐条判一遍，然后在这几个头部候选里挑一个。
  // 调用失败不影响出结果，退化成「评分第一 + 机械理由」，避免一次超时整份方案全废。
  let decision: Decision | null = null;
  let decisionFallback = Boolean(input.skipDecision);
  const decideStart = Date.now();
  // 地铁查询有自己的软截止（timeBudget），但 AI 决策要留足时间：
  // 2.2 秒的下限会把还没写完的 JSON 掐断，结果反而退化成「评分第一」的机械文案。
  // 这里改成「整体硬顶 22 秒」——平台愿意等就让它说完，来不及就整段跳过。
  const hardCap = timeBudget ? 22000 : 0;
  const decideTimeout = hardCap
    ? hardCap - (Date.now() - input.started) - 500
    : undefined;
  try {
    if (input.skipDecision) throw new Error("fast-mode");
    if (decideTimeout != null && decideTimeout < 2800) {
      throw new Error("out-of-time");
    }
    const res = await decide(
      offered,
      offeredRanking,
      legsMap,
      {
        activityLabel: input.activityLabel,
        hardConstraints: input.hardConstraints,
        softWishes: input.softWishes,
        requirements: input.requirements,
        members,
        needs,
        pressure,
        budget,
        maxTravelMin,
        previousPickName: input.previousPickName ?? null,
        avoidPickName:
          candidates.find((c) => c.id === input.avoidPickId)?.name ?? null,
      },
      config,
      decideTimeout
    );
    decision = res.decision;
  } catch {
    decisionFallback = true;
  }
  timing.decide = Date.now() - decideStart;

  // 第二轮把 AI 的语义判定并回评分再排一次：同一家店，如果 AI 判出「小D 怕黑 → 密室主题」
  // 这种数据看不出来的冲突，分数会当场掉下来，榜单和结论就跟着变。
  const aiChecks = decision?.checks ?? new Map();
  const merged: ScoreCtx = { ...ctx, aiChecks };
  const ranking = aiChecks.size
    ? rankCandidates(candidates, legsMap, merged)
    : prelim;

  const hardConflictsOf = (poi: AmapPoi) =>
    checksOf(poi, legsMap.get(poi.id) ?? [], merged).filter(
      (c) => c.strength === "hard" && c.verdict === "conflict"
    );

  const rankOf = (id?: string | null) =>
    id ? ranking.find((r) => r.id === id) : undefined;

  // 首选只从「资料能说清」的店里出：查不到资料的店再好也只是备选，
  // 否则会出现「推荐了一家连有没有包厢都不知道的店」。
  const candidatesOk = ranking.filter((r) => !r.rejected);
  // 一家都满足不了的时候，按「踩得有多狠」挑伤得最轻的。
  // 之前是直接取综合分第一，于是会出现「小B 在家门口 0 分钟、小E 单程 103 分钟」这种：
  // 它恰好只踩了一条硬要求，就赢了「人人多跑一点但没人跑 100 分钟」的方案。
  const impossible = candidatesOk.length === 0;
  const leastBad = impossible
    ? [...ranking].sort(
        (a, b) => a.violation - b.violation || b.score - a.score
      )
    : [];
  const head =
    candidatesOk.find((r) => r.clear) ??
    candidatesOk[0] ??
    leastBad[0] ??
    ranking[0];
  const best = candidates.find((c) => c.id === head?.id);

  let chosen =
    (decision && offered.find((p) => p.id === decision.pickId)) || best || offered[0];

  // AI 选的这家如果踩了硬性要求、或者资料根本说不清，而榜首既没冲突又说得出依据，
  // 就按核对结果改选，并把原因写在理由里。
  let decisionNote: string | undefined;
  if (chosen && best && chosen.id !== best.id) {
    const mine = hardConflictsOf(chosen);
    const theirs = hardConflictsOf(best);
    const mineScore = rankOf(chosen.id);
    const bestScore = rankOf(best.id);

    const why: string[] = [];
    if (mine.length > theirs.length) {
      why.push(
        `踩了 ${mine
          .map((c) => `${c.who || "全体"}「${c.text}」`)
          .join("、")}`
      );
    }
    if (!mineScore?.clear && bestScore?.clear) {
      why.push(mineScore?.clearNote || "资料不全，判断不了");
    }
    // AI 有时会为了「更贴需求」挑一家让某个人多跑一大段的店。
    // 如果多跑的那段没有换来任何一条额外满足，就按人的体感改回榜首。
    const gap = (mineScore?.worstMin ?? 0) - (bestScore?.worstMin ?? 0);
    const gain =
      (mineScore?.needStats.pass ?? 0) - (bestScore?.needStats.pass ?? 0);
    if (gap >= 25 && gain <= 0) {
      why.push(
        `最远的人要多跑 ${Math.round(gap)} 分钟（${
          mineScore?.worstName || "某人"
        }），却没多满足任何一条要求`
      );
    }
    if (
      impossible &&
      (mineScore?.violation ?? 0) > (bestScore?.violation ?? 0) + 0.05
    ) {
      why.push("对硬性条件的偏离更大，大家都得跟着多跑");
    }
    if (why.length) {
      decisionNote = `AI 原本选的「${chosen.name}」${why.join("，")}，已改选「${best.name}」`;
      chosen = best;
    }
  }

  // 唯一一家「完全合规」的店，如果代价是让某个人跑一小时以上，
  // 而旁边有一家只在这一项上稍微超线、却能把最远的人压下来二十分钟以上，
  // 就取后者，并把代价写清楚。硬性条件不该变成「某个人被牺牲」的许可证。
  if (chosen && !impossible) {
    const cleanWorst = rankOf(chosen.id)?.worstMin ?? 0;
    if (cleanWorst >= 60) {
      const alt = [...ranking]
        .filter((r) => r.id !== chosen!.id && r.violation > 0 && r.violation <= 0.6)
        .sort((a, b) => (a.worstMin ?? 999) - (b.worstMin ?? 999))
        .find((r) => (r.worstMin ?? 999) <= cleanWorst - 20);
      const altPoi = alt ? candidates.find((c) => c.id === alt.id) : null;
      if (alt && altPoi) {
        // 只有真的超了上限才写「超出 N 分钟」；换过去之后没人超线，
        // 代价就是「个别要求得让步」，别再算出一个负数（-14 分钟很难看）
        const over =
          maxTravelMin != null &&
          alt.worstMin != null &&
          alt.worstMin > maxTravelMin
            ? ` ${Math.round(alt.worstMin - maxTravelMin)} 分钟`
            : "";
        const note = `严格按硬线只能选「${chosen.name}」，但那样 ${
          rankOf(chosen.id)?.worstName || "有人"
        } 要跑 ${cleanWorst} 分钟；换成「${altPoi.name}」后最远 ${
          alt.worstMin
        } 分钟，${
          over
            ? `代价是${alt.worstName || "有人"}超出原定上限${over}`
            : "代价是个别要求只能先让步"
        }`;
        // 直接覆盖：前面那条「AI 选 X 已改选 Y」已经被这次调换作废，
        // 两条并存会出现「改选大块……已换成小牛满满」自相矛盾的一段话。
        decisionNote = note;
        chosen = altPoi;
      }
    }
  }

  if (chosen && input.avoidPickId && chosen.id === input.avoidPickId) {
    // 用户说「换一家」：按分数榜往下取第一家没被排除、也没踩硬要求的，
    // 而不是按检索顺序随手抓一家（那家可能分数很低，换了还不如不换）。
    const alt =
      ranking.find((r) => r.id !== input.avoidPickId && !r.rejected) ??
      // 一家都没完全满足时，「换一家」也得真的换，不能原地不动
      leastBad.find((r) => r.id !== input.avoidPickId) ??
      ranking.find((r) => r.id !== input.avoidPickId);
    const altPoi = alt ? candidates.find((c) => c.id === alt.id) : null;
    if (altPoi) {
      decisionNote = `${decisionNote ? `${decisionNote}；` : ""}按你的要求换掉了「${
        chosen.name
      }」`;
      chosen = altPoi;
    }
  }
  if (!chosen) {
    throw new PlannerError("NO_CANDIDATE", "没有可用的候选地点");
  }

  const legs = legsMap.get(chosen.id) ?? [];
  const checks = checksOf(chosen, legs, merged);
  const overridden = Boolean(decisionNote);
  const chosenScore = rankOf(chosen.id);
  // 首选本身资料不全（全场都查不到）时，老实提示「先打电话确认」，
  // 别让用户以为这些要求已经被核实过了。
  const clarityCaution = chosenScore && !chosenScore.clear
    ? `${chosenScore.clearNote || "部分要求资料里查不到"}${
        chosen.tel ? `，建议先打 ${chosen.tel} 确认` : "，建议先打电话确认"
      }`
    : "";
  // 条件本身打架（有人要 40 分钟内、有人 19 点前必须到家，而大家隔着半座城）时，
  // 别假装挑到了完美解：说清冲突，让用户自己决定要不要放宽。
  // 首选靠牺牲某个人换来的时候，明说代价。
  // 「小B 在家门口 0 分钟、小E 单程 103 分钟」这种方案不该装作皆大欢喜。
  const sacrificeCaution = (() => {
    const far = (chosenScore?.worstMin ?? 0) >= 60 ? chosenScore?.worstName : "";
    if (!far) return "";
    const leg = legs.find((l) => l.name === far);
    const min = leg?.durationS != null ? Math.round(leg.durationS / 60) : null;
    if (min == null) return "";
    const own = needs.find(
      (n) => n.who === far && (n.category === "时间" || n.category === "距离")
    );
    const ownText = own ? `，而 ${far} 说过「${own.text}」` : "";
    return `${far} 到这家单程要 ${min} 分钟${ownText}，这一版是按其他条件换来的，建议先在群里问一句`;
  })();

  const tradeoffCaution =
    impossible && head?.rejected
      ? `这些条件没有一家能同时满足：${head.rejected}。下面是折中方案，真要去这家，建议先在群里确认一下`
      : "";
  // 冲突说明已经讲了「谁被牺牲」，就别再重复一遍；整体最多留 4 条，
  // 否则卡片上会堆一屏提示，用户反而不看。
  const cautions = (
    impossible
      ? [
          ...(overridden ? [] : (decision?.cautions ?? [])),
          tradeoffCaution,
          clarityCaution,
        ]
      : [
          ...(overridden ? [] : (decision?.cautions ?? [])),
          clarityCaution,
          sacrificeCaution,
        ]
  )
    .filter((c): c is string => Boolean(c))
    .slice(0, 4);
  const routes = await buildRoutes(
    { lat: chosen.lat, lng: chosen.lng },
    members,
    legs,
    amapKey,
    city
  );

  const fairness = (() => {
    const ds = legs
      .map((l) => l.distanceM)
      .filter((d): d is number => d != null && d > 0);
    if (!ds.length) return { maxDistanceM: null, avgDistanceM: null, spreadM: null };
    const max = Math.max(...ds);
    const min = Math.min(...ds);
    return {
      maxDistanceM: Math.round(max),
      avgDistanceM: Math.round(ds.reduce((a, b) => a + b, 0) / ds.length),
      spreadM: Math.round(max - min),
    };
  })();

  return {
    activityId: input.activityId,
    activityLabel: input.activityLabel,
    requirements: input.requirements,
    keywords: input.keywords,
    hardConstraints: input.hardConstraints,
    softWishes: input.softWishes,
    members,
    needs,
    pressure,
    candidates,
    budget,
    maxTravelMin,
    ranking,
    pick: {
      id: chosen.id,
      name: chosen.name,
      address: chosen.address,
      lat: chosen.lat,
      lng: chosen.lng,
      distance: chosen.distance,
      cost: chosen.cost,
      rating: chosen.rating,
      openTime: chosen.openTime,
      tel: chosen.tel,
      type: chosen.type,
      reason: overridden
        ? `按逐条核对改选：${decisionNote}`
        : decision?.reason ||
          `逐条核对后综合分第一：满足 ${
            checks.filter((c) => c.verdict === "pass").length
          } 条要求，人均 ${
            chosen.cost ? chosen.cost.replace(/\.0+$/, "") : "未知"
          } 元，评分 ${chosen.rating || "未知"}。`,
      matchPoints: overridden ? [] : (decision?.matchPoints ?? []),
      cautions,
      perMember: legs,
      checks,
      score: chosenScore ?? null,
      fairness,
    },
    routes,
    trace: {
      model: "",
      city: input.city,
      searchMode: input.searchMode,
      radius: input.radius,
      candidateCount: candidates.length,
      elapsedMs: Date.now() - input.started,
      anchors: input.anchors,
      transitQueries,
      decisionFallback,
      aiChecks: aiChecks.size,
      decisionNote,
      timing: { ...timing, total: Date.now() - input.started },
    },
  };
}

export async function buildPlan(input: BuildPlanInput): Promise<PlanResult> {
  const started = Date.now();
  const chat = (input.chat ?? "").trim().slice(0, MAX_CHAT);
  if (chat.length < 10) {
    throw new PlannerError("SHORT_CHAT", "群聊内容太短，至少 10 个字");
  }
  if (!input.amapKey.trim()) {
    throw new PlannerError(
      "NO_AMAP_KEY",
      "缺少高德 Web 服务 Key，无法检索真实地点"
    );
  }

  const timing: Record<string, number> = {};

  // 城市中心先按「地名兜底」猜一个，跟读群聊同时发出去：城市中心只用来兜底，
  // 猜错也只是多一次用不上的请求，比干等 AI 读完再发快 0.3 秒。
  const guessCity = input.city?.trim() || cityFromChat(chat) || "杭州";
  const centerEarly = input.origin
    ? null
    : cityCenter(input.amapKey, guessCity).catch(() => null);

  // 1) AI 读群聊：全体条件 + 每个人的说法 + 预算/通勤上限
  const hardBudget = planBudgetMs();
  const { data: ex, model } = await extract(
    chat,
    input.defaultActivityId,
    input.config,
    input.extraConstraints ?? [],
    input.customActivity ?? "",
    // 抽出群聊至少要 3 秒，剩下的时间留给定位、检索和决策
    hardBudget ? Math.max(3500, hardBudget - 3500) : undefined
  );

  timing.extract = Date.now() - started;

  // 1.1) 城市：调用方显式指定 > AI 从群聊判断 > 地标兜底 > 杭州
  //      以前写死杭州，粘一段成都的群聊会被拿去杭州搜店，位置全对不上。
  const city = input.city?.trim() || ex.city || cityFromChat(chat) || "杭州";

  // 1.5) 把「降预算 / 别超过 30 分钟」这类追加要求硬落到数字上。
  //      只靠 AI 写进 needs 太不稳，经常变成一句进不了打分的 hardConstraints。
  //      初次规划也顺手从 hardConstraints 里补一遍数字，防止 AI 忘填 budgetYuan。
  const pickTighter = (a: number | null, b: number | null) =>
    a == null ? b : b == null ? a : Math.min(a, b);
  const extraTighten = parseTighten(input.extraConstraints ?? []);
  // 用户这一次亲手打的那句话。之前把「上一版的条件」也一起解析，
  // 结果小B 的私人 40 分钟在第二次重排时被抬成了全体的 40 分钟。
  const typedTighten = parseTighten(input.userMessage ? [input.userMessage] : []);
  const hardTighten = parseTighten(ex.hardConstraints);
  let budget = pickTighter(ex.budget, pickTighter(extraTighten.budget, hardTighten.budget));
  let maxTravelMin = pickTighter(
    ex.maxTravelMin,
    pickTighter(extraTighten.maxTravelMin, hardTighten.maxTravelMin)
  );
  const tightenNotes = Array.from(
    new Set([...extraTighten.notes, ...hardTighten.notes])
  );
  const hardConstraints = dedupeNotes([
    ...ex.hardConstraints,
    ...tightenNotes,
  ]).slice(0, 7);
  // 重排时把上一版还没被推翻的要求接回来
  let needs = mergeNeeds(ex.needs, input.previousNeeds ?? []);

  // 用户新提的预算要改写 needs 里那条「人均 80」——否则核对表还按旧上限放行，
  // 榜单看起来就像完全没动。只认界面上追加的要求，别去改群聊里某人自己的预算。
  if (typedTighten.budget != null) {
    const target = typedTighten.budget;
    const quote = typedTighten.budgetText || `人均不超过 ${target} 元`;
    let touched = false;
    needs = needs.map((n) => {
      if (n.category !== "预算" || n.checkable !== "cost") return n;
      touched = true;
      return {
        ...n,
        who: "",
        value: target,
        text: `人均不超过 ${target} 元`,
        quote,
        strength: "hard" as const,
      };
    });
    if (!touched) {
      needs.push({
        id: `x${needs.length + 1}`,
        who: "",
        category: "预算",
        text: `人均不超过 ${target} 元`,
        quote,
        strength: "hard",
        polarity: "avoid",
        checkable: "cost",
        value: target,
      });
    }
  }
  if (typedTighten.maxTravelMin != null) {
    const target = typedTighten.maxTravelMin;
    // 「路上别超过 30 分钟」是对所有人说的，不是只对小B。
    // 之前只把已有的那条（小B 的 40 分钟）改成 30，其余人照旧放行，
    // 于是榜单上还能出现「小E 单程 104 分钟」。
    let touched = false;
    needs = needs.map((n) => {
      if (n.checkable !== "travel") return n;
      touched = true;
      return {
        ...n,
        who: "",
        value: target,
        text: `单程不超过 ${target} 分钟`,
        strength: "hard" as const,
      };
    });
    if (!touched) {
      needs.push({
        id: `x${needs.length + 1}`,
        who: "",
        category: "距离",
        text: `单程不超过 ${target} 分钟`,
        quote: extraTighten.travelText || `路上别超过 ${target} 分钟`,
        strength: "hard",
        polarity: "avoid",
        checkable: "travel",
        value: target,
      });
    }
  }
  // 用户主动放宽（「小B 40 分钟可以放宽到 60」）时，把那条数字真的抬上去，
  // 否则一句「可以放宽」在系统里毫无作用，方案还是原地锁死。
  const relax = parseRelax(input.userMessage ? [input.userMessage] : []);
  const raise = (
    kind: "travel" | "cost",
    target: number,
    who: string
  ): boolean => {
    let hit = false;
    needs = needs.map((n) => {
      if (n.checkable !== kind) return n;
      if (who && n.who !== who) return n;
      hit = true;
      const v = Math.max(n.value ?? 0, target);
      return {
        ...n,
        value: v,
        text:
          kind === "travel"
            ? `单程不超过 ${v} 分钟`
            : `人均不超过 ${v} 元`,
        strength: "hard" as const,
      };
    });
    return hit;
  };
  if (relax.travel != null) {
    const hit = raise("travel", relax.travel, relax.who);
    // 点名了谁就建在谁头上：AI 这一轮可能没把那条抽成「可判定」的要求，
    // 放宽不该因此落空。
    if (!hit) {
      needs.push({
        id: `x${needs.length + 1}`,
        who: relax.who,
        category: "距离",
        text: `单程不超过 ${relax.travel} 分钟`,
        quote: "放宽了路上的时间",
        strength: "hard",
        polarity: "avoid",
        checkable: "travel",
        value: relax.travel,
      });
    }
    if (!relax.who) {
      maxTravelMin =
        maxTravelMin == null ? relax.travel : Math.max(maxTravelMin, relax.travel);
    }
  }
  if (relax.budget != null) {
    const hit = raise("cost", relax.budget, relax.who);
    if (!hit) {
      needs.push({
        id: `x${needs.length + 1}`,
        who: relax.who,
        category: "预算",
        text: `人均不超过 ${relax.budget} 元`,
        quote: "放宽了预算",
        strength: "hard",
        polarity: "avoid",
        checkable: "cost",
        value: relax.budget,
      });
    }
    if (!relax.who) {
      budget = budget == null ? relax.budget : Math.max(budget, relax.budget);
    }
  }

  needs = dedupeNeeds(needs);
  // 收紧后的预算要写在界面上，否则用户只看到「说降了预算」但那一行数字没动
  const requirements = (() => {
    if (budget == null) return ex.requirements;
    const value = `人均不超过 ${budget} 元`;
    const idx = ex.requirements.findIndex((r) => r.label === "预算");
    if (idx < 0) return [{ label: "预算", value }, ...ex.requirements];
    if (ex.requirements[idx].value === value) return ex.requirements;
    return ex.requirements.map((r, i) => (i === idx ? { ...r, value } : r));
  })();

  // 2) 成员落点：AI 读到的出发地 + 原话兜底，都要过高德地理编码
  //    没有任何位置信息时才退回「用户自己的出发点」，再不行就用城市中心
  const memberStart = Date.now();
  const base =
    input.origin ??
    (city === guessCity
      ? (await centerEarly) ?? (await cityCenter(input.amapKey, city))
      : await cityCenter(input.amapKey, city));
  const members = await resolveMembers(
    ex.members,
    chat,
    input.amapKey,
    city,
    base,
    input.memberOverrides ?? []
  );

  // 用户自己填了出发点，但 AI 的成员表里未必有「我」这个人。
  // 这时要把「我」补成一个成员，否则自己在图上是空白的，通勤时间也不算自己的。
  // 已经有成员落在同一处（自己就是群里的小 A）就不重复添加。
  if (input.origin && input.origin.name.trim()) {
    const near = members.some(
      (m) => m.resolved && haversineM(m, input.origin as Origin) < 300
    );
    if (!near) {
      members.push({
        name: "我",
        originName: input.origin.name,
        lat: input.origin.lat,
        lng: input.origin.lng,
        constraints: [],
        wishes: [],
        color: memberColor(members.length),
        resolved: true,
        originSource: "override",
        originQuote: "",
        originAddress: "",
      });
    }
  }

  timing.members = Date.now() - memberStart;

  // 3) 围绕「成员中心 + 最远的那个人」检索，位置一改池子就跟着变
  const anchors = anchorsOf(members, base);
  const searchStart = Date.now();
  const { pois, mode } = await searchPois(input.amapKey, {
    keywords: ex.keywords,
    origin: { lat: anchors[0].lat, lng: anchors[0].lng },
    anchors,
    radius: ex.radius,
    perKeyword: 8,
    city,
  });

  timing.search = Date.now() - searchStart;

  if (!pois.length) {
    throw new PlannerError(
      "NO_CANDIDATE",
      `在「${ex.keywords.join("、")}」附近没有搜到相关地点`,
      "可以换个活动类型，或在群聊里写得更具体些"
    );
  }

  const plan = await finalize({
    activityId: ex.activityId,
    activityLabel: ex.activityLabel,
    requirements,
    keywords: ex.keywords,
    hardConstraints,
    softWishes: ex.softWishes,
    budget,
    maxTravelMin,
    members,
    needs,
    candidates: pickCandidates(pois, MAX_MEASURED, anchors),
    config: input.config,
    amapKey: input.amapKey,
    city,
    started,
    searchMode: mode,
    radius: ex.radius,
    anchors,
    previousPickName: input.previousPickName ?? null,
    avoidPickId: input.avoidPickId ?? null,
    skipDecision: input.skipDecision ?? false,
    timing,
  });

  return { ...plan, trace: { ...plan.trace, model } };
}

/**
 * 只改成员位置时走这条路：不重新读群聊、不重新定关键词，
 * 但**会按新位置重新检索一次候选池**——否则地点永远是那一批，改了位置推荐也不会变。
 */
export async function reroutePlan(input: {
  plan: PlanResult;
  memberOverrides: MemberOverride[];
  config: ApiConfig;
  amapKey: string;
  city?: string;
}): Promise<PlanResult> {
  const started = Date.now();
  const { plan, memberOverrides, config, amapKey } = input;
  // 重算沿用上一版认定的城市，别因为调用方没传就退回杭州
  const city = input.city?.trim() || plan.trace.city?.trim() || "杭州";

  if (!amapKey.trim()) {
    throw new PlannerError(
      "NO_AMAP_KEY",
      "缺少高德 Web 服务 Key，无法计算路程"
    );
  }

  const members: Member[] = plan.members.map((m) => {
    const o = memberOverrides.find((x) => x.name === m.name);
    if (!o || !Number.isFinite(o.lat) || !Number.isFinite(o.lng)) return m;
    return {
      ...m,
      originName: o.originName || "自定义位置",
      lat: o.lat,
      lng: o.lng,
      resolved: true,
      originSource: "override" as const,
      originAddress: "",
      originTried: undefined,
    };
  });

  // 检索锚点只认「位置已确认」的人；一个都没有就退回城市中心
  const seat = members.find((m) => m.resolved);
  const origin: Origin = seat
    ? { name: seat.originName, lat: seat.lat, lng: seat.lng }
    : await cityCenter(amapKey, city);
  const anchors = anchorsOf(members, origin);

  let candidates: AmapPoi[] = [];
  try {
    const { pois } = await searchPois(amapKey, {
      keywords: plan.keywords,
      origin: { lat: origin.lat, lng: origin.lng },
      anchors,
      radius: plan.trace.radius,
      perKeyword: 8,
      city,
    });
    candidates = pickCandidates(pois, MAX_MEASURED, anchors);
  } catch {
    candidates = [];
  }
  if (candidates.length < 3) candidates = plan.candidates.slice(0, MAX_MEASURED);
  if (!candidates.length) {
    throw new PlannerError("NO_CANDIDATE", "这个方案里没有可用的候选地点");
  }

  const next = await finalize({
    activityId: plan.activityId,
    activityLabel: plan.activityLabel,
    requirements: plan.requirements,
    keywords: plan.keywords,
    hardConstraints: plan.hardConstraints,
    softWishes: plan.softWishes,
    budget: plan.budget,
    maxTravelMin: plan.maxTravelMin,
    members,
    needs: plan.needs,
    candidates,
    config,
    amapKey,
    city,
    started,
    searchMode: plan.trace.searchMode,
    radius: plan.trace.radius,
    anchors,
    previousPickName: plan.pick?.name ?? null,
  });

  return { ...next, trace: { ...next.trace, model: plan.trace.model } };
}
