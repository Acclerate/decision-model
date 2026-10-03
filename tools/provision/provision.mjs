#!/usr/bin/env node
/**
 * AK/SK 自动接入百炼 Decision Model（ModelStudio OpenAPI，ACS3 签名由官方 SDK 处理）。
 *
 * 流程：
 *   1. 从 CSV 读取 AccessKey（--csv，默认 D:/Documents/aliyun/aliyun_AccessKey.csv）
 *   2. ListWorkspaces 发现业务空间（--workspace-id 可指定；默认取第一个）
 *   3. ListApiKeys 找可用 Key；没有可复用的才 CreateApiKey（幂等友好）
 *   4. 凭据写入 tools/provision/credentials.local.json；stdout 只输出打码摘要
 *
 * 用法：node provision.mjs [--csv <path>] [--workspace-id <id>] [--region cn-beijing]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const csvPath = argOf("--csv", "D:/Documents/aliyun/aliyun_AccessKey.csv");
const regionId = argOf("--region", "cn-beijing");
const preferWorkspace = argOf("--workspace-id", null);

const mask = (s) => (s ? `${s.slice(0, 4)}****${s.slice(-4)}` : "");
const log = (...a) => console.error("[provision]", ...a);

// 1. 解析 CSV：找包含 LTAI 开头 ID 的行，取其相邻列作 Secret
function parseCsv(p) {
  const raw = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
  for (const line of raw.split(/\r?\n/)) {
    const cols = line.split(",").map((c) => c.replace(/^"+|"+$/g, "").trim());
    const idx = cols.findIndex((c) => /^(LTAI|STS\.)/i.test(c));
    if (idx >= 0 && cols[idx + 1]) {
      return { accessKeyId: cols[idx], accessKeySecret: cols[idx + 1] };
    }
  }
  throw new Error(`CSV 中未找到 AccessKey（检查文件: ${p}）`);
}

const { accessKeyId, accessKeySecret } = parseCsv(csvPath);
log(`AccessKey ${mask(accessKeyId)}（来自 ${csvPath}）`);

// 2. 客户端（ACS3 签名由 SDK 完成）
const openapi = await import("@alicloud/openapi-core");
const mod = await import("@alicloud/modelstudio20260210");
// CJS 互操作：module.exports = { default: Client, ...models }，故类在 mod.default.default
const ClientClass =
  typeof mod.default === "function" ? mod.default
  : typeof mod.default?.default === "function" ? mod.default.default
  : typeof mod.Client === "function" ? mod.Client
  : null;
if (typeof ClientClass !== "function") {
  throw new Error("无法定位 ModelStudio Client 类");
}
const config = new openapi.$OpenApiUtil.Config({ accessKeyId, accessKeySecret });
config.endpoint = `modelstudio.${regionId}.aliyuncs.com`;
const client = new ClientClass(config);

// 3. 发现业务空间（dara SDK 需要传模型实例而非裸对象）
const wsResp = await client.listWorkspaces(new mod.ListWorkspacesRequest({ maxResults: 50 }));
const workspaces = wsResp.body?.workspaces || [];
if (!workspaces.length) {
  throw new Error("该账号名下没有业务空间。请先在百炼控制台创建，或确认 AK 归属正确。");
}
for (const w of workspaces) {
  log(`空间: ${w.workspaceId} | ${w.workspaceName || "(未命名)"} | region=${w.region || "?"}`);
}
const ws = preferWorkspace
  ? workspaces.find((w) => w.workspaceId === preferWorkspace)
  : workspaces[0];
if (!ws) throw new Error(`未找到指定空间 ${preferWorkspace}；可选: ${workspaces.map((w) => w.workspaceId).join(", ")}`);
log(`选定空间: ${ws.workspaceId} (${ws.workspaceName || "未命名"})`);

// 4. 获取 API Key：先复用，后创建
const keysResp = await client.listApiKeys(
  new mod.ListApiKeysRequest({ workspaceId: ws.workspaceId, maxResults: 50 }),
);
const keys = keysResp.body?.apiKeys || [];
const isPlainKey = (v) => typeof v === "string" && /^sk-[A-Za-z0-9]{16,}$/.test(v) && !v.includes("*");
const reusable = keys.find((k) => !k.disabled && isPlainKey(k.apiKeyValue));
let apiKey, keySource;
if (reusable) {
  apiKey = reusable.apiKeyValue;
  keySource = `复用已有 Key (id=${reusable.apiKeyId}, ${reusable.description || "无描述"})`;
} else {
  const created = await client.createApiKey(
    new mod.CreateApiKeyRequest({
      workspaceId: ws.workspaceId,
      allowAllModels: true,
      description: "decision-model-mcp",
    }),
  );
  const b = created.body || {};
  apiKey = b.apiKey?.apiKeyValue || b.apiKeyValue;
  keySource = "新建 Key";
  if (!apiKey) {
    throw new Error("CreateApiKey 未返回明文 Key，响应字段: " + Object.keys(b).join(", "));
  }
}
log(`API Key（${keySource}）: ${mask(apiKey)}`);

// 5. 明文凭据落盘（本地文件，勿提交）；stdout 只给打码摘要
const out = {
  workspace_id: ws.workspaceId,
  workspace_name: ws.workspaceName || null,
  region_id: regionId,
  api_key: apiKey,
  key_source: keySource,
  endpoint_base: `https://${ws.workspaceId}.${regionId === "cn-beijing" ? "cn-beijing" : regionId}.maas.aliyuncs.com/compatible-mode/v1/systemone`,
};
const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "credentials.local.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
log(`凭据已写入 ${outPath}`);

console.log(
  JSON.stringify({
    workspace_id: out.workspace_id,
    workspace_name: out.workspace_name,
    api_key_masked: mask(apiKey),
    key_source: keySource,
    credentials_file: outPath,
  }),
);
