import { randomUUID } from "node:crypto";

export interface ChaosRule {
  id: string;
  target: string; // e.g. "bank-b", "rates-service", "*"
  path?: string; // e.g. "/prepare", "/commit", "/rollback", "*"
  action: "drop" | "delay" | "partition" | "error";
  delayMs?: number;
  times?: number; // number of times to trigger before expiring
  hits: number;
}

export class ChaosMonkey {
  private rules = new Map<string, ChaosRule>();

  addRule(params: Omit<ChaosRule, "id" | "hits"> & { id?: string }): ChaosRule {
    const id = params.id ?? randomUUID();
    const rule: ChaosRule = {
      id,
      target: params.target,
      path: params.path,
      action: params.action,
      delayMs: params.delayMs,
      times: params.times ?? 1,
      hits: 0,
    };
    this.rules.set(id, rule);
    return rule;
  }

  removeRule(id: string): boolean {
    return this.rules.delete(id);
  }

  clear(): void {
    this.rules.clear();
  }

  getRules(): ChaosRule[] {
    return Array.from(this.rules.values());
  }

  async intercept(target: string, path: string, signal?: AbortSignal): Promise<void> {
    for (const rule of this.rules.values()) {
      if (rule.times !== undefined && rule.hits >= rule.times) {
        continue;
      }

      const targetMatches = rule.target === "*" || rule.target === target;
      const pathMatches = !rule.path || rule.path === "*" || rule.path === path;

      if (targetMatches && pathMatches) {
        rule.hits += 1;

        if (rule.delayMs && rule.delayMs > 0) {
          if (signal?.aborted) {
            throw signal.reason ?? new Error("Aborted");
          }
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => resolve(), rule.delayMs);
            if (signal) {
              signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  reject(signal.reason ?? new Error("The operation was aborted due to timeout"));
                },
                { once: true },
              );
            }
          });
        }

        if (rule.action === "drop") {
          throw new Error(`[chaos-monkey] Injected packet drop for ${target} on ${path}`);
        }

        if (rule.action === "partition") {
          throw new Error(`[chaos-monkey] Network partition: destination ${target} unreachable`);
        }

        if (rule.action === "error") {
          throw new Error(`[chaos-monkey] Injected network error on ${target}${path}`);
        }
      }
    }
  }
}

export const globalChaosMonkey = new ChaosMonkey();
