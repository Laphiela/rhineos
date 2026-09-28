import content from "../content/archives.json" with { type: "json" };

export interface ArchiveRecord {
  id: string;
  title: string;
  en: string;
  department: string;
  category: string;
  date: string;
  lead: string;
  clearance: string;
  abstract: string;
  findings: string[];
  source: string;
}

export const records: ArchiveRecord[] = content.records;
export const categories = ["全部档案", ...content.categories];
export const archiveColumns = content.columns;

/** RhineOS:运行时整体替换档案数据集(档案终端 ↔ 真实文件系统耦合)。
 * 就地变更 records/columns/categories,所有持有引用的消费者(3D 场景、选择器、
 * 检索过滤)自动看到新数据;须在 3D 场景首次构建前调用。 */
export function setDataset(next: ArchiveRecord[], columns?: string[]) {
  records.splice(0, records.length, ...next);
  if (columns && columns.length) archiveColumns.splice(0, archiveColumns.length, ...columns);
  const cats = ["全部档案", ...new Set((columns && columns.length ? columns : archiveColumns))];
  categories.splice(0, categories.length, ...cats);
}

export function columnFiles(lane: number) {
  return records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.category === archiveColumns[lane])
    .map(({ index }) => index);
}
export function fileLocation(index: number) {
  const lane = archiveColumns.indexOf(records[index].category);
  const row = 12 + columnFiles(lane).indexOf(index);
  return { lane, row, slot: lane * 32 + row };
}
export function fileAtSlot(slot: number) {
  const files = columnFiles(Math.floor(slot / 32));
  return files[Math.max(0, Math.min(files.length - 1, (slot % 32) - 12))];
}
