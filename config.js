/* config.js
 * ============================================================================
 * 用户配置文件 —— 直播源聚合 Worker
 * ----------------------------------------------------------------------------
 * 本文件只存放"需要你改的东西"：直播源、推流节目、过滤词、分组规则、
 * 去重开关、规则远程加载地址等。引擎逻辑在 worker.js，通常无需修改。
 *
 * 【分组规则外部化】
 *   规则可按优先级从以下来源加载（靠前的优先）：
 *     1) KV 缓存命名空间中的键 regroup_rules（值为 JSON 数组）
 *     2) 远程 JSON：REGROUP_RULES_URL 指向一个返回规则数组的地址
 *     3) 本文件下方的 REGROUP_RULES（兜底默认值）
 *   规则格式：[{ group: "分组名", keywords: ["关键词1","关键词2"] }, ...]
 *
 * 【环境变量 / Secrets 覆盖（推荐生产使用）】
 *   通过 wrangler secret put <NAME> 设置后，会覆盖下方硬编码值：
 *     SOURCE_URLS          —— JSON 字符串，例如 '[{"url":"https://x/y.m3u","format":"m3u"}]'
 *     ENABLE_PROMO         —— "true" 开启推流注入（默认 true）
 *     DEDUP_BY_TITLE       —— "true" 开启按频道名去重（默认 false）
 *     REGROUP_RULES_URL    —— 远程规则 JSON 地址（可选）
 *     FALLBACK_LOGO_BASE   —— 频道 logo 兜底域名（默认 https://epg.112114.xyz/logo）
 *     KV_BINDING           —— KV Namespace 的变量名（默认 "KV"）
 * ============================================================================
 */

// ---- 直播源列表 -------------------------------------------------------------
// 每项: { url: "直播源地址", format?: "m3u" | "txt" }
//   format 省略时会按内容自动判断（含 #EXTM3U/#EXTINF 视为 m3u）
// 示例（取消注释并替换真实地址）:
const SOURCE_URLS = [
    // { url: "https://example.com/tv.m3u", format: "m3u" },
    // { url: "https://example.com/tv.txt",  format: "txt"  },
];

// ---- 推流 / 引流节目（置顶注入，保持原样） ---------------------------------
// 每项: { title, url, pic?, group?, from?, remarks? }
const PROMO_LIST = [
    // {
    //     title:   "宣传片1",
    //     url:     "https://example.com/promo1.mp4",
    //     pic:     "https://example.com/promo1.jpg",
    //     group:   "推流信息",
    //     from:    "1",
    //     remarks: "置顶引流",
    // },
];

// ---- 过滤关键词：频道 group 或 title 命中即丢弃 -----------------------------
const SPAM_KEYWORDS = [
    // "关键词1",
];

// ---- 重新分组规则（兜底默认值；可被 KV / 远程 JSON 覆盖） ------------------
// 格式：[{ group: "分组名", keywords: ["关键词", ...] }, ...]
// 匹配按数组顺序从上到下，命中第一个即归入对应分组
const REGROUP_RULES = [
    { group: "📺 央视",   keywords: ["CCTV", "央视", "中央", "CGTN"] },
    { group: "📡 卫视",   keywords: ["卫视", "湖南", "浙江", "江苏", "东方", "北京", "广东", "深圳", "安徽", "山东", "河南", "河北", "湖北", "湖南", "江西", "辽宁", "吉林", "黑龙江", "天津", "重庆", "四川", "贵州", "云南", "广西", "福建", "陕西", "甘肃", "青海", "宁夏", "新疆", "西藏", "内蒙古", "海南", "山西", "上海"] },
    { group: "🎬 影视",   keywords: ["电影", "电视剧", "影视", "院线", "影院", "大片", "动作", "喜剧", "恐怖", "科幻", "爱情", "战争", "纪录片", "动漫", "卡通", "动画"] },
    { group: "🏆 体育",   keywords: ["体育", "足球", "篮球", "NBA", "CBA", "英超", "西甲", "德甲", "意甲", "法甲", "欧冠", "中超", "网球", "乒乓球", "羽毛球", "搏击", "拳击", "格斗", "综合格斗", "UFC", "WW"] },
    { group: "📰 新闻",   keywords: ["新闻", "资讯", "时事", "财经", "经济", "凤凰", "环球", "焦点"] },
    { group: "🎵 音乐",   keywords: ["音乐", "MTV", "演唱会", "K歌", "卡拉OK"] },
    { group: "👶 少儿",   keywords: ["少儿", "儿童", "卡通", "动画", "亲子", "Baby", "Cartoon"] },
    { group: "🎮 游戏",   keywords: ["游戏", "电竞", "LOL", "DOTA", "王者", "吃鸡", "GAME"] },
    { group: "🍳 美食",   keywords: ["美食", "烹饪", "做饭", "菜谱", "小吃"] },
    { group: "🌍 国际",   keywords: ["国际", "美国", "英国", "日本", "韩国", "法国", "德国", "俄罗斯", "印度", "新加坡", "马来西亚", "泰国", "越南", "菲律宾", "印尼", "Arab", "Euro", "USA", "UK", "Japan", "Korea"] },
    { group: "📻 广播",   keywords: ["广播", "电台", "Radio", "FM", "AM"] },
    { group: "🔞 成人",   keywords: ["成人", "AV", "福利", "私密", "午夜", "深夜"] },
    { group: "🎭 综艺",   keywords: ["综艺", "娱乐", "选秀", "脱口秀", "真人秀", "访谈"] },
    { group: "📚 教育",   keywords: ["教育", "学习", "课堂", "培训", "英语", "留学", "知识"] },
    { group: "🏥 健康",   keywords: ["健康", "养生", "医疗", "中医", "健身", "瑜伽"] },
    { group: "🛒 购物",   keywords: ["购物", "电视购物", "拍卖", "导购", "QVC", "HSN"] },
    { group: "🎬 地方台", keywords: ["地方", "市县", "区县", "街道", "社区", "乡村", "农村"] },
    { group: "📺 港澳台", keywords: ["香港", "澳门", "台湾", "TVB", "亚视", "台视", "中视", "华视", "民视", "公视"] },
];

