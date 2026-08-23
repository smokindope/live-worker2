/* worker.js
 * ============================================================================
 * 核心引擎 —— 直播源聚合 / 引流注入 / 重新分组 / 去重
 * ----------------------------------------------------------------------------
 * 配置从 ./config.js 读取。本文件通常无需修改。
 * 部署：配合 wrangler（见 wrangler.toml）。KV 为可选绑定，未绑定时不报错，
 *       每次请求实时抓取源（建议生产环境绑定 KV 以降低冷启动抓取开销）。
 *
 * 分组规则来源（优先级从高到低）：
 *   1) KV 键 regroup_rules（值为规则 JSON 数组）
 *   2) 远程 JSON（config.REGROUP_RULES_URL）
 *   3) config.REGROUP_RULES（本仓库兜底默认值）
 * ============================================================================
 */

import { getConfig } from "./config.js";

// ---------- 工具函数 ----------

function isValidHttpUrl(str) {
    if (!str || typeof str !== "string") return false;
    try {
        const u = new URL(str);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch {
        return false;
    }
}

function normalizeSource(src) {
    const url = typeof src === "string" ? src : (src && src.url) || "";
    return { url, format: src && src.format, _skip: !isValidHttpUrl(url) };
}

function isSpam(text, keywords) {
    return text && keywords.some(kw => text.includes(kw));
}

function extractAttr(line, key) {
    const re = new RegExp(
        key + '=(?:"([^"]+)"|\'([^\']+)\'|([^,\\s][^,]*?)(?=,\\s*\\w+=|$))'
    );
    const m = line.match(re);
    return m ? (m[1] || m[2] || m[3] || "").trim() : "";
}

async function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "*/*",
            },
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}

// 判断一个值是否为"有效的规则数组"
function isValidRules(arr) {
    return Array.isArray(arr) && arr.length > 0
        && arr.every(r => r && typeof r.group === "string" && Array.isArray(r.keywords));
}

// ---------- 分组规则动态加载（KV / 远程 JSON / 本地兜底） ----------

// 进程内规则缓存：避免每次请求都回源拉取动态规则
let rulesMemoryCache = { value: null, expireAt: 0 };

async function loadRulesFromKV(kv, key) {
    if (!kv) return null;
    try {
        const raw = await kv.get(key, { type: "json" });
        if (isValidRules(raw)) {
            console.log(`[loadRegroupRules] KV rules HIT (${raw.length} rules)`);
            return raw;
        }
    } catch (e) {
        console.error(`[loadRegroupRules] KV rules read error: ${e.message}`);
    }
    return null;
}

async function loadRulesFromRemote(url, timeoutMs) {
    if (!isValidHttpUrl(url)) return null;
    try {
        const resp = await fetchWithTimeout(url, timeoutMs);
        if (!resp.ok) {
            console.error(`[loadRegroupRules] Remote rules HTTP ${resp.status} for ${url}`);
            return null;
        }
        const data = await resp.json();
        if (isValidRules(data)) {
            console.log(`[loadRegroupRules] Remote rules HIT (${data.length} rules) from ${url}`);
            return data;
        }
        console.error(`[loadRegroupRules] Remote rules invalid format from ${url}`);
    } catch (e) {
        console.error(`[loadRegroupRules] Remote rules fetch error: ${e.message}`);
    }
    return null;
}

/**
 * 加载分组规则：KV → 远程 JSON → 本地兜底。
 * 命中动态来源时写入进程内缓存（受 RULES_CACHE_TTL_MS 控制）。
 */
