// Baseline report (P0 task 3) — PURE DATA JOIN over the label ledger. Zero LLM
// calls, deterministic, runs in seconds.
//
// WHY NO LLM: reproducing the historical precision numbers means pairing each
// past action with the decision the human actually made. Re-running the pipeline
// live would produce BRAND NEW cards that have no labels at all, so it cannot
// compute precision against history — and 1,111 rounds of real inference is not
// affordable. Live-inference evaluation is Gate B (P2), on ~30 gold threads.
//
// TWO RULES THAT ARE NOT NEGOTIABLE:
//   1. NEVER report a single blended "accuracy". reply=0.168 and ignore=0.844
//      averaged together is worse than no number: it hides the thing that is
//      broken. Everything below is per action_type.
//   2. `deferred` is excluded from the precision denominator. "Right card, wrong
//      day" is not a false positive; counting it as one understates precision.

import type { LabelRecord } from "../io/labels.js";
import { NON_PRECISION_VERDICTS } from "../io/labels.js";

// Below this the cell is noise — a 10-point swing is inside the error bar.
export const SMALL_N = 10;

// What `executed` MEANS differs per type, so the same 0.84 means different
// things. Printed alongside every row: without it, ignore=0.844 reads as
// "ignore is accurate" when it actually means "the human agreed to ignore".
export const PRECISION_SEMANTICS: Record<string, string> = {
  reply: "人采纳了草稿(最严格)",
  relay: "人采纳了转述草稿",
  forward: "人采纳了转发",
  calendar: "人接受了事件(时间/地点/参会人可用)",
  task: "人点了完成 —— 可能是真做了,也可能只是划掉",
  ignore: "人同意忽略 —— 是「一致率」,不是「有用度」",
};

export interface TypeStats {
  action_type: string;
  executed: number;
  rejected: number;
  deferred: number; // excluded from precision
  decided: number; // executed + rejected (deferred removed)
  precision: number | null;
  small_n: boolean;
  semantics: string;
}

export interface ConfidenceCell {
  bucket: number; // rounded to 0.1
  executed: number;
  rejected: number;
  n: number;
  approveRate: number | null;
  small_n: boolean;
}

export interface BaselineReport {
  generated_at: string;
  label_count: number;
  // Only decisions a human actually made. superseded/pruned are lifecycle
  // events, not judgements — counting them as rejections would be a lie.
  human_decided: number;
  lifecycle_only: number;
  by_type: TypeStats[];
  // Rounded to 0.1 — readable, but it CONFLATES values the model treats very
  // differently (see exact_confidence_by_type).
  confidence_by_type: Record<string, ConfidenceCell[]>;
  // The model emits DISCRETE confidence values (0.72, 0.82, 0.9…), and they are
  // not interchangeable: for `task`, conf=0.9 approves at 0.96 (n=27) while
  // conf=0.85 approves at 0.33 (n=6). Rounding both into a "0.9 bucket" reports
  // 0.85 and would justify a ≥0.85 gate that is measurably wrong. Any threshold
  // decision must be read off THIS table, not the rounded one.
  exact_confidence_by_type: Record<string, ConfidenceCell[]>;
  decided_at_coverage: { with: number; without: number };
  existence_coverage: { with: number; without: number };
}

const HUMAN_DECISIONS: ReadonlySet<string> = new Set(["executed", "rejected"]);

function bucketOf(conf: unknown): number | null {
  if (typeof conf !== "number" || Number.isNaN(conf)) return null;
  return Math.round(conf * 10) / 10;
}

export function buildBaseline(labels: LabelRecord[], generatedAt: string): BaselineReport {
  const human = labels.filter((r) => HUMAN_DECISIONS.has(r.decision));

  const types = new Map<string, TypeStats>();
  const confidence = new Map<string, Map<number, ConfidenceCell>>();
  const exact = new Map<string, Map<number, ConfidenceCell>>();

  for (const r of human) {
    const t = r.action_type;
    const stats =
      types.get(t) ??
      {
        action_type: t,
        executed: 0,
        rejected: 0,
        deferred: 0,
        decided: 0,
        precision: null,
        small_n: false,
        semantics: PRECISION_SEMANTICS[t] ?? "(未定义语义)",
      };

    // A deferral is a real card the human postponed — it must not count against
    // precision. Historical records have existence=null, so they fall through to
    // the normal executed/rejected tally (the original 0.168/0.444 口径).
    const isDeferral = r.existence != null && NON_PRECISION_VERDICTS.has(r.existence);
    if (isDeferral) {
      stats.deferred++;
    } else if (r.decision === "executed") {
      stats.executed++;
    } else {
      stats.rejected++;
    }
    types.set(t, stats);

    if (!isDeferral) {
      const raw = r.source_snapshot?.confidence;
      const tally = (store: Map<string, Map<number, ConfidenceCell>>, b: number): void => {
        const perType = store.get(t) ?? new Map<number, ConfidenceCell>();
        const cell =
          perType.get(b) ??
          { bucket: b, executed: 0, rejected: 0, n: 0, approveRate: null, small_n: false };
        if (r.decision === "executed") cell.executed++;
        else cell.rejected++;
        perType.set(b, cell);
        store.set(t, perType);
      };
      const b = bucketOf(raw);
      if (b !== null) tally(confidence, b);
      if (typeof raw === "number" && !Number.isNaN(raw)) tally(exact, raw);
    }
  }

  const by_type = [...types.values()]
    .map((s) => {
      s.decided = s.executed + s.rejected;
      s.precision = s.decided > 0 ? s.executed / s.decided : null;
      s.small_n = s.decided < SMALL_N;
      return s;
    })
    .sort((a, b) => b.decided - a.decided);

  const finalize = (src: Map<string, Map<number, ConfidenceCell>>): Record<string, ConfidenceCell[]> => {
    const out: Record<string, ConfidenceCell[]> = {};
    for (const [t, cells] of src) {
      out[t] = [...cells.values()]
        .map((c) => {
          c.n = c.executed + c.rejected;
          c.approveRate = c.n > 0 ? c.executed / c.n : null;
          c.small_n = c.n < SMALL_N;
          return c;
        })
        .sort((a, b) => a.bucket - b.bucket);
    }
    return out;
  };
  const confidence_by_type = finalize(confidence);
  const exact_confidence_by_type = finalize(exact);

  return {
    generated_at: generatedAt,
    label_count: labels.length,
    human_decided: human.length,
    lifecycle_only: labels.length - human.length,
    by_type,
    confidence_by_type,
    exact_confidence_by_type,
    decided_at_coverage: {
      with: labels.filter((r) => r.decided_at != null).length,
      without: labels.filter((r) => r.decided_at == null).length,
    },
    existence_coverage: {
      with: labels.filter((r) => r.existence != null).length,
      without: labels.filter((r) => r.existence == null).length,
    },
  };
}

