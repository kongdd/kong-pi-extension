/** 从助手消息拼接纯文本。 */
export function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== "assistant" || !Array.isArray(content)) return "";

  return content
    .filter((part): part is { type: "text"; text: string } => (
      !!part && typeof part === "object"
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
    ))
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** 规则摘短，供 TTS（非 LLM 总结）。 */
export function summarizeForSpeech(text: string, maxChars = 360): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~#]/g, "")
    .replace(/^\s*(?:[-+•]|\d+[.、])\s*/gm, "")
    .replace(/\r/g, "")
    .trim();
  if (!cleaned) return "";

  const summary = (cleaned.match(/[^。！？!?]+[。！？!?]?/g) ?? [cleaned])
    .slice(0, 3)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return summary.length <= maxChars ? summary : `${summary.slice(0, maxChars - 1)}…`;
}