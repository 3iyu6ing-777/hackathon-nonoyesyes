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
/** 其中前几名再补一次地铁/公交查询（这个接口只能单人单目的地，费配额） */
const PRELIM_FOR_TRANSIT = 10;
/** 单次规划最多发多少个公交查询，防止一个请求打爆配额 */
const MAX_TRANSIT_QUERIES = 40;
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

type Extracted = {
  activityId: ActivityId;
  activityLabel: string;
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

async function extract(
  chat: string,
  defaultActivityId: ActivityId,
  config: ApiConfig,
  extra: string[]
): Promise<{ data: Extracted; model: string }> {
  const defaultLabel =
    ACTIVITIES.find((a) => a.id === defaultActivityId)?.name ?? "待确认";

  const system = `你是聚会需求分析器。任务：**咬文嚼字**地读完这段群聊，把每个人自己提的要求逐条拆出来，并判断他有多在意。

只输出 JSON，不要任何解释文字：
{"activityId":"boardgame","requirements":[{"label":"时间","value":"周六下午"}],"searchKeywords":["密室逃脱","剧本杀"],"radius":5000,"budgetYuan":80,"maxTravelMin":40,"hardConstraints":["人均不超过80元"],"softWishes":["能拍照"],"members":[{"name":"小A","originHint":"西溪","originQuote":"我住西溪那边 骑车过去十几分钟"},{"name":"小D","originHint":"文三路","originQuote":"我在文三路实习 过去远吗"}],"needs":[{"who":"小B","category":"时间","text":"五点前必须回去","quote":"五点前得回来 晚上有事","strength":"hard","polarity":"avoid"},{"who":"小D","category":"交通","text":"晕车，别坐太久的车","quote":"我随便 别太远就行 晕车","strength":"hard","polarity":"avoid"}]}

规则：
1. activityId 只能取这 8 个之一：hiking(徒步登山)、food(聚餐美食)、boardgame(桌游剧本)、cafe(咖啡书店)、escape(密室逃脱)、sports(运动健身)、shopping(逛街购物)、movie(观影演出)。以群聊里明确说出的为准，没说就用默认值。
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
    { json: true, thinking: false, maxTokens: 2800 }
  );

  const parsed = parseJsonLoose(text);
  if (!parsed) {
    throw new PlannerError(
      "BAD_JSON",
      "AI 返回的内容不是合法 JSON",
      text.slice(0, 200)
    );
  }

  const activityId = normalizeActivity(parsed.activityId, defaultActivityId);
  const activityLabel =
    ACTIVITIES.find((a) => a.id === activityId)?.name ?? defaultLabel;

  const rawKeywords = strList(parsed.searchKeywords, 4, 12);
  const keywords = rawKeywords.length
    ? rawKeywords
    : FALLBACK_KEYWORDS[activityId];

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
 * 检索锚点：成员几何中心 + 离中心最远的那个人。
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

  let far = pts[0];
  let farD = -1;
  for (const m of pts) {
    const d = haversineM({ lat, lng }, m);
    if (d > farD) {
      farD = d;
      far = m;
    }
  }

  const label =
    farD < 600
      ? pts.length === 1
        ? pts[0].name
        : `${pts.length} 人所在区域`
      : `${pts.length} 人中心`;

  const out = [{ name: label, lat, lng }];
  if (farD >= 600) out.push({ name: far.name, lat: far.lat, lng: far.lng });
  return out;
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
    if (n.category !== "距离" && n.category !== "交通") continue;
    if (!n.who) continue;
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

      let hit: string | null = null;
      for (const hint of hintsOf(`${n.text} ${n.quote}`)) {
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
      return judged(
        n.polarity === "avoid" ? "pass" : "unknown",
        `类型「${poi.type || "未标"}」里没有「${n.text}」相关`
      );
    }

    // 时间类要求是行程约束，地点本身决定不了，别让它伪装成「这家店不满足」
    if (n.category === "时间" && n.checkable === "none") {
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

  const travel = worstW ? clamp01(1 - (worstW.w - 10) / 50) : 0.4;
  const fairness = spread == null ? 0.5 : clamp01(1 - spread / 40);
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

  // 权重：需求匹配 40% + 通勤 25% + 均衡 5% + 花钱 15% + 口碑 15%
  // 「需求匹配」是逐条核对后加权算出来的，改条件或改人，这一项立刻变。
  const score =
    (needSum.value * 0.4 +
      travel * 0.25 +
      fairness * 0.05 +
      costScore * 0.15 +
      quality * 0.15) *
    100 *
    (0.8 + 0.2 * clarity);

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
  };
}

/**
 * 从检索结果里挑出要实际测路程的候选。
 * 只取「离得最近的前几个」会全是评分很低的小店，所以混入评分最高的几家。
 */
export function pickCandidates(pois: AmapPoi[], limit: number): AmapPoi[] {
  const near = pois.slice(0, Math.max(1, limit - 3));
  const byRating = [...pois]
    .filter((p) => Number(p.rating) > 0)
    .sort((a, b) => Number(b.rating) - Number(a.rating))
    .slice(0, 4);
  const map = new Map<string, AmapPoi>();
  for (const p of near) map.set(p.id, p);
  for (const p of byRating) if (map.size < limit) map.set(p.id, p);
  return [...map.values()];
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
  ctx: ScoreCtx
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
  let budgetLeft = MAX_TRANSIT_QUERIES;

  await mapLimit(prelim, 5, async ({ poi }) => {
    const rows: (TransitResult | null)[] = new Array(members.length).fill(null);
    const jobs: number[] = [];
    members.forEach((m, i) => {
      if (haversineM(m, { lat: poi.lat, lng: poi.lng }) <= WALK_LIMIT_M) return;
      jobs.push(i);
    });

    await mapLimit(jobs, 4, async (i) => {
      if (budgetLeft <= 0) return;
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
    transitQueries: MAX_TRANSIT_QUERIES - budgetLeft,
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
  config: ApiConfig
): Promise<{ decision: Decision | null; model: string }> {
  // 只让 AI 判断数据判断不了的语义要求，能算的已经算完了
  const semantic = ctx.needs
    .filter((n) => n.checkable === "none")
    .slice(0, 8);
  const offer = offered.slice(0, 4);

  const system = `你是聚会方案的决策者。下面是高德实时检索到的真实地点，以及从群聊里**逐条拆出来**的要求（带提出者、强度、原话）。

分两步：先把语义要求逐条对到候选上，再选一家。

只输出 JSON，不要任何解释文字：
{"pickId":"候选id","reason":"60字以内","matchPoints":["..."],"cautions":["..."],"checks":[{"candId":"候选id","needId":"n3","verdict":"pass","why":"12字内依据"}]}

规则：
1. pickId 必须是候选里出现过的 id，严禁编造。
2. checks 只判「需要你判断的要求」（下面给了 needId 清单），每条 × 每个候选都要给一条：
   - pass：从候选的名称 / 类型 / 地址 / 人均 / 营业时间能看出满足
   - conflict：能看出违背（例如"A 怕黑"遇到密室主题、"别太辣"遇到川菜馆）
   - unknown：现有资料看不出来。**信息不足时必须返回 unknown，绝对不许猜。**"卫生好不好""会不会吵"这类没有数据，就是 unknown。
   - why 不超过 14 字，只写依据，不要复述要求。
3. 判 conflict 要保守：只有名称或类型能明确指向时才判，不要因为"可能"就打叉。
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
    { json: true, thinking: false, maxTokens: 2600 }
  );

  const parsed = parseJsonLoose(text);
  if (!parsed) return { decision: null, model };

  const checks = new Map<string, { verdict: NeedVerdict; why: string }>();
  const rawChecks = Array.isArray(parsed.checks) ? parsed.checks : [];
  for (const item of rawChecks) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const candId = String(rec.candId ?? "").trim();
    const needId = String(rec.needId ?? "").trim();
    const verdict = String(rec.verdict ?? "").trim();
    if (!offer.some((p) => p.id === candId)) continue;
    if (!semantic.some((n) => n.id === needId)) continue;
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
  /** 用户自己的出发点（可选）。没填就靠群聊里读到的出发地。 */
  origin: Origin | null;
  config: ApiConfig;
  amapKey: string;
  extraConstraints?: string[];
  city?: string;
  memberOverrides?: MemberOverride[];
  /** 上一版推荐的名字，让 AI 说清「换没换、为什么」 */
  previousPickName?: string | null;
  /** 用户点名不想再去的那家 */
  avoidPickId?: string | null;
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

  const { legsMap, transitQueries } = await attachLegs(
    candidates,
    members,
    amapKey,
    city,
    ctx
  );

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
  let decisionFallback = false;
  try {
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
      config
    );
    decision = res.decision;
  } catch {
    decisionFallback = true;
  }

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
  const head =
    candidatesOk.find((r) => r.clear) ?? candidatesOk[0] ?? ranking[0];
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
    if (why.length) {
      decisionNote = `AI 原本选的「${chosen.name}」${why.join("，")}，已改选「${best.name}」`;
      chosen = best;
    }
  }

  if (chosen && input.avoidPickId && chosen.id === input.avoidPickId) {
    const alt = candidates.find(
      (p) => p.id !== input.avoidPickId && ranking.some((r) => r.id === p.id && !r.rejected)
    );
    if (alt) chosen = alt;
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
          `逐条核对后综合分第一：满足 ${checks.filter((c) => c.verdict === "pass").length} 条要求，人均 ${
            chosen.cost || "未知"
          }，评分 ${chosen.rating || "未知"}。`,
      matchPoints: overridden ? [] : (decision?.matchPoints ?? []),
      cautions: [
        ...(overridden ? [] : (decision?.cautions ?? [])),
        ...(clarityCaution ? [clarityCaution] : []),
      ],
      perMember: legs,
      checks,
      score: chosenScore ?? null,
      fairness,
    },
    routes,
    trace: {
      model: "",
      searchMode: input.searchMode,
      radius: input.radius,
      candidateCount: candidates.length,
      elapsedMs: Date.now() - input.started,
      anchors: input.anchors,
      transitQueries,
      decisionFallback,
      aiChecks: aiChecks.size,
      decisionNote,
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
  const city = input.city?.trim() || "杭州";

  // 1) AI 读群聊：全体条件 + 每个人的说法 + 预算/通勤上限
  const { data: ex, model } = await extract(
    chat,
    input.defaultActivityId,
    input.config,
    input.extraConstraints ?? []
  );

  // 2) 成员落点：AI 读到的出发地 + 原话兜底，都要过高德地理编码
  //    没有任何位置信息时才退回「用户自己的出发点」，再不行就用城市中心
  const base = input.origin ?? (await cityCenter(input.amapKey, city));
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

  // 3) 围绕「成员中心 + 最远的那个人」检索，位置一改池子就跟着变
  const anchors = anchorsOf(members, base);
  const { pois, mode } = await searchPois(input.amapKey, {
    keywords: ex.keywords,
    origin: { lat: anchors[0].lat, lng: anchors[0].lng },
    anchors,
    radius: ex.radius,
    perKeyword: 8,
    city,
  });

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
    requirements: ex.requirements,
    keywords: ex.keywords,
    hardConstraints: ex.hardConstraints,
    softWishes: ex.softWishes,
    budget: ex.budget,
    maxTravelMin: ex.maxTravelMin,
    members,
    needs: ex.needs,
    candidates: pickCandidates(pois, MAX_MEASURED),
    config: input.config,
    amapKey: input.amapKey,
    city,
    started,
    searchMode: mode,
    radius: ex.radius,
    anchors,
    previousPickName: input.previousPickName ?? null,
    avoidPickId: input.avoidPickId ?? null,
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
  const city = input.city?.trim() || "杭州";

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
    candidates = pickCandidates(pois, MAX_MEASURED);
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