const DEFAULT_GROUP = "📺 其他频道";

// ---- 运行时常量（一般无需修改） -------------------------------------------
const RUNTIME = {
    CACHE_TTL_MS:          10 * 60 * 1000,
    KV_TTL_SECONDS:        600,
    KV_CACHE_KEY:          "all_channels_v1",
    KV_REGROUP_RULES_KEY:  "regroup_rules", // KV 中存放动态分组规则的键
    RULES_REMOTE_TIMEOUT_MS: 10 * 1000,     // 远程规则拉取超时
    RULES_CACHE_TTL_MS:    30 * 60 * 1000,  // 动态规则（远程/KV）内存缓存时长
    DEFAULT_PAGE_SIZE:     20,
    MAX_RETURN_LIMIT:       500,
    FETCH_TIMEOUT_MS:       15 * 1000,
    FALLBACK_LOGO_BASE:    "https://epg.112114.xyz/logo",
};

// ---- 读取环境变量覆盖（Secrets 优先） ---------------------------------------
function readEnvOverrides(env) {
    const out = {};
    if (!env) return out;
    if (typeof env.SOURCE_URLS === "string") {
        try { out.SOURCE_URLS = JSON.parse(env.SOURCE_URLS); } catch (e) { /* ignore */ }
    }
    if (typeof env.ENABLE_PROMO === "string") {
        out.ENABLE_PROMO = env.ENABLE_PROMO === "true";
    }
    // 去重开关：默认 false（保持向后兼容）
    if (typeof env.DEDUP_BY_TITLE === "string") {
        out.DEDUP_BY_TITLE = env.DEDUP_BY_TITLE === "true";
    }
    if (typeof env.REGROUP_RULES_URL === "string") {
        out.REGROUP_RULES_URL = env.REGROUP_RULES_URL;
    }
    if (typeof env.FALLBACK_LOGO_BASE === "string") {
        out.FALLBACK_LOGO_BASE = env.FALLBACK_LOGO_BASE;
    }
    if (typeof env.KV_BINDING === "string") {
        out.KV_BINDING = env.KV_BINDING;
    }
    return out;
}

// ---- 导出最终配置（引擎通过 import 获取） ---------------------------------
export function getConfig(env) {
    const overrides = readEnvOverrides(env);
    return {
        SOURCE_URLS:          overrides.SOURCE_URLS || SOURCE_URLS,
        PROMO_LIST:           (overrides.ENABLE_PROMO === false) ? [] : PROMO_LIST,
        SPAM_KEYWORDS,
        REGROUP_RULES,
        DEFAULT_GROUP,
        RUNTIME,
        KV_BINDING:          overrides.KV_BINDING || "KV",
        FALLBACK_LOGO_BASE:   overrides.FALLBACK_LOGO_BASE || RUNTIME.FALLBACK_LOGO_BASE,
        // 新增：去重开关（默认关闭，需显式开启）
        DEDUP_BY_TITLE:       overrides.DEDUP_BY_TITLE === true,
        // 新增：远程规则 JSON 地址（可选）
        REGROUP_RULES_URL:    overrides.REGROUP_RULES_URL || "",
    };
}
