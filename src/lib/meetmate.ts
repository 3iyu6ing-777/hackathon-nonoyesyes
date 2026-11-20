import type { AmapPoi } from "./amap";

export type ActivityId =
  | "hiking"
  | "food"
  | "boardgame"
  | "cafe"
  | "escape"
  | "sports"
  | "shopping"
  | "movie";

export type Activity = {
  id: ActivityId;
  name: string;
  desc: string;
  supported: boolean;
  tint: string;
  icon: "mountain" | "food" | "dice" | "book" | "lock" | "ball" | "bag" | "film";
};

/**
 * 活动目录：只是「这件事属于哪一类」的选项列表，由用户自己挑，
 * 不参与任何推荐结论。推荐结果全部来自 AI + 高德实时检索。
 */
export const ACTIVITIES: Activity[] = [
  {
    id: "hiking",
    name: "徒步登山",
    desc: "户外走走，看山看水",
    supported: true,
    tint: "#1f3a2b",
    icon: "mountain",
  },
  {
    id: "food",
    name: "聚餐美食",
    desc: "火锅、烤肉、小馆子",
    supported: true,
    tint: "#3a241f",
    icon: "food",
  },
  {
    id: "boardgame",
    name: "桌游剧本",
    desc: "围一桌，动脑又热闹",
    supported: true,
    tint: "#2a2338",
    icon: "dice",
  },
  {
    id: "cafe",
    name: "咖啡书店",
    desc: "安静坐坐，聊天看书",
    supported: true,
    tint: "#332a1f",
    icon: "book",
  },
  {
    id: "escape",
    name: "密室逃脱",
    desc: "解谜闯关，考验配合",
    supported: true,
    tint: "#2b2b30",
    icon: "lock",
  },
  {
    id: "sports",
    name: "运动健身",
    desc: "羽毛球、攀岩、游泳",
    supported: true,
    tint: "#2b2b30",
    icon: "ball",
  },
  {
    id: "shopping",
    name: "逛街购物",
    desc: "商场、街区、小店",
    supported: true,
    tint: "#2b2b30",
    icon: "bag",
  },
  {
    id: "movie",
    name: "观影演出",
    desc: "电影、livehouse、展",
    supported: true,
    tint: "#2b2b30",
    icon: "film",
  },
];

/**
 * 一个落在地图上的位置。
 * 坐标一律 GCJ-02（高德坐标系），与高德瓦片、高德 POI 直接对齐，前端不做二次转换。
 * 注意：这里只定义结构，不再内置任何「校区/地名 → 坐标」的预设表——
 * 所有位置都必须来自群聊原话或用户输入，再经高德地理编码得到。
 */
export type Origin = { name: string; lat: number; lng: number };

export type RoomData = {
  id: string;
  activityId?: ActivityId;
  chat?: string;
  createdAt: number;
};

const KEY = (id: string) => `meetmate:room:${id}`;

export function createRoomId(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `MM${y}${m}${day}-${rand}`;
}

export function loadRoom(id: string): RoomData {
  if (typeof window === "undefined") return { id, createdAt: Date.now() };
  try {
    const raw = window.localStorage.getItem(KEY(id));
    if (!raw) return { id, createdAt: Date.now() };
    const parsed = JSON.parse(raw) as Partial<RoomData>;
    return { createdAt: Date.now(), ...parsed, id };
  } catch {
    return { id, createdAt: Date.now() };
  }
}

export function saveRoom(data: RoomData) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY(data.id), JSON.stringify(data));
  } catch {
    // 本地存储被禁用时静默失败，页面仍可继续使用
  }
}

export function parseRoomId(input: string): string | null {
  const match = input.match(/MM\d{8}-\d{4}/);
  return match ? match[0] : null;
}

export const SAMPLE_CHAT = `[群聊] 周末出去玩（4）

小A：这周六下午有人有空吗 想去哪玩
小B：我可以 但五点前得回来 晚上有事
小C：我下午两点以后都行
小D：我随便 别太远就行 晕车
小A：预算呢 我最近穷 人均别超过 80
小B：同穷 100 以内可以
小C：我想玩密室或者剧本杀 上次那个挺好
小D：密室有点怕 黑的 上次进去就想出来
小C：那桌游也行
小A：别爬山 上次爬完腿疼三天
小D：想拍照 最好有能逛的地方 顺便吃个饭
小B：吃饭别太辣 我胃不行
小C：那附近有吃的就行
小D：最好室内 万一下雨
小A：（周六天气预报：多云 18 度）
小B：那就室内为主吧 下午一点集合行吗
小C：可以 我从三墩出发
小B：我从滨江这边过去 大概半小时
小D：我在文三路实习 过去远吗
小A：我住西溪那边 骑车过去十几分钟`;

export type Requirement = { label: string; value: string };

