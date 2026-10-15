// Keep file-import retries consistent with the existing copy/import error boundary.
export function isRuleImportPortConflictError(reason: unknown) {
  const message = (reason instanceof Error ? reason.message : String(reason || ""));
  return /(?:端口.*(?:占用|冲突|正在被.*分配)|(?:源|入口|监听|套餐)端口.*(?:必须|仅限|不在|超出).*?(?:范围|区间|允许|内)|(?:source|entry|listener|plan) port.*?(?:range|allowed)|(?:port|entry agent port).*?(?:already (?:used|in use)|being allocated)|EADDRINUSE)/i.test(message);
}
