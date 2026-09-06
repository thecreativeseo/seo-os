import type { GenerateStructuredRequest } from "@/lib/ai/provider";
import type { ContentQaOutput } from "@/lib/ai/schemas/content-qa";
import { useStubProvider as installStubProvider } from "@/server/ai/registry";
import { briefAnswer } from "./qa-fixture";

/**
 * A judge that reads the task the way the real one is told to: the key
 * questions by their Q-lines, the rules by their ids, the conversion and the
 * keyword by whether the task states them. Everything it says is favorable
 * unless a test overrides part of it, so a test can show one judgment at a
 * time.
 */

export function questionsIn(task: string): string[] {
  return [...task.matchAll(/^- Q\d+: (.+)$/gm)].map((match) => match[1]!.trim());
}

export function ruleIdsIn(task: string): string[] {
  return [...task.matchAll(/\[rule:([^\]]+)\]/g)].map((match) => match[1]!);
}

export function qaAnswer(
  request: GenerateStructuredRequest<unknown>,
  overrides: Partial<ContentQaOutput> = {},
): ContentQaOutput {
  const task = request.task;
  const hasConversion = !/^Primary conversion: not stated$/m.test(task);
  const hasKeyword = !/^Primary keyword: not stated$/m.test(task);
  return {
    intent_alignment: {
      status: "ALIGNED",
      rationale: "The piece answers the buyer's question the brief names.",
      excerpts: [],
    },
    answer_readiness: questionsIn(task).map((question) => ({
      question,
      status: "ANSWERED",
      heading: null,
      form: "DIRECT",
      excerpt: null,
    })),
    rule_judgments: ruleIdsIn(task).map((rule_id) => ({
      rule_id: `rule:${rule_id}`,
      status: "RESPECTED",
      rationale: "The text reads as the rule asks.",
      excerpt: null,
    })),
    unlisted_claims: [],
    prohibited_paraphrases: [],
    call_to_action: hasConversion
      ? { status: "PRESENT", rationale: "The closing section asks for a demo.", excerpt: null }
      : null,
    keyword_use: hasKeyword
      ? {
          status: "NATURAL",
          rationale: "The keyword sits where a reader expects it.",
          excerpt: null,
        }
      : null,
    brand_voice: { status: "MATCHES", rationale: "Plain and specific.", excerpt: null },
    ...overrides,
  };
}

export type QaStubHandle = ReturnType<typeof installStubProvider> & {
  /** Every CONTENT_QA request the stub was shown. */
  qaRequests: GenerateStructuredRequest<unknown>[];
};

/**
 * Installs a stub that answers briefs and QA. `judge` may return a full
 * answer, or anything at all when a test wants the schema to refuse it.
 */
export function installQaStub(
  judge: (request: GenerateStructuredRequest<unknown>) => unknown = (request) => qaAnswer(request),
): QaStubHandle {
  const qaRequests: GenerateStructuredRequest<unknown>[] = [];
  const stub = installStubProvider({
    respond: (request) => {
      if (request.schemaName === "content_qa") {
        qaRequests.push(request);
        return judge(request);
      }
      return briefAnswer(request);
    },
  });
  return Object.assign(stub, { qaRequests });
}
