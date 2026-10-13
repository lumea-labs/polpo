import { WhatsAppAdapter } from "@chat-adapter/whatsapp";
import type { ChannelSuggestionChoice } from "./types.js";

/** Narrow extension of the pinned official transport, which only renders 3 card buttons. */
export class SuggestionWhatsAppAdapter extends WhatsAppAdapter {
  async postSuggestionChoices(threadId: string, choices: readonly ChannelSuggestionChoice[]) {
    if (choices.length < 1 || choices.length > 10
      || choices.some(choice => !choice.id || choice.id.length > 200 || !choice.label.trim())
      || new Set(choices.map(choice => choice.id)).size !== choices.length) {
      throw new Error("WhatsApp suggestions require 1–10 distinct bounded choices");
    }
    const titles = distinctChoiceTitles(choices.map(choice => choice.label), choices.length <= 3 ? 20 : 24);
    const rows = choices.map((choice, index) => ({ id: choice.id, title: titles[index]! }));
    const { userWaId } = this.decodeThreadId(threadId);
    return this.sendInteractiveMessage(threadId, userWaId, choices.length <= 3 ? {
      type: "button", body: { text: "Suggested next steps" },
      action: { buttons: rows.map(reply => ({ type: "reply", reply })) },
    } : {
      type: "list", body: { text: "Suggested next steps" },
      action: { button: "Choose a next step", sections: [{ title: "Suggestions", rows }] },
    });
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Count provider characters while retaining whole graphemes, including emoji sequences. */
function boundedTitle(value: string, limit: number): string {
  let result = "";
  let used = 0;
  for (const { segment } of graphemes.segment(value)) {
    const count = [...segment].length;
    if (used + count > limit) break;
    result += segment;
    used += count;
  }
  return result;
}

/** Numbered suffixes disambiguate identical/truncated labels without splitting Unicode. */
function distinctChoiceTitles(labels: readonly string[], limit: number): string[] {
  const trimmed = labels.map(label => boundedTitle(label.trim().replace(/\s+/g, " "), limit) || "Next step");
  if (new Set(trimmed).size === trimmed.length) return trimmed;
  return trimmed.map((title, index) => {
    const suffix = ` (${index + 1})`;
    return boundedTitle(title, limit - suffix.length) + suffix;
  });
}
