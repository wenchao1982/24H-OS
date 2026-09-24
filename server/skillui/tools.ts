import { mkdir } from "node:fs/promises";
import path from "node:path";
import pptxgen from "pptxgenjs";
import type { SkillRunToolResult } from "@shared/types";

/**
 * runTool 白名单工具实现。M4 提供 `ppt.export`：用纯 JS 的 pptxgenjs
 * 把前端传来的 deck 定义渲染成 .pptx 文件。
 */

/** 单张幻灯片定义（宽松，来自不可信前端，需规范化）。 */
export interface DeckSlide {
  title?: string;
  subtitle?: string;
  bullets?: string[];
}

/** 一份演示文稿定义。 */
export interface Deck {
  title?: string;
  themeColor?: string;
  slides: DeckSlide[];
}

/** 把 #RGB / #RRGGBB 规范化为 pptxgenjs 需要的 6 位十六进制（无 #）。 */
function normalizeHexColor(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw.trim().replace(/^#/, "").toUpperCase();
  return /^[0-9A-F]{6}$/.test(cleaned) ? cleaned : fallback;
}

/** 从不可信输入规范化出 Deck。 */
export function normalizeDeck(raw: unknown): Deck {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const title = typeof obj.title === "string" ? obj.title : undefined;
  const themeColor = normalizeHexColor(obj.themeColor, "4C8DFF");

  const slides: DeckSlide[] = Array.isArray(obj.slides)
    ? obj.slides.map((item) => {
        const s =
          item && typeof item === "object" && !Array.isArray(item)
            ? (item as Record<string, unknown>)
            : {};
        return {
          title: typeof s.title === "string" ? s.title : undefined,
          subtitle: typeof s.subtitle === "string" ? s.subtitle : undefined,
          bullets: Array.isArray(s.bullets)
            ? s.bullets.filter((b): b is string => typeof b === "string")
            : undefined,
        };
      })
    : [];

  return { title, themeColor, slides };
}

/** 渲染一份 deck 到指定 .pptx 路径，返回结果描述。 */
export async function exportPptx(
  rawDeck: unknown,
  outputPath: string,
): Promise<SkillRunToolResult> {
  const deck = normalizeDeck(rawDeck);
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_16x9";

  const slides = deck.slides.length > 0 ? deck.slides : [{ title: deck.title }];

  slides.forEach((item, index) => {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };

    // 顶部主题色装饰条。
    slide.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: "100%",
      h: 0.18,
      fill: { color: deck.themeColor ?? "4C8DFF" },
    });

    const isTitleSlide = index === 0;
    const title = item.title ?? (isTitleSlide ? (deck.title ?? "") : "");
    if (title) {
      slide.addText(title, {
        x: 0.6,
        y: isTitleSlide ? 1.8 : 0.6,
        w: 8.8,
        h: 1.2,
        fontSize: isTitleSlide ? 34 : 28,
        bold: true,
        color: "1F2933",
        align: "left",
        valign: "middle",
      });
    }

    if (item.subtitle) {
      slide.addText(item.subtitle, {
        x: 0.6,
        y: isTitleSlide ? 3.0 : 1.6,
        w: 8.8,
        h: 0.8,
        fontSize: 16,
        color: "52606D",
        align: "left",
      });
    }

    const bullets = (item.bullets ?? []).filter((b) => b.trim().length > 0);
    if (bullets.length > 0) {
      slide.addText(
        bullets.map((text) => ({ text, options: { bullet: true } })),
        {
          x: 0.8,
          y: isTitleSlide && !item.subtitle ? 3.0 : 2.2,
          w: 8.4,
          h: 3.2,
          fontSize: 18,
          color: "323F4B",
          align: "left",
          valign: "top",
          lineSpacingMultiple: 1.3,
        },
      );
    }
  });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await pptx.writeFile({ fileName: outputPath });
  return { tool: "ppt.export", path: outputPath, slides: slides.length };
}