export const REQUIREMENT_LABELS = [
  "活动",
  "时间",
  "预算",
  "成员",
  "禁忌",
  "偏好",
] as const;

/** 一条要求属于哪个方面。用来说明「谁对哪些方面更敏感」 */
export const NEED_CATEGORIES = [
  "预算",
  "时间",
  "距离",
  "交通",
  "环境",
  "饮食",
  "体力",
  "活动",
  "氛围",
  "其他",
] as const;

export type NeedCategory = (typeof NEED_CATEGORIES)[number];

/**
 * 要求的强度。这是「咬文嚼字」的落点：
 * hard = 明确不能接受 / 必须满足（不能、绝对、怕、晕、受不了、别）
 * strong = 明确希望（最好、尽量、想、希望）
 * soft = 可有可无（都行、随便、也可以、无所谓）
 */
export type NeedStrength = "hard" | "strong" | "soft";

export const NEED_STRENGTH_LABEL: Record<NeedStrength, string> = {
  hard: "硬性",
  strong: "强烈",
  soft: "随意",
};

/** 这条要求能不能用高德返回的字段直接判断，决定了它是「核对」还是「AI 判断」 */
export type NeedCheckability = "cost" | "travel" | "type" | "open" | "none";

/** 一个人的一条要求。一条 = 一个方面 + 一个方向（要 / 不要）+ 一句原话 */
export type Need = {
  id: string;
  /** 提出者姓名；空字符串表示全体共同的要求 */
  who: string;
  category: NeedCategory;
  /** 归一化后的一句话，列表里显示 */
  text: string;
  /** 群聊原话片段，必须照抄，用来证明不是编的 */
  quote: string;
  strength: NeedStrength;
  /** avoid = 不能接受；want = 想要 */
  polarity: "avoid" | "want";
  checkable: NeedCheckability;
  /** cost 时是元，travel 时是分钟 */
  value: number | null;
};

export type NeedVerdict = "pass" | "conflict" | "unknown";

/** 某条要求对某个候选地点的核对结果 */
export type NeedCheck = {
  needId: string;
  who: string;
  category: NeedCategory;
  text: string;
  quote: string;
  strength: NeedStrength;
  polarity: "avoid" | "want";
  verdict: NeedVerdict;
  /** 判断依据，必须来自真实字段或原话 */
  evidence: string;
  /** data = 用高德字段算的；ai = 语义判断 */
  source: "data" | "ai";
};

/** 谁的哪些方面要求更重，用于解释「这个方案在迁就谁」 */
export type MemberPressure = {
  name: string;
  color: string;
  /** 合计权重，越大说明这个人的要求越硬越多 */
  weight: number;
  /** 按权重排序的方面 */
  top: { category: NeedCategory; weight: number; count: number }[];
  /** 这个人的硬性要求条数 */
  hardCount: number;
};

/** 成员点配色：避开推荐点的绿色，保证同屏可分辨 */
export const MEMBER_COLORS = [
  "#60a5fa",
  "#f472b6",
  "#fbbf24",
  "#a78bfa",
  "#22d3ee",
  "#fb923c",
  "#fb7185",
  "#bef264",
];

export function memberColor(index: number) {
  return MEMBER_COLORS[index % MEMBER_COLORS.length];
}

/** 一位成员：自己的出发点 + 自己提的要求 */
export type Member = {
  name: string;
  originName: string;
  lat: number;
  lng: number;
  /** 只有这个人提出的限制，比如「五点前得走」「怕黑」 */
  constraints: string[];
  /** 只有这个人提出的期望，比如「想拍照」 */
  wishes: string[];
  color: string;
  /** 位置是否由群聊 + 地理编码确认；false 表示没读到出发地，界面上提示可手动改 */
  resolved: boolean;
  /** 出发地是怎么来的：原话里抓的 / AI 读的 / 用户手动改的 */
  originSource: "chat" | "ai" | "override" | "unknown";
  /** 支撑这个出发地的原话，方便核对 */
  originQuote: string;
  /** 高德实际解析到的地址，用来让人一眼看出「这个位置对不对」 */
  originAddress?: string;
  /** 没定位到时，试过哪些说法，界面上原样告诉用户 */
  originTried?: string;
};

export type TravelMode = "walking" | "driving" | "transit";

export const TRAVEL_LABEL: Record<TravelMode, string> = {
  walking: "步行",
  driving: "打车",
  transit: "地铁/公交",
};

/** 一种出行方式的具体方案，含时间与钱 */
export type TravelOption = {
  mode: TravelMode;
  durationS: number;
  distanceM: number;
  /** 单程车费：公交票价 / 打车估算 / 步行 0 */
  fareYuan: number;
  /** 「地铁3号线 12站 · 步行 2.0km」 */
  detail: string;
  /** 时间折算成钱 + 车费，越小越划算 */
  combinedCost: number;
};

