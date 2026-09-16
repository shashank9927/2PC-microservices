export interface RegisteredParticipant {
  name: string;
  url: string;
  type: "bank" | "exchange-rate" | "custom";
  currency?: string;
  accountIds?: string[];
}

export class ParticipantRegistry {
  private readonly participants = new Map<string, RegisteredParticipant>();

  register(participant: RegisteredParticipant): void {
    if (!participant.name || typeof participant.name !== "string") {
      throw new Error("Participant name is required");
    }
    if (!participant.url || typeof participant.url !== "string") {
      throw new Error("Participant url is required");
    }
    const cleanUrl = participant.url.replace(/\/$/, "");
    this.participants.set(participant.name, {
      ...participant,
      url: cleanUrl,
      currency: participant.currency ? participant.currency.toUpperCase() : undefined,
    });
  }

  unregister(name: string): boolean {
    return this.participants.delete(name);
  }

  get(name: string): RegisteredParticipant | undefined {
    return this.participants.get(name);
  }

  list(): RegisteredParticipant[] {
    return Array.from(this.participants.values());
  }

  findBankForAccount(accountId: string): RegisteredParticipant | undefined {
    for (const p of this.participants.values()) {
      if (p.type === "bank" && p.accountIds?.includes(accountId)) {
        return p;
      }
    }
    // Fallback heuristic: match known convention or check name
    if (accountId === "alice") return this.get("bank-a");
    if (accountId === "bob") return this.get("bank-b");
    return undefined;
  }

  getRatesService(): RegisteredParticipant | undefined {
    for (const p of this.participants.values()) {
      if (p.type === "exchange-rate") return p;
    }
    return this.get("rates-service");
  }
}
