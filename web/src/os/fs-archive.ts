// RhineOS 档案终端 ↔ 真实文件系统耦合提供器。
// 把 HOME 顶层条目映射为档案终端的 3D 档案:目录/文档/图片/代码/其他 五列,
// 记录字段全部来自真实 stat 元数据,使三维档案终端成为本系统的文件系统视图。
// 总量与原版一致(≤12 条)以保证 SwiftShader 软渲染下的 3D 场景负载不变。
import { setDataset, type ArchiveRecord } from "../data";
import { api } from "./api";
import { osEnabled, osHostInfo } from "./desktop";

// api 客户端的 fs 命名空间在 DesktopApi 类型之外,这里从 api 对象上解构
const fsList = (path: string) => (api as unknown as { list: (p: string) => Promise<{ path: string; items: FsEntry[] }> }).list(path);

const FS_COLUMNS = ["目录", "文档", "图片", "代码", "其他"];
const MAX_RECORDS = 12;
const MAX_TITLE = 12;

const DOC = /\.(md|txt|pdf|docx?|xlsx?|pptx?|csv|json|log|ini|conf|cfg)$/i;
const IMG = /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?|avif)$/i;
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|cpp|h|hpp|sh|bash|css|scss|html|vue|svelte|sql|yml|yaml|toml|lua|rb|php)$/i;

type FsEntry = { name: string; type: string; size: number; mtime: number };

function bucketOf(name: string, type: string): number {
  if (type === "dir") return 0;
  if (DOC.test(name)) return 1;
  if (IMG.test(name)) return 2;
  if (CODE.test(name)) return 3;
  return 4;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function leadOf(entry: FsEntry): string {
  if (entry.type === "dir") return "DIRECTORY";
  if (entry.type === "link") return "SYMLINK";
  if (DOC.test(entry.name)) return "DOCUMENT";
  if (IMG.test(entry.name)) return "IMAGE ASSET";
  if (CODE.test(entry.name)) return "SOURCE CODE";
  return "DATA FILE";
}

function truncateTitle(name: string): string {
  const base = name.replace(/\.[^.]+$/, "") || name;
  return base.length <= MAX_TITLE ? base : base.slice(0, MAX_TITLE - 1) + "…";
}

/** 拉取 HOME 顶层条目并整体替换档案数据集;失败时保持原版虚构档案。 */
export async function applyFsDataset(): Promise<boolean> {
  if (!osEnabled()) return false;
  const home = osHostInfo()?.home;
  if (!home) return false;
  try {
    const list = await fsList(home);
    const entries = [...list.items]
      .sort((a, b) => {
        const d = (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1);
        return d !== 0 ? d : b.mtime - a.mtime;
      })
      .slice(0, MAX_RECORDS);
    if (!entries.length) return false;
    if (entries.length < FS_COLUMNS.length) return false; // 列多于条目,无法保证每列非空,放弃耦合

    // 场景按「5 列 × 固定槽位」构建,空列会取到 undefined 而崩;
    // 分桶后必须保证每列 ≥1 条:从最多的列调配给空列。
    const buckets: FsEntry[][] = FS_COLUMNS.map(() => []);
    for (const entry of entries) buckets[bucketOf(entry.name, entry.type)].push(entry);
    for (let c = 0; c < FS_COLUMNS.length; c++) {
      if (buckets[c].length) continue;
      let richest = 0;
      for (let i = 1; i < buckets.length; i++) if (buckets[i].length > buckets[richest].length) richest = i;
      if (buckets[richest].length < 2) return false; // 无可调配,放弃耦合
      const moved = buckets[richest].pop()!;
      buckets[c].push(moved);
    }
    const ordered: FsEntry[] = buckets.flat();

    const recs: ArchiveRecord[] = ordered.map((entry, i) => {
      const path = `${list.path.replace(/\/$/, "")}/${entry.name}`;
      const bucket = FS_COLUMNS[bucketOf(entry.name, entry.type)];
      const mtimeText = new Date(entry.mtime).toLocaleString("zh-CN", { hour12: false });
      const findings = [
        `FULL PATH:${path}`,
        `KIND:${entry.type === "dir" ? "目录" : entry.type === "link" ? "符号链接" : "常规文件"}`,
        `SIZE:${entry.type === "dir" ? "—" : formatBytes(entry.size)}`,
        `MTIME:${mtimeText}`,
        `访问途径:桌面「文件」应用 / 终端`,
      ];
      return {
        id: `FS-${String(i + 1).padStart(3, "0")}`,
        title: truncateTitle(entry.name),
        en: entry.name.toUpperCase().slice(0, 32),
        department: "HOME",
        category: bucket,
        date: new Date(entry.mtime).toISOString().slice(0, 10),
        lead: leadOf(entry),
        clearance: "REAL FILESYSTEM",
        abstract: `${leadOf(entry)} · ${entry.type === "dir" ? "内容见「文件」应用" : formatBytes(entry.size)} · 修改于 ${mtimeText}`,
        findings,
        source: path,
      };
    });
    setDataset(recs, FS_COLUMNS);
    console.info(`[rhineos] 档案终端已耦合真实文件系统:${recs.length} 条(根:${list.path})`);
    return true;
  } catch (error) {
    console.warn("[rhineos] 文件系统档案耦合失败,保留原版数据集:", (error as Error)?.message ?? error);
    return false;
  }
}
