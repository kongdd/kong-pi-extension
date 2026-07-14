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
    .replace(/\r/g, "")
    .trim();
  if (!cleaned) return "";

  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
  const listRe = /^(?:[-+*•]|\d+[.、])\s*/;
  const heading = lines.find((l) => l.length <= 80 && !listRe.test(l));
  const bullets = lines.filter((l) => listRe.test(l)).map((l) => l.replace(listRe, ""));
  const prose = lines.filter((l) => !listRe.test(l)).join(" ");
  const sentences = prose.match(/[^。！？!?]+[。！？!?]?/g) ?? [prose];

  const parts: string[] = [];
  if (heading && heading !== sentences[0]) parts.push(heading);
  parts.push(...(bullets.length ? bullets.slice(0, 3) : sentences.slice(0, 3)));

  const summary = parts.join("。 ").replace(/\s+/g, " ").trim();
  return summary.length <= maxChars ? summary : `${summary.slice(0, maxChars - 1)}…`;
}