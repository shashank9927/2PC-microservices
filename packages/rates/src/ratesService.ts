export interface PreparedQuote {
  transactionId: string;
  fromCurrency: string;
  toCurrency: string;
  fromAmountCents: number;
  toAmountCents: number;
  rate: number;
  state: "prepared" | "committed" | "rolled_back";
  preparedAt: Date;
}

export class RatesService {
  private readonly rates = new Map<string, number>();
  private readonly quotes = new Map<string, PreparedQuote>();

  constructor() {
    // Standard baseline rates
    this.rates.set("USD:EUR", 0.85);
    this.rates.set("EUR:USD", 1.18);
    this.rates.set("USD:GBP", 0.78);
    this.rates.set("GBP:USD", 1.28);
  }

  getRate(fromCurrency: string, toCurrency: string): number {
    const from = fromCurrency.toUpperCase();
    const to = toCurrency.toUpperCase();
    if (from === to) return 1.0;
    const pair = `${from}:${to}`;
    const rate = this.rates.get(pair);
    if (!rate) {
      throw new Error(`Exchange rate not configured for currency pair ${pair}`);
    }
    return rate;
  }

  setRate(fromCurrency: string, toCurrency: string, rate: number): void {
    if (rate <= 0 || !Number.isFinite(rate)) {
      throw new Error("Exchange rate must be a positive number");
    }
    this.rates.set(`${fromCurrency.toUpperCase()}:${toCurrency.toUpperCase()}`, rate);
  }

  getAllRates(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [pair, rate] of this.rates.entries()) {
      result[pair] = rate;
    }
    return result;
  }

  prepareQuote(
    transactionId: string,
    fromCurrency: string,
    toCurrency: string,
    fromAmountCents: number,
  ): { state: "prepared" | "already_prepared"; rate: number; toAmountCents: number } {
    const existing = this.quotes.get(transactionId);
    if (existing && existing.state === "prepared") {
      return {
        state: "already_prepared",
        rate: existing.rate,
        toAmountCents: existing.toAmountCents,
      };
    }

    const rate = this.getRate(fromCurrency, toCurrency);
    const toAmountCents = Math.round(fromAmountCents * rate);

    this.quotes.set(transactionId, {
      transactionId,
      fromCurrency: fromCurrency.toUpperCase(),
      toCurrency: toCurrency.toUpperCase(),
      fromAmountCents,
      toAmountCents,
      rate,
      state: "prepared",
      preparedAt: new Date(),
    });

    return {
      state: "prepared",
      rate,
      toAmountCents,
    };
  }

  resolveQuote(transactionId: string, decision: "COMMIT" | "ABORT"): "committed" | "rolled_back" | "not_found" {
    const quote = this.quotes.get(transactionId);
    if (!quote) return "not_found";

    if (decision === "COMMIT") {
      quote.state = "committed";
      return "committed";
    } else {
      this.quotes.delete(transactionId);
      return "rolled_back";
    }
  }

  getPreparedList(): Array<{ gid: string; prepared: Date; fromCurrency: string; toCurrency: string; rate: number; toAmountCents: number }> {
    const prepared: Array<{ gid: string; prepared: Date; fromCurrency: string; toCurrency: string; rate: number; toAmountCents: number }> = [];
    for (const quote of this.quotes.values()) {
      if (quote.state === "prepared") {
        prepared.push({
          gid: quote.transactionId,
          prepared: quote.preparedAt,
          fromCurrency: quote.fromCurrency,
          toCurrency: quote.toCurrency,
          rate: quote.rate,
          toAmountCents: quote.toAmountCents,
        });
      }
    }
    return prepared;
  }
}