export async function loadRegroupRules(env, cfg) {
    const now = Date.now();
    if (rulesMemoryCache.value && rulesMemoryCache.expireAt > now) {
        return rulesMemoryCache.value;
    }

    const kv = getKVNamespace(env, cfg);
    const fromKV = await loadRulesFromKV(kv, cfg.RUNTIME.KV_REGROUP_RULES_KEY);
    if (fromKV) {
        rulesMemoryCache = { value: fromKV, expireAt: now + cfg.RUNTIME.RULES_CACHE_TTL_MS };
        return fromKV;
    }

    const fromRemote = await loadRulesFromRemote(
        cfg.REGROUP_RULES_URL, cfg.RUNTIME.RULES_REMOTE_TIMEOUT_MS
    );
    if (fromRemote) {
        rulesMemoryCache = { value: fromRemote, expireAt: now + cfg.RUNTIME.RULES_CACHE_TTL_MS };
        return fromRemote;
    }

    console.log(`[loadRegroupRules] Using built-in fallback rules (${cfg.REGROUP_RULES.length} rules)`);
    // 兜底：不缓存本地规则（允许热更新 config.js 修改立即生效）
    return cfg.REGROUP_RULES;
}

// ---------- 重新分组核心逻辑 ----------

function matchGroup(title, rules, defaultGroup) {
    if (!title) return defaultGroup;
    for (const rule of rules) {
        for (const kw of rule.keywords) {
            if (title.includes(kw)) return rule.group;
        }
    }
    return defaultGroup;
}

function regroupChannels(channels, rules, defaultGroup) {
    return channels.map(ch => ({
        ...ch,
        orig_group: ch.group,
        group: matchGroup(ch.title, rules, defaultGroup),
    }));
}

// ---------- 按频道名去重 ----------

/**
 * 按频道名（title）去重：保留首次出现的条目，后续同名频道的备用地址
 * 合并进首个条目的 urls 数组（避免丢失源地址），分组取首个。
 * 推流节目（PROMO_LIST）不参与去重。
 */
export function dedupByTitle(channels) {
    const seen = new Map(); // title(小写) -> channel
    const out = [];
    for (const ch of channels) {
        const key = (ch.title || "").trim().toLowerCase();
        if (!key) { out.push(ch); continue; }
        const exist = seen.get(key);
        if (!exist) {
            seen.set(key, ch);
            out.push(ch);
        } else {
            // 合并备用地址：把后续同名的 urls 追加到首个条目
            const extra = (ch.urls && ch.urls.length ? ch.urls : [ch.url]).filter(Boolean);
            const base = exist.urls && exist.urls.length ? exist.urls : [exist.url];
            for (const u of extra) {
                if (!base.includes(u)) base.push(u);
            }
            exist.urls = base;
            exist.url = base[0];
        }
    }
    return out;
}

// ---------- 解析器 ----------

function parseM3U(text, cfg) {
    const list = [];
    let current = null;
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("#EXTINF")) {
            const group = extractAttr(trimmed, "group-title") || "默认频道";
            let logo = extractAttr(trimmed, "tvg-logo");
            const commaIdx = trimmed.lastIndexOf(",");
            const title = commaIdx > -1 ? trimmed.substring(commaIdx + 1).trim() : "未知频道";
            if (!logo) logo = `${cfg.FALLBACK_LOGO_BASE}/${encodeURIComponent(title)}.png`;
            current = { group, logo, title };
        } else if (trimmed.startsWith("#")) {
            continue;
        } else if (current) {
            const urls = trimmed.split(",").map(s => s.trim()).filter(Boolean);
            if (urls.length > 0) {
                const channel = { ...current, url: urls[0], urls };
                if (!isSpam(channel.group, cfg.SPAM_KEYWORDS) && !isSpam(channel.title, cfg.SPAM_KEYWORDS)) {
                    list.push(channel);
                }
            }
            current = null;
        }
    }
    return list;
}