/** 某个人到推荐地点的实际路线 */
export type MemberRoute = {
  name: string;
  color: string;
  mode: TravelMode;
  distanceM: number;
  durationS: number;
  fareYuan: number;
  detail: string;
  /** 折线点位，[lat, lng]，已是 GCJ-02 */
  points: [number, number][];
};

/**
 * 每个成员到某个候选地点的路程。
 * 这里给的是「按时间和钱综合算下来最划算的那一种」，另一种放在 alt 里做对比。
 */
export type MemberLeg = {
  name: string;
  color: string;
  distanceM: number | null;
  durationS: number | null;
  mode: TravelMode | null;
  fareYuan: number | null;
  combinedCost: number | null;
  detail: string;
  /** 另一种出行方式，用于「地铁 68 分钟 ¥5，打车 37 分钟 ¥65」这种对比 */
  alt: {
    mode: TravelMode;
    durationS: number;
    fareYuan: number;
    detail: string;
  } | null;
};

/** 一个候选地点的综合评分，排序和推荐都以它为准 */
export type CandidateScore = {
  id: string;
  name: string;
  /** 0-100 综合分 */
  score: number;
  parts: {
    /** 逐条需求核对后加权得到的匹配度（越高越贴大家的真实要求） */
    needs: number;
    /** 最远那个人要跑多久（越高越好） */
    travel: number;
    /** 大家路程是否均衡 */
    fairness: number;
    /** 人均消费是否在预算内 */
    cost: number;
    /** 商户评分与营业情况 */
    quality: number;
  };
  /** 需求核对计数：满足 / 违背 / 数据不足 */
  needStats: { pass: number; conflict: number; unknown: number };
  /** 资料够不够下结论：0-100，查不到的要求越多越低 */
  clarity: number;
  /** 有几条硬性要求因为资料不足，判断不了 */
  unknownHard: number;
  /** 资料是否足以支撑「选它」。false 的只进备选，不当首选 */
  clear: boolean;
  /** 资料不清楚时的一句话说明 */
  clearNote?: string;
  /** 最致命的两条违背，用于榜单上直接说明为什么排后面 */
  conflicts: string[];
  worstMin: number | null;
  worstName: string;
  avgMin: number | null;
  spreadMin: number | null;
  /** 人均消费 */
  perCapita: number | null;
  /** 人均 + 自己往返车费 */
  totalPerPerson: number | null;
  metroCount: number;
  /** 被硬性条件排除的原因，没有就是 null */
  rejected: string | null;
};

/** 一次完整规划的结果，全部字段都来自实时计算 */
export type PlanResult = {
  activityId: ActivityId;
  activityLabel: string;
  requirements: Requirement[];
  keywords: string[];
  hardConstraints: string[];
  softWishes: string[];
  members: Member[];
  /** 从群聊里逐条抠出来的要求，每条都带提出者、强度与原话 */
  needs: Need[];
  /** 谁在哪些方面要求更重 */
  pressure: MemberPressure[];
  candidates: AmapPoi[];
  /** 从群聊里读出来的预算上限（人均）与单程可接受时长 */
  budget: number | null;
  maxTravelMin: number | null;
  /** 按综合评分从高到低排好的榜单，推荐一定出自这里 */
  ranking: CandidateScore[];
  pick: {
    id: string;
    name: string;
    address: string;
    lat: number;
    lng: number;
    distance: number | null;
    cost: string;
    rating: string;
    openTime: string;
    tel: string;
    type: string;
    reason: string;
    matchPoints: string[];
    cautions: string[];
    /** 每个人到这个点的路程 */
    perMember: MemberLeg[];
    /** 逐条核对：这个地点满足了谁的要求、违背了谁的、哪些数据判断不了 */
    checks: NeedCheck[];
    /** 这个地点自己的综合评分 */
    score: CandidateScore | null;
    /** 公平性指标：最远的人跑多远、平均多远 */
    fairness: {
      maxDistanceM: number | null;
      avgDistanceM: number | null;
      spreadM: number | null;
    };
  } | null;
  /** 每个成员到推荐点的真实路线折线 */
  routes: MemberRoute[];
  trace: {
    model: string;
    searchMode: string;
    radius: number;
    candidateCount: number;
    elapsedMs: number;
    /** 这次围绕哪几个点搜的：成员中心 + 最远的那个人 */
    anchors: { name: string; lat: number; lng: number }[];
    transitQueries: number;
    /** AI 写理由失败时为 true，此时结论来自评分排序 */
    decisionFallback?: boolean;
    /** 需求核对里由 AI 语义判断的条数 */
    aiChecks: number;
    /** AI 选的那家踩了硬性要求、被代码改选时，这里说明原因 */
    decisionNote?: string;
  };
};
