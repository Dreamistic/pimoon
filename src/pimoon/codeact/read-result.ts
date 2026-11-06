/** 仅识别文件工具完整原文结果；不从展示文本中猜测或剥离包装。 */
export function rawReadText(value: unknown): string | undefined {
 if (typeof value !== "object" || value === null || !("raw" in value) || value.raw !== true
  || !("truncated" in value) || value.truncated !== false || !("segments" in value)
  || !Array.isArray(value.segments) || value.segments.length !== 1) return undefined;
 const segment: unknown = value.segments[0];
 return typeof segment === "object" && segment !== null && "content" in segment && typeof segment.content === "string"
  ? segment.content : undefined;
}