function parseTXT(text, cfg) {
    const list = [];
    let currentGroup = "默认频道";
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        if (/,#genre#\s*$/i.test(line)) {
            currentGroup = line.split(",")[0].trim() || "默认频道";
            continue;
        }
        const commaIdx = line.indexOf(",");
        if (commaIdx < 0) continue;
        const title = line.substring(0, commaIdx).trim();
        let urlPart = line.substring(commaIdx + 1).trim();
        if (!title || !urlPart) continue;
        const hashIdx = urlPart.indexOf("#");
        if (hashIdx !== -1 && urlPart.substring(hashIdx + 1).trim()) {
            urlPart = urlPart.substring(0, hashIdx).trim();
        }
        if (!urlPart || isSpam(currentGroup, cfg.SPAM_KEYWORDS) || isSpam(title, cfg.SPAM_KEYWORDS)) continue;
        list.push({
            group: currentGroup,
            title,
            logo: `${cfg.FALLBACK_LOGO_BASE}/${encodeURIComponent(title)}.png`,
            url: urlPart,
            urls: [urlPart],
        });
    }
    return list;
}

function parseSource(text, formatHint, cfg) {
    const isM3U = formatHint === "m3u"
        ? true
        : formatHint === "txt"
            ? false
            : text.includes("#EXTM3U") || text.includes("#EXTINF");
    return isM3U ? parseM3U(text, cfg) : parseTXT(text, cfg);
}

// ---------- 抓取与合并（KV 缓存可选）----------

async function fetchOneSource(srcConfig, cfg) {
    const { url, format, _skip } = normalizeSource(srcConfig);
    if (_skip) {
        console.error(`[fetchOneSource] 跳过无效 URL: ${url || "(empty)"}`);
        return { source: url || "(invalid)", channels: [], error: "Invalid URL" };
    }
    try {
        const resp = await fetchWithTimeout(url, cfg.RUNTIME.FETCH_TIMEOUT_MS);
        if (!resp.ok) {
            console.error(`[fetchOneSource] HTTP ${resp.status} for ${url}`);
            return { source: url, channels: [], error: `HTTP ${resp.status}` };
        }
        const text = await resp.text();
        if (!text || !text.trim()) {
            console.error(`[fetchOneSource] Empty body from ${url}`);
            return { source: url, channels: [], error: "Empty body" };
        }
        const channels = parseSource(text, format, cfg);
        console.log(`[fetchOneSource] ${url} -> ${channels.length} channels`);
        return { source: url, channels, error: null };
    } catch (err) {
        console.error(`[fetchOneSource] ${url} -> ${err.message}`);
        return { source: url, channels: [], error: err.message };
    }
}

// 获取 KV 命名空间对象（可选；无绑定返回 null，不报错）
function getKVNamespace(env, cfg) {
    if (!env) return null;
    const ns = env[cfg.KV_BINDING];
    return ns && typeof ns.get === "function" ? ns : null;
}

async function loadAllChannels(env, ctx) {
    const cfg = getConfig(env);

    // 1. 尝试 KV 读取频道缓存（若未绑定则跳过，不报错）
    const kv = getKVNamespace(env, cfg);
    if (kv) {
        try {
            const cached = await kv.get(cfg.RUNTIME.KV_CACHE_KEY, { type: "json" });
            if (cached && cached.expireAt > Date.now()) {
                console.log(`[loadAllChannels] KV cache HIT, ${cached.channels.length} channels`);
                return cached.channels;
            }
            if (cached) console.log(`[loadAllChannels] KV cache EXPIRED, re-fetching`);
            else        console.log(`[loadAllChannels] KV cache MISS`);
        } catch (e) {
            console.error(`[loadAllChannels] KV read error: ${e.message}`);
        }
    } else {
        console.log(`[loadAllChannels] No KV binding ("${cfg.KV_BINDING}") found, fetching directly`);
    }

    // 2. 抓取所有源
    const results = await Promise.all(cfg.SOURCE_URLS.map(u => fetchOneSource(u, cfg)));
    const successCount = results.filter(r => r.error === null).length;
    const totalChannels = results.reduce((sum, r) => sum + r.channels.length, 0);
    console.log(`[loadAllChannels] ${successCount}/${results.length} sources OK, ${totalChannels} channels`);

    let merged = [];
    for (const result of results) {
        for (const ch of result.channels) merged.push({ ...ch });
    }

    // 3. 按频道名去重（开关默认关闭，需显式开启）
    if (cfg.DEDUP_BY_TITLE) {
        const before = merged.length;
        merged = dedupByTitle(merged);
        console.log(`[loadAllChannels] dedup by title: ${before} -> ${merged.length}`);
    }

    // 4. 加载分组规则并重新分组
    const rules = await loadRegroupRules(env, cfg);
    const regrouped = regroupChannels(merged, rules, cfg.DEFAULT_GROUP);
    console.log(`[loadAllChannels] ${merged.length} merged, ${regrouped.length} after regroup`);

    // 5. 异步写回 KV（有绑定才写；失败仅记录，不影响返回）
    const writeKV = async () => {
        if (!kv) return;
        try {
            const cacheData = {
                channels: regrouped,
                expireAt: Date.now() + cfg.RUNTIME.CACHE_TTL_MS,
            };
            await kv.put(cfg.RUNTIME.KV_CACHE_KEY, JSON.stringify(cacheData), {
                expirationTtl: cfg.RUNTIME.KV_TTL_SECONDS,
            });
            console.log(`[loadAllChannels] KV cache written, ${regrouped.length} channels`);
        } catch (e) {
            console.error(`[loadAllChannels] KV write error: ${e.message}`);
        }
    };
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(writeKV());
    else await writeKV();

    return regrouped;
}

