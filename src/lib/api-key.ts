/**
 * 用户自带的 Key（BYOK）。
 * - AI Key：用于读懂群聊、挑选地点、生成解释
 * - 高德 Web 服务 Key：用于实时检索真实商户位置
 * 两者都只存在当前浏览器的 localStorage，随请求发给本站接口转发，
 * 服务端用完即弃，不写入任何存储、不落日志。
 */
export type ApiConfig = {
  key: string;
  baseUrl: string;
  model: string;
  amapKey: string;
};

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL = "deepseek-flash";

const K_KEY = "meetmate.ai.key";
const K_BASE = "meetmate.ai.baseUrl";
const K_MODEL = "meetmate.ai.model";
const K_AMAP = "meetmate.amap.key";

/** Key 变化时广播，页面据此更新按钮状态与提示 */
export const KEY_EVENT = "meetmate:keychange";
/** 请求打开设置面板（例如提示条上的「去配置」按钮） */
export const OPEN_EVENT = "meetmate:opensettings";

function read(name: string, fallback = "") {
  if (typeof window === "undefined") return fallback;
  try {
    return window.localStorage.getItem(name) ?? fallback;
  } catch {
    return fallback;
  }
}

export function loadApiConfig(): ApiConfig {
  return {
    key: read(K_KEY),
    baseUrl: read(K_BASE, DEFAULT_BASE_URL) || DEFAULT_BASE_URL,
    model: read(K_MODEL, DEFAULT_MODEL) || DEFAULT_MODEL,
    amapKey: read(K_AMAP),
  };
}

export function saveApiConfig(config: ApiConfig) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(K_KEY, config.key.trim());
    window.localStorage.setItem(K_BASE, config.baseUrl.trim() || DEFAULT_BASE_URL);
    window.localStorage.setItem(K_MODEL, config.model.trim() || DEFAULT_MODEL);
    window.localStorage.setItem(K_AMAP, (config.amapKey ?? "").trim());
  } catch {
    /* 隐私模式下可能写不进去，忽略 */
  }
  window.dispatchEvent(new Event(KEY_EVENT));
}

export function clearApiConfig() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(K_KEY);
    window.localStorage.removeItem(K_BASE);
    window.localStorage.removeItem(K_MODEL);
    window.localStorage.removeItem(K_AMAP);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(KEY_EVENT));
}

/** 只清 AI Key，保留高德 Key（两者来源不同，不该一起清） */
export function clearAiKey() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(K_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(KEY_EVENT));
}

export function hasApiKey() {
  return loadApiConfig().key.trim().length > 0;
}

/** 只显示前后几位，面板里不露出完整 Key */
export function maskKey(key: string) {
  const k = key.trim();
  if (!k) return "";
  if (k.length <= 10) return `${k.slice(0, 2)}••••`;
  return `${k.slice(0, 5)}••••${k.slice(-4)}`;
}

export function openSettings() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_EVENT));
}