const pct = (v: number | null): string => (v == null ? "n/a" : v.toFixed(3));

export function renderBaselineMarkdown(rep: BaselineReport): string {
  const L: string[] = [];
  L.push(`# 准确率基线 — ${rep.generated_at.slice(0, 10)}`);
  L.push("");
  L.push("> 纯数据 join,零 LLM 调用。**从不报单一「准确率」总数**——把 reply 的 0.168 和");
  L.push("> ignore 的 0.844 平均掉,比没有数字更糟。`deferred`(现在不做)不计入分母。");
  L.push("");
  L.push(`- 标签总数:**${rep.label_count}**(人工决策 ${rep.human_decided},生命周期事件 ${rep.lifecycle_only})`);
  L.push(`- \`decided_at\` 覆盖:**${rep.decided_at_coverage.with}** 有 / ${rep.decided_at_coverage.without} 无`);
  L.push(`- \`existence\`(拒绝原因)覆盖:**${rep.existence_coverage.with}** 有 / ${rep.existence_coverage.without} 无`);
  L.push("");
  L.push("## 分类型精度");
  L.push("");
  L.push("| 类型 | executed | rejected | deferred | 已决策 | 精度 | executed 的语义 |");
  L.push("|---|---|---|---|---|---|---|");
  for (const s of rep.by_type) {
    const flag = s.small_n ? " ⚠️n 过小,仅供参考" : "";
    L.push(
      `| \`${s.action_type}\` | ${s.executed} | ${s.rejected} | ${s.deferred} | ${s.decided} | ` +
        `**${pct(s.precision)}**${flag} | ${s.semantics} |`,
    );
  }
  L.push("");
  L.push("## 置信度校准(分类型)");
  L.push("");
  L.push("> 现有 `confidence` **不能跨类型**当阈值用:它在 task 上有序,在 reply 上无效甚至反向。");
  L.push("");
  for (const [t, cells] of Object.entries(rep.confidence_by_type)) {
    L.push(`### \`${t}\`(四舍五入到 0.1)`);
    L.push("");
    L.push("| 置信度桶 | executed | rejected | n | 通过率 |");
    L.push("|---|---|---|---|---|");
    for (const c of cells) {
      const flag = c.small_n ? " ⚠️n 过小" : "";
      L.push(`| ${c.bucket.toFixed(1)} | ${c.executed} | ${c.rejected} | ${c.n} | ${pct(c.approveRate)}${flag} |`);
    }
    L.push("");
  }
  L.push("## 精确置信度值(定阈值必须看这张表)");
  L.push("");
  L.push("> 模型输出的是**离散值**,彼此不可互换。例如 `task`:`conf=0.9` 通过率 0.96,");
  L.push("> 而 `conf=0.85` 只有 0.33 —— 四舍五入把两者混成「0.9 桶 = 0.85」,");
  L.push("> 会论证出一个**可被实测否决**的 ≥0.85 门槛。任何阈值决策都读这张表。");
  L.push("");
  for (const [t, cells] of Object.entries(rep.exact_confidence_by_type)) {
    L.push(`### \`${t}\`(精确值)`);
    L.push("");
    L.push("| conf | executed | rejected | n | 通过率 |");
    L.push("|---|---|---|---|---|");
    for (const c of cells) {
      const flag = c.small_n ? " ⚠️n 过小" : "";
      L.push(`| ${c.bucket} | ${c.executed} | ${c.rejected} | ${c.n} | ${pct(c.approveRate)}${flag} |`);
    }
    L.push("");
  }
  return L.join("\n");
}