// ---------- Vod 构造 ----------

function buildPromoVods(cfg) {
    return cfg.PROMO_LIST.map((p, idx) => ({
        vod_id:        `live_promo_${idx}`,
        vod_name:      p.title,
        vod_pic:       p.pic || "",
        vod_remarks:   p.remarks || "引流",
        vod_play_from: p.from || "推广线路",
        vod_play_url:  `${p.title}$${p.url}`,
        type_name:     p.group || "推流信息",
    }));
}

function channelToVod(ch, idx) {
    const playUrl = ch.urls && ch.urls.length > 1
        ? `${ch.title}$${ch.urls.join("#")}`
        : `${ch.title}$${ch.url}`;
    return {
        vod_id:        `ch_${idx}`,
        vod_name:      ch.title,
        vod_pic:       ch.logo,
        vod_remarks:   "直播",
        vod_play_from: ch.group,
        vod_play_url:  playUrl,
        type_name:     ch.group,
    };
}

// ---------- 响应构造 ----------

function buildHomeResponse(channels, cfg) {
    const groupMap = new Map();
    channels.forEach((ch, i) => {
        if (!groupMap.has(ch.group)) groupMap.set(ch.group, []);
        groupMap.get(ch.group).push({ ch, i });
    });
    const promoGroups = Array.from(new Set(cfg.PROMO_LIST.map(p => p.group || "推流信息")));
    const otherGroups = Array.from(groupMap.keys())
        .filter(g => !promoGroups.includes(g))
        .sort();
    const allGroups = [...promoGroups, ...otherGroups];
    const class_list = allGroups.map(g => ({ type_id: g, type_name: g }));

    const promoVods = buildPromoVods(cfg);
    const groupVods = [];
    for (const g of otherGroups) {
        const items = (groupMap.get(g) || []).slice(0, 5);
        for (const { ch, i } of items) groupVods.push(channelToVod(ch, i));
    }
    return { class: class_list, list: [...promoVods, ...groupVods] };
}

function buildCategoryResponse(channels, typeId, page, pageSize, cfg) {
    if (!typeId) {
        return { page: 1, pagecount: 1, limit: pageSize, total: 0, list: [], notice: "typeId (参数 t) 不能为空" };
    }
    const promoGroups = new Set(cfg.PROMO_LIST.map(p => p.group || "推流信息"));
    const list = [];
    if (promoGroups.has(typeId)) {
        list.push(...buildPromoVods(cfg).filter(v => v.type_name === typeId));
    }
    channels.forEach((ch, i) => {
        if (ch.group === typeId) list.push(channelToVod(ch, i));
    });
    const total = Math.min(list.length, cfg.RUNTIME.MAX_RETURN_LIMIT);
    const totalPage = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPage);
    const start = (safePage - 1) * pageSize;
    return {
        page: safePage, pagecount: totalPage, limit: pageSize, total,
        list: list.slice(start, start + pageSize),
    };
}

