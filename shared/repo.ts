/**
 * 仓库标识的单一来源。
 *
 * 在线安装、升级、版本检查与 GitHub 加速器都从这里派生地址；迁移仓库时只改这里。
 * 历史上这些地址散落在五个独立常量、三个 shell 脚本和一段生成代码里，
 * 漏改的表现是「装上了另一个仓库的版本」——不报错，只是修复看起来没生效。
 *
 * 注意：Go module 路径与插件商店元数据不由此处派生，见 .scratch/release-rebrand/spec.md。
 */
export const GITHUB_OWNER = "owo10086";
export const GITHUB_REPO = "sni-panel";
export const GITHUB_SLUG = `${GITHUB_OWNER}/${GITHUB_REPO}`;

/** 仓库主页，也是 release 与 issue 地址的前缀。 */
export const REPO_URL = `https://github.com/${GITHUB_SLUG}`;
/** release 列表页。 */
export const REPO_RELEASES_URL = `${REPO_URL}/releases`;
/** 默认分支上原始文件的前缀，安装脚本由此下载。 */
export const REPO_RAW_BASE_URL = `https://raw.githubusercontent.com/${GITHUB_SLUG}/main`;

/** 指定版本的 release 资产下载地址。 */
export function repoReleaseAssetUrl(version: string, asset: string) {
  const tag = String(version || "").trim().replace(/^v/, "");
  return `${REPO_URL}/releases/download/v${tag}/${asset}`;
}
