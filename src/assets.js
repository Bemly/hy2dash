// 规则集 / geo 数据镜像。
//
// mihomo 的 rule-providers 与 geox-url 原本直连 jsdelivr / GitHub，国内可达性不稳；
// 这里把 14 个固定文件收敛到本 Worker，客户端只认一个域名。
//
// 只做白名单转发：上游地址写死在表里，绝不接受调用方传入 URL（否则就是一个开放代理）。
// 响应按文件名固定 Content-Type，边缘缓存 6 小时——最坏滞后 6h，换回源次数可忽略。

const UPSTREAM = {
  // geo 数据（MetaCubeX 每日滚动更新 latest）
  "geoip-lite.dat": "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip-lite.dat",
  "geosite.dat": "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat",
  "geoip.metadb": "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb",
  "GeoLite2-ASN.mmdb": "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb",
  // 规则集：文件名与模板里 rule-providers 的 path 一致
  "Steam.yaml": "https://github.com/blackmatrix7/ios_rule_script/raw/master/rule/Clash/Steam/Steam.yaml",
  "SteamCN.yaml": "https://github.com/blackmatrix7/ios_rule_script/raw/master/rule/Clash/SteamCN/SteamCN.yaml",
  "Google.yaml": "https://github.com/Loyalsoldier/clash-rules/raw/release/google.txt",
  "Apple.yaml": "https://github.com/blackmatrix7/ios_rule_script/raw/master/rule/Clash/Apple/Apple.yaml",
  "Microsoft.yaml": "https://github.com/blackmatrix7/ios_rule_script/raw/master/rule/Clash/Microsoft/Microsoft.yaml",
  "Notion.yaml": "https://github.com/blackmatrix7/ios_rule_script/raw/master/rule/Clash/Notion/Notion.yaml",
  "Spotify.yaml": "https://github.com/blackmatrix7/ios_rule_script/raw/master/rule/Clash/Spotify/Spotify.yaml",
  "Global.yaml": "https://github.com/blackmatrix7/ios_rule_script/raw/master/rule/Clash/Global/Global_Domain.yaml",
  "China.yaml": "https://github.com/blackmatrix7/ios_rule_script/raw/master/rule/Clash/China/China_Domain.yaml",
  "Youtube.yaml": "https://github.com/snapei/clash-pro-rules/raw/release/youtube.txt",
};

const TTL_SECONDS = 21600;

const CONTENT_TYPE = {
  ".yaml": "text/yaml; charset=utf-8",
  ".dat": "application/octet-stream",
  ".mmdb": "application/octet-stream",
};

function contentTypeOf(name) {
  const dot = name.lastIndexOf(".");
  return CONTENT_TYPE[dot < 0 ? "" : name.slice(dot)] || "application/octet-stream";
}

// path 已经由 worker.js 剥掉 BASE_PATH，形如 "/Steam.yaml"。
export function mirrorName(path) {
  const name = path.slice(1);
  return Object.hasOwn(UPSTREAM, name) ? name : null;
}

export async function serveMirror(ctx, name) {
  const { request, url } = ctx;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  // 缓存键去掉 query：避免 ?v=xxx 把边缘缓存打穿
  const key = new Request(new URL(url.pathname, url.origin).toString(), { method: "GET" });
  const cache = caches.default;
  const cached = await cache.match(key);
  if (cached) {
    const hit = new Response(cached.body, cached);
    hit.headers.set("X-Mirror", "hit");
    return hit;
  }
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: { "Content-Type": contentTypeOf(name) } });
  }

  let upstream;
  try {
    // github.com/.../raw/... 会 302 到 raw.githubusercontent.com，交给 fetch 跟随
    upstream = await fetch(UPSTREAM[name], { redirect: "follow" });
  } catch (e) {
    return new Response("upstream unreachable: " + (e && e.message ? e.message : e), {
      status: 502, headers: { "Cache-Control": "no-store" },
    });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response("upstream " + upstream.status, {
      status: 502, headers: { "Cache-Control": "no-store" },
    });
  }

  const res = new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentTypeOf(name),
      "Cache-Control": "public, max-age=" + TTL_SECONDS,
      "X-Mirror": "miss",
    },
  });
  // 8.6 MB 的 mmdb 用 clone 流式落缓存，不整体读进内存
  ctx.wait(cache.put(key, res.clone()).catch((e) => {
    console.warn("[mirror] cache put failed: " + name + " " + (e && e.message ? e.message : e));
  }));
  return res;
}