function buildDetailResponse(channels, ids, cfg) {
    const idSet = new Set(ids);
    const list = [];
    for (const v of buildPromoVods(cfg)) {
        if (idSet.has(v.vod_id)) list.push(v);
    }
    channels.forEach((ch, i) => {
        if (idSet.has(`ch_${i}`)) list.push(channelToVod(ch, i));
    });
    return { list };
}

function buildM3U(channels, cfg) {
    const lines = ["#EXTM3U"];
    for (const p of cfg.PROMO_LIST) {
        lines.push(`#EXTINF:-1 tvg-logo="${p.pic || ""}" group-title="${p.group || "推流信息"}",${p.title}`);
        lines.push(p.url);
    }
    for (const ch of channels) {
        lines.push(`#EXTINF:-1 tvg-logo="${ch.logo}" group-title="${ch.group}",${ch.title}`);
        lines.push(ch.urls && ch.urls.length > 1 ? ch.urls.join(",") : ch.url);
    }
    return lines.join("\n");
}

function buildTXT(channels, cfg) {
    const groupMap = new Map();
    for (const p of cfg.PROMO_LIST) {
        const g = p.group || "推流信息";
        if (!groupMap.has(g)) groupMap.set(g, []);
        groupMap.get(g).push({ title: p.title, url: p.url });
    }
    for (const ch of channels) {
        if (!groupMap.has(ch.group)) groupMap.set(ch.group, []);
        const u = ch.urls && ch.urls.length > 0 ? ch.urls[0] : ch.url;
        groupMap.get(ch.group).push({ title: ch.title, url: u });
    }
    const promoGroups = new Set(cfg.PROMO_LIST.map(p => p.group || "推流信息"));
    const groupOrder = [
        ...Array.from(promoGroups),
        ...Array.from(groupMap.keys()).filter(g => !promoGroups.has(g)).sort(),
    ];
    const out = [];
    for (const group of groupOrder) {
        const items = groupMap.get(group) || [];
        if (items.length === 0) continue;
        out.push(`${group},#genre#`);
        for (const it of items) out.push(`${it.title},${it.url}`);
        out.push("");
    }
    return out.join("\n");
}

// ---------- 主入口 ----------

const corsHeaders = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
};

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    });
}

export default {
    async fetch(request, env, ctx) {
        const cfg = getConfig(env);
        const url = new URL(request.url);
        const path = url.pathname;
        const params = url.searchParams;

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        try {
            const channels = await loadAllChannels(env, ctx);

            if (path === "/m3u" || path === "/live.m3u") {
                return new Response(buildM3U(channels, cfg), {
                    headers: { ...corsHeaders, "Content-Type": "audio/x-mpegurl; charset=utf-8" },
                });
            }
            if (path === "/txt" || path === "/live.txt") {
                return new Response(buildTXT(channels, cfg), {
                    headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
                });
            }

            const ac = params.get("ac");
            if (ac === "detail") {
                const ids = (params.get("ids") || "").split(",").filter(Boolean);
                return jsonResponse(buildDetailResponse(channels, ids, cfg));
            }
            if (ac === "list" || params.has("t")) {
                const typeId = params.get("t") || "";
                const page = parseInt(params.get("pg") || "1", 10) || 1;
                const size = parseInt(params.get("limit") || String(cfg.RUNTIME.DEFAULT_PAGE_SIZE), 10) || cfg.RUNTIME.DEFAULT_PAGE_SIZE;
                return jsonResponse(buildCategoryResponse(channels, typeId, page, size, cfg));
            }
            return jsonResponse(buildHomeResponse(channels, cfg));
        } catch (err) {
            console.error(`[fetch] Unhandled error: ${err.message}`);
            return jsonResponse({ error: true, message: err.message || String(err) }, 500);
        }
    },
};
